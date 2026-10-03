import {qwenSourceSelection} from '../shared/prompt-source-view.mjs';
import { readFactDraft } from "./fact-drafts.mjs";
import { decodePageKey } from "./page-key.mjs";
import { compilePageRenderInspectionContext } from "./page-render-resolver.mjs";
import { characterSource, sceneSource } from "./prompt-contract.mjs";
import {variantPrompt} from '../shared/prompt-inheritance.mjs';

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function referenceProjection(pagePrompt, source, kind, setting) {
  const overrides = isRecord(pagePrompt?.text_overrides) ? pagePrompt.text_overrides : {};
  const override = Object.hasOwn(overrides, source) ? overrides[source] : null;
  const currentText = setting.text ?? "";
  const selection = qwenSourceSelection(setting,pagePrompt,source);
  return {
    ...(setting.identity?{inherited_prompt:variantPrompt(setting.identity,setting),adjustments:structuredClone(pagePrompt.inheritance?.[source]??{})}:{}),
    source,
    kind,
    id: setting.id,
    variant_id: setting.configuration_id,
    prompt_name: setting.prompt_name ?? setting.id,
    current_text: currentText,
    override,
    effective_text: selection.text,
    reference_images: structuredClone(setting.reference_images ?? []),
    selected_image_ids: structuredClone(selection.selected_image_ids),
  };
}

// 调用者必须放在 readFacts 一致性读取边界内；本函数不诊断模型文件，也不访问 ComfyUI。
export async function readPromptEditContext({ projectRoot, repositoryRoot = projectRoot, projectDirectory, projectId, pageKey }) {
  const key = decodePageKey(pageKey);
  const domain = "page";
  const kind = "prompt";
  const draft = await readFactDraft(projectRoot, { domain, kind, projectId, targetId: key.page_id });
  const context = await compilePageRenderInspectionContext({ repositoryRoot, projectDirectory, pageKey: key });
  const { snapshot, compiled_profile: bundle, compiled_page: compiled } = context;
  const pagePrompt = snapshot.page_prompt;
  const references = [
    ...snapshot.characters.map((character) => referenceProjection(
      pagePrompt, characterSource(character.id, character.configuration_id), "character", character,
    )),
    ...snapshot.scenes.map((scene) => referenceProjection(
      pagePrompt, sceneSource(scene.id, scene.configuration_id), "scene", scene,
    )),
  ];
  const overridden = [...(bundle?.override_resolution?.changes ?? []), ...(bundle?.override_resolution?.redundant ?? [])]
    .some((change) => change.target === "prompt.text");
  const activeProfile = bundle?.blocked ? null : bundle?.effective_profile ?? null;
  const globalText = activeProfile?.prompt?.text
    ?? (bundle?.blocked ? bundle.base_bundle.resolved_profile.prompt.text : null);
  // 配置冲突时 inspection 只提供基础预览，不能冒充有效结果。
  const complete = Boolean(activeProfile && compiled && !compiled.missing.length && !compiled.errors.length && context.audit.status === "complete");
  const final = activeProfile && compiled ? {
    positive: compiled.positive_prompt,
    negative: compiled.negative_prompt,
    images: structuredClone(compiled.images),
    sections: structuredClone(compiled.sections),
    parts: structuredClone(compiled.prompt_parts??null),
  } : null;
  return {
    page_key: key,
    save: { domain, kind },
    draft,
    context: {
      status: complete ? "complete" : "incomplete",
      model_id: snapshot.model_id,
      render: snapshot.render,
      configuration: {
        model_id:snapshot.model_id, render:snapshot.render,
        profile_id:activeProfile?.id ?? null,
        effective_loras:activeProfile && compiled && !compiled.errors.length ? structuredClone(compiled.loras ?? []) : null,
        lora_sources: {
          profile:activeProfile ? structuredClone(activeProfile.style_loras ?? {}) : null,
          settings:Object.fromEntries([...snapshot.characters.map(c=>[characterSource(c.id,c.configuration_id),c]),
            ...snapshot.scenes.map(c=>[sceneSource(c.id,c.configuration_id),c])].map(([key,c])=>[key,{identity:structuredClone(c.identity?.lora??null),local:structuredClone(c.local_loras??[]),resolved:structuredClone(c.loras??[]),overrides:structuredClone(c.lora_overrides??{})}])),
          page:{loras:structuredClone(pagePrompt.loras??[]),overrides:structuredClone(pagePrompt.lora_overrides??{})},
        },
      },
      title: snapshot.title,
      global_text: {
        text: globalText,
        source: overridden ? "project_override" : "profile",
      },
      references,
      page: {
        model_input: structuredClone(pagePrompt),
        text: typeof pagePrompt.text === "string" ? pagePrompt.text : "",
        reference_images: structuredClone(pagePrompt.reference_images ?? []),
      },
      final,
      audit: context.audit,
      diagnostics: context.blockers,
    },
  };
}
