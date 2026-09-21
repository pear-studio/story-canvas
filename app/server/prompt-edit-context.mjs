import { readFactDraft } from "./fact-drafts.mjs";
import { decodePageKey } from "./page-key.mjs";
import { compilePageRenderInspectionContext } from "./page-render-resolver.mjs";
import { loadPromptDictionaryForRender } from "./prompt-dictionary-loader.mjs";
import { applyInheritedPrompt, characterSource, sceneSource, inheritanceCategories } from "../shared/prompt-inheritance.mjs";

const settings = fragment => ({ weight: fragment.weight ?? 1, enabled: fragment.enabled !== false });

// 展示原词和各层结果；数值计算只调用生成使用的继承函数，不再实现覆盖算法。
function inheritedGroup({ source, path, prompt, identityAdjustments, identityDisabled, pageAdjustments = {} }) {
  const middle = applyInheritedPrompt(prompt, identityAdjustments, identityDisabled);
  const effective = applyInheritedPrompt(middle, pageAdjustments);
  return {
    source, path,
    ...(identityAdjustments ? { identity_overrides: identityAdjustments, identity_disabled: identityDisabled ?? [] } : {}),
    page_adjustments: pageAdjustments,
    fragments: inheritanceCategories.flatMap(category => (prompt[category] ?? []).map((fragment, index) => ({
      category, fragment,
      ...(identityAdjustments ? { after_identity: settings(middle[category][index]) } : {}),
      effective: settings(effective[category][index]),
    }))),
  };
}

// 调用者必须放在 readFacts 一致性读取边界内；本函数不诊断模型文件，也不访问 ComfyUI。
export async function readPromptEditContext({ projectRoot, repositoryRoot = projectRoot, projectDirectory, projectId, pageKey, config = {} }) {
  const key = decodePageKey(pageKey);
  const domain = "page";
  const kind = "prompt";
  const draft = await readFactDraft(projectRoot, { domain, kind, projectId, targetId: key.page_id });
  let dictionaryEntries = null, dictionaryError = null;
  try { dictionaryEntries = (await loadPromptDictionaryForRender(config, repositoryRoot)).entries; }
  catch (error) { dictionaryError = error.message; }
  const context = await compilePageRenderInspectionContext({ repositoryRoot, projectDirectory, pageKey: key, dictionaryEntries, dictionaryError });
  const { snapshot, compiled_profile: bundle, compiled_page: compiled } = context;
  const inherited = [];
  for (const character of snapshot.characters) {
    const source = characterSource(character.id, character.configuration_id);
    const pageAdjustments = snapshot.page_prompt.inheritance?.[source] ?? {};
    inherited.push(inheritedGroup({ source, path: `characters/${character.id}.prompt.json.identity.prompt`, prompt: character.identity.prompt,
      identityAdjustments: character.identity_overrides ?? {}, identityDisabled: character.identity_disabled ?? [], pageAdjustments }));
    inherited.push(inheritedGroup({ source, path: `characters/${character.id}.prompt.json.variants.${character.configuration_id}.prompt`, prompt: character.prompt, pageAdjustments }));
  }
  for (const scene of snapshot.scenes) {
    const source = sceneSource(scene.id, scene.configuration_id);
    const pageAdjustments = snapshot.page_prompt.inheritance?.[source] ?? {};
    inherited.push(inheritedGroup({ source, path: `scenes/${scene.id}.prompt.json.identity.prompt`, prompt: scene.identity.prompt, identityAdjustments: scene.identity_overrides ?? {}, identityDisabled: scene.identity_disabled ?? [], pageAdjustments }));
    inherited.push(inheritedGroup({ source, path: `scenes/${scene.id}.prompt.json.variants.${scene.configuration_id}.prompt`, prompt: scene.prompt, pageAdjustments }));
  }
  // 配置冲突时 inspection 会提供基础预览；这里不能冒充有效结果。
  const effective = bundle?.blocked ? null : bundle?.effective_profile ?? null;
  const complete = Boolean(effective && compiled && !compiled.missing.length && !compiled.errors.length && context.audit.status === "complete");
  const final = effective && compiled ? {
    mode: snapshot.page_prompt.mode ?? "structured",
    positive: compiled.positive_prompt, negative: compiled.negative_prompt,
    loras: compiled.loras,
    parts: Object.fromEntries(["positive", "negative"].map(polarity => [polarity, (compiled.prompt_parts?.[polarity] ?? []).map(part => ({
      text: part.text, origin: part.origin, origin_id: part.origin_id, path: part.path,
      category: part.category, scope: part.scope,
    }))])),
  } : null;
  return {
    page_key: key,
    save: { domain, kind },
    draft,
    context: {
      status: complete ? "complete" : "incomplete",
      title: snapshot.title,
      mode: snapshot.page_prompt.mode ?? "structured",
      inherited_usage: "generation",
      inherited,
      profile: {
        id: snapshot.project.default_render_profile,
        effective_sha256: bundle?.effective_profile_sha256 ?? null,
        prompt: effective?.prompt ?? null,
        style_loras: effective?.style_loras ?? null,
        override_source: bundle?.override_source_identity ?? null,
        overrides: bundle?.override_resolution?.changes ?? [],
        redundant_overrides: bundle?.override_resolution?.redundant ?? [],
        conflicts: bundle?.override_resolution?.conflicts ?? [],
      },
      final,
      audit: context.audit,
      diagnostics: context.blockers,
    },
  };
}
