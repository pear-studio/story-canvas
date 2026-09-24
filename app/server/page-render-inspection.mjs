import { diagnoseRenderProfile, diagnoseResolvedLoras } from "./render-profile-diagnostics.mjs";
import { inspectRenderProfile } from "./render-profile-inspection.mjs";
import { compilePageRenderInspectionContext } from "./page-render-resolver.mjs";
import { inspectionGenerationSignature } from "./generation-signature.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { generationDetailsProjection } from "./generation-details.mjs";
import { selectedPagePrompt } from "./page-rewrite.mjs";

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
  const diagnosis = await diagnoseRenderProfile(context.active_profile, repositoryRoot, config);
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
  return context.snapshot.character_references.map((reference) => {
    const facts = context.snapshot.character_facts[reference.character_id];
    return {
      character_id: reference.character_id,
      name: facts?.profile?.name ?? reference.character_id,
      variant_id: reference.variant_id,
      configuration_id: reference.variant_id,
    };
  });
}

export async function inspectPageRender({
  repositoryRoot,
  projectDirectory,
  pageKey,
  pagePromptDraft = undefined,
  promptSource = "original",
  config = {},
}) {
  const context = await compilePageRenderInspectionContext({
    repositoryRoot,
    projectDirectory,
    pageKey,
    pagePromptDraft,
  });
  if (promptSource === "rewrite" && context.compiled_page) {
    try {
      context.compiled_page = await selectedPagePrompt({
        projectDirectory,
        resolved: {
          page_id: context.snapshot.page_id,
          page_key: context.snapshot.page_key,
          project: context.project,
          compiled_page: context.compiled_page,
          reference_images: context.reference_images,
        },
        promptSource,
      });
    } catch (error) {
      context.compiled_page = null;
      context.blockers.push(issue(error?.code ?? "page_rewrite_unavailable", error?.message ?? String(error), "page_rewrite"));
    }
  } else if (promptSource !== "original" && promptSource !== "rewrite") {
    context.compiled_page = null;
    context.blockers.push(issue("invalid_prompt_source", "Prompt 来源无效", "page_rewrite"));
  }
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
  const auditWarnings = context.audit.warnings ?? [];
  const blockers = uniqueIssues([
    ...context.blockers,
    ...profile.blockers,
    ...loraBlockers(diagnosedLoras),
  ]);
  const warnings = uniqueIssues([...profile.warnings, ...auditWarnings]);
  const compiled = context.compiled_page;
  const profileIdentity = context.active_profile ? {
    id: context.active_profile.id,
    name: context.active_profile.name,
    architecture_family: context.active_profile.architecture_family,
    base_sha256: context.compiled_profile?.base_bundle?.resolved_profile_sha256
      ?? context.compiled_profile?.resolved_profile_sha256
      ?? null,
    effective_sha256: context.compiled_profile?.blocked
      ? null
      : context.compiled_profile?.effective_profile_sha256
        ?? context.compiled_profile?.resolved_profile_sha256
        ?? null,
  } : null;

  return {
    generation_signature: inspectionGenerationSignature(context),
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
      sections: structuredClone(compiled?.sections ?? []),
      images: structuredClone(compiled?.images ?? []),
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
      sections: compiled?.sections,
      canvas: context.project.canvas ?? null,
      loras: diagnosedLoras,
    }),
    audit: structuredClone(context.audit),
    blockers,
    warnings,
  };
}
