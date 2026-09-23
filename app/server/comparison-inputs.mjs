import { randomUUID } from "node:crypto";
import { compilePageRenderTarget } from "./page-render-resolver.mjs";
import { readResolvedRenderProfile } from "./render-profile-compiler.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { ApiError } from "./http-support.mjs";
import { referenceImageFilename } from "./reference-image.mjs";

// 来源只用于追溯。导入后的生成内容和配置均由实验独立持有。
export async function importComparisonPage({ repositoryRoot, projectDirectory, projectId, pageKey, localConfig, includeReferenceBytes = false }) {
  const target = await compilePageRenderTarget({ repositoryRoot, projectDirectory, pageKey });
  const bundle = target.compiled_profile;
  return {
    id: `input-${randomUUID()}`, label: target.title ?? target.page_id,
    prompt: { positive: target.compiled_page.positive_prompt, negative: target.compiled_page.negative_prompt },
    loras: target.page_loras.map(lora => ({ ...lora, trigger_words: [...new Set([
      ...(lora.activation_triggers ?? []).map(trigger => trigger.text),
      ...(lora.kind === "style" ? Object.values(bundle.effective_profile.style_loras ?? {})
        .filter(style => style.filename === lora.filename).map(style => style.trigger?.trim()).filter(Boolean) : []),
    ])] })),
    render: { profile: bundle.effective_profile, workflows: bundle.workflow_definitions, canvas: target.project.canvas },
    ...(target.reference_images?.length ? { reference_images: target.reference_images } : {}),
    ...(includeReferenceBytes ? { reference_image_bytes: target.reference_image_bytes ?? [] } : {}),
    source: { project_id: projectId, page_key: pageKey, imported_at: new Date().toISOString(), target_sha256: target.target_sha256 },
  };
}

export async function createBlankComparisonInput(repositoryRoot, profileId, canvas = "2:3") {
  const bundle = await readResolvedRenderProfile(repositoryRoot, profileId);
  return { id: `input-${randomUUID()}`, label: "新测试输入", prompt: { positive: "", negative: "" }, loras: [],
    render: { profile: bundle.resolved_profile, workflows: bundle.workflow_definitions, canvas }, source: null };
}

export function assertComparisonInput(value) {
  const fail = message => { throw new ApiError(422, "invalid_comparison_input", [message]); };
  if (!value || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value.id ?? "") || typeof value.label !== "string" || !value.label.trim()) fail("测试输入缺少 id 或名称");
  if (typeof value.prompt?.positive !== "string" || !value.prompt.positive.trim() || typeof value.prompt?.negative !== "string") fail("测试输入需要完整正向与负向文本");
  const render = value.render;
  if (!render?.profile || !render.workflows || !["2:3", "3:4", "9:16", "4:3"].includes(render.canvas)) fail("测试输入缺少生成配置或画幅");
  if (value.reference_images !== undefined) {
    if (!Array.isArray(value.reference_images) || value.reference_images.length > 10) fail("参考图数量无效（最多 10 张）");
    for (const reference of value.reference_images) {
      try { referenceImageFilename(reference); } catch { fail("参考图冻结身份无效"); }
      if (!Number.isInteger(reference.width) || reference.width < 1 || !Number.isInteger(reference.height) || reference.height < 1) fail("参考图尺寸无效");
    }
  }
  const route = render.profile.operations?.candidates?.routes?.[value.reference_images?.length ? "reference_image" : "empty_latent"];
  if (!route?.recipe || !render.workflows[route.workflow]) fail("生成配置缺少候选工作流");
  if (!Array.isArray(value.loras)) fail("LoRA 必须为数组");
  for (const lora of value.loras) {
    if (typeof lora.filename !== "string" || !lora.filename || lora.filename.includes("\\") || lora.filename.startsWith("/") || lora.filename.split("/").some(part => !part || part === ".." || part === ".")
      || !/^[a-f0-9]{64}$/.test(lora.sha256 ?? "") || !Number.isFinite(lora.weight) || lora.weight < -2 || lora.weight > 2) fail("LoRA 文件身份或权重无效");
  }
  return structuredClone(value);
}

export function comparisonRenderIdentity(input) {
  const { profile, canvas } = input.render;
  return { profile_id: profile.id, profile_sha256: hashCanonicalJson(profile), canvas,
    architecture_family: profile.architecture_family, prompt_family: profile.architecture_family, models: profile.models };
}
