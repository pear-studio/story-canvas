import { assertDepthDependencies } from "./two-step-runtime.mjs";
import { diagnoseRenderProfile, diagnoseResolvedLoras } from "./render-profile-diagnostics.mjs";
import { inspectRenderProfile } from "./render-profile-inspection.mjs";
import { compilePageRenderInspectionContext } from "./page-render-resolver.mjs";
import { promptSignature } from "./render-task-storage.mjs";
import { storyPromptCategories } from "./story-files.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { loadPromptDictionaryForRender } from "./prompt-dictionary-loader.mjs";
import { compileCurrentPagePrompt, structuredPromptBase } from "./current-page-prompt.mjs";
import { generationDetailsProjection } from "./generation-details.mjs";

function issue(code, message, source = null, details = []) {
  return {
    code,
    message,
    ...(source ? { source } : {}),
    ...(details.length ? { details: structuredClone(details) } : {}),
  };
}

function uniqueIssues(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify([item.code, item.source, item.message, item.path, item.prompt_text, item.conflicts_with, item.related, item.details]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function profileDiagnosticIssues(inspection) {
  if (!inspection) return { blockers: [], warnings: [] };
  const diagnostics = [
    ...(inspection.base_profile?.diagnostics ?? []),
    ...Object.values(inspection.models ?? {}).flatMap((model) => model.diagnostics ?? []),
    ...Object.values(inspection.style_loras ?? {}).flatMap((lora) => lora.diagnostics ?? []),
    ...(inspection.routes ?? []).flatMap((route) => route.diagnostics ?? []),
  ];
  return {
    blockers: diagnostics.filter((item) => item.severity !== "warning")
      .map((item) => issue(item.code, item.message, item.source)),
    warnings: diagnostics.filter((item) => item.severity === "warning")
      .map((item) => issue(item.code, item.message, item.source)),
  };
}

async function diagnoseProfileContext(context, repositoryRoot, config) {
  if (!context.active_profile || !context.compiled_profile) {
    return { diagnosis: null, inspection: null, blockers: [], warnings: [] };
  }
  const diagnosis = await diagnoseRenderProfile(context.snapshot.page_prompt.mode === "free" && !context.snapshot.page_prompt.two_step?.enabled ? { ...context.active_profile, style_loras: {} } : context.active_profile, repositoryRoot, config);
  const baseBundle = context.compiled_profile.base_bundle ?? context.compiled_profile;
  const activeSha = context.compiled_profile.blocked
    ? baseBundle.resolved_profile_sha256
    : context.compiled_profile.effective_profile_sha256;
  const baseDiagnosis = activeSha === baseBundle.resolved_profile_sha256
    ? diagnosis
    : await diagnoseRenderProfile(baseBundle.resolved_profile, repositoryRoot, config);
  const inspection = inspectRenderProfile({
    bundle: context.compiled_profile,
    diagnosis,
    baseDiagnosis,
  });
  return { diagnosis, inspection, ...profileDiagnosticIssues(inspection) };
}

function loraBlockers(loras) {
  return (loras ?? [])
    .filter((lora) => lora.status !== "available")
    .map((lora) => issue(
      "page_lora_unavailable",
      `${lora.filename || "LoRA"} 不可用：${lora.reason ?? "unknown"}`,
      lora.path ?? null,
    ));
}

function characterProjection(context, loras) {
  const diagnosedByOwnerFilename = new Map(
    loras.filter((lora) => lora.kind === "character").map((lora) => [`${lora.owner}\0${lora.filename}`, lora]),
  );
  const characterById = new Map((context.snapshot.characters ?? []).map((character) => [character.id, character]));
  return context.snapshot.character_references.map((reference) => {
    const facts = context.snapshot.character_facts[reference.character_id];
    const character = characterById.get(reference.character_id);
    return {
      character_id: reference.character_id,
      name: facts?.profile?.name ?? reference.character_id,
      variant_id: reference.variant_id,
      configuration_id: reference.variant_id,
      loras: (character?.loras ?? []).map((lora) => ({
        ...structuredClone(lora),
        diagnosis: structuredClone(diagnosedByOwnerFilename.get(`${reference.character_id}\0${lora.filename}`) ?? null),
      })),
    };
  });
}

export async function inspectPageRender({
  repositoryRoot,
  projectDirectory,
  pageKey,
  pagePromptDraft = undefined,
  dictionaryEntries = null,
  dictionaryError = null,
  config = {},
}) {
  if (dictionaryEntries === null && !dictionaryError) {
    try { dictionaryEntries = (await loadPromptDictionaryForRender(config, repositoryRoot)).entries; }
    catch (error) { dictionaryError = error.message; }
  }
  const context = await compilePageRenderInspectionContext({
    repositoryRoot,
    projectDirectory,
    pageKey,
    pagePromptDraft,
    dictionaryEntries,
    dictionaryError,
  });
  let profile;
  try {
    profile = await diagnoseProfileContext(context, repositoryRoot, config);
  } catch (error) {
    profile = {
      diagnosis: null,
      inspection: null,
      blockers: [issue("render_profile_diagnosis_failed", error?.message ?? String(error), "render_profile")],
      warnings: [],
    };
  }
  const resolvedLoras = context.compiled_page?.loras ?? [];
  let diagnosedLoras;
  try {
    diagnosedLoras = await diagnoseResolvedLoras(resolvedLoras, repositoryRoot, config);
  } catch (error) {
    diagnosedLoras = resolvedLoras.map((lora, index) => ({
      ...structuredClone(lora),
      path: `loras[${index}]`,
      status: "invalid",
      reason: "diagnosis_failed",
      errors: [error?.message ?? String(error)],
    }));
  }
  const depthBlockers = [];
  if (context.compiled_page?.two_step && context.compiled_page.two_step_supported) {
    try { await assertDepthDependencies(context.compiled_page.two_step, repositoryRoot, config); }
    catch (error) { depthBlockers.push(issue("two_step_dependencies_unavailable", error.message, "two_step")); }
  }
  const auditWarnings = context.audit.warnings ?? [];
  const blockers = uniqueIssues([
    ...context.blockers,
    ...depthBlockers,
    ...profile.blockers.filter(item => context.snapshot.page_prompt.mode !== "free" || context.snapshot.page_prompt.two_step?.enabled || !String(item.source ?? "").includes("style_loras")),
    ...loraBlockers(diagnosedLoras),
  ]);
  const warnings = uniqueIssues([...profile.warnings, ...auditWarnings]);
  const compiled = context.compiled_page;
  const finalParts = [...(compiled?.prompt_parts?.positive ?? []), ...(compiled?.prompt_parts?.negative ?? [])];
  const categoryParts = Object.fromEntries(storyPromptCategories.map((category) => [
    category,
    structuredClone(finalParts.filter((part) => part.category === category)),
  ]));
  const profileIdentity = context.active_profile ? {
    id: context.active_profile.id,
    name: context.active_profile.name,
    architecture_family: context.active_profile.architecture_family,
    prompt_family: context.active_profile.prompt.family,
    base_sha256: context.compiled_profile?.base_bundle?.resolved_profile_sha256
      ?? context.compiled_profile?.resolved_profile_sha256
      ?? null,
    effective_sha256: context.compiled_profile?.blocked
      ? null
      : context.compiled_profile?.effective_profile_sha256
        ?? context.compiled_profile?.resolved_profile_sha256
        ?? null,
  } : null;

  let structuredImport = null;
  try {
    const structured = compileCurrentPagePrompt({ pageId: context.snapshot.page_id, pageKey: context.snapshot.page_key,
      pagePrompt: { ...context.snapshot.page_prompt, mode: "structured" }, profile: context.active_profile,
      characters: context.snapshot.characters, scenes: context.snapshot.scenes ?? [], participantIds: context.snapshot.character_references.map(ref => ref.character_id), dictionaryEntries });
    structuredImport = structuredPromptBase(structured, context.active_profile, context.snapshot.characters, context.snapshot.scenes ?? []);
  } catch { /* 当前结构化配置不完整时仍可自由编辑。 */ }
  return {
    structured_import: structuredImport,
    two_step_supported: compiled?.two_step_supported ?? false,
    draft_base: compiled?.draft_base ?? null,
    version: 1,
    page_key: structuredClone(context.snapshot.page_key),
    title: context.snapshot.title,
    ...(context.snapshot.kind === "story"
      ? { scene_description: context.snapshot.scene_description }
      : { visual_goal: context.snapshot.visual_goal }),
    canvas: context.project.canvas ?? null,
    ready: blockers.length === 0,
    prompt: {
      positive: compiled?.positive_prompt ?? "",
      negative: compiled?.negative_prompt ?? "",
      signature: compiled ? promptSignature({ positive_prompt: compiled.positive_prompt ?? "", negative_prompt: compiled.negative_prompt ?? "" }) : null,
      separator: compiled?.prompt_parts?.separator ?? ", ",
      parts: {
        positive: structuredClone(compiled?.prompt_parts?.positive ?? []),
        negative: structuredClone(compiled?.prompt_parts?.negative ?? []),
        by_category: categoryParts,
      },
    },
    characters: characterProjection(context, diagnosedLoras),
    loras: diagnosedLoras,
    render: {
      profile: profileIdentity,
      profile_inspection: profile.inspection,
      route: structuredClone(context.candidate_route),
      recipe: context.candidate_recipe && context.candidate_route ? {
        source_id: context.candidate_route.recipe_source_id,
        instance_id: context.candidate_route.recipe_instance_id,
        sha256: hashCanonicalJson(context.candidate_recipe),
        parameters: structuredClone(context.candidate_recipe),
      } : null,
      workflow: structuredClone(context.candidate_workflow),
    },
    generation: generationDetailsProjection({
      profile: context.active_profile,
      recipe: context.candidate_recipe,
      prompt: {
        positive: compiled?.positive_prompt ?? "",
        negative: compiled?.negative_prompt ?? "",
      },
      promptParts: compiled?.prompt_parts,
      canvas: context.project.canvas ?? null,
      loras: diagnosedLoras,
    }),
    audit: structuredClone(context.audit),
    blockers,
    warnings,
  };
}
