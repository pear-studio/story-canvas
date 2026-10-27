import { randomUUID } from "node:crypto";
import { compilePageRenderTarget } from "./page-render-resolver.mjs";
import { readResolvedRenderProfile } from "./render-profile-compiler.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { ApiError } from "./http-support.mjs";
import { referenceImageFilename } from "./reference-image.mjs";
import {captureMossComparisonNative,emptyMossComparisonNative,compileComparisonInput,comparisonInputRoute} from './comparison-native-input.mjs';
export {compileComparisonInput,comparisonInputRoute} from './comparison-native-input.mjs';

function frozenRoute(profile,inputSource){const route=profile.operations.candidates.routes[inputSource];return {operation:'candidates',input_source:inputSource,workflow_id:route.workflow,recipe_source_id:route.recipe_source_id};}

// 来源只用于追溯。导入后的生成内容和配置均由实验独立持有。
export async function importComparisonPage({ repositoryRoot, projectDirectory, projectId, pageKey, localConfig, includeReferenceBytes = false }) {
  const target = await compilePageRenderTarget({ repositoryRoot, projectDirectory, pageKey });
  const bundle = target.compiled_profile;
  const profile=structuredClone(bundle.effective_profile);
  const inputSource=target.candidate_route.input_source;
  profile.operations.candidates.routes[inputSource].recipe=structuredClone(target.candidate_recipe);
  const native=profile.architecture_family==='moss-image'?captureMossComparisonNative(target):null;
  return {
    version:1,id: `input-${randomUUID()}`, label: target.title ?? target.page_id,
    prompt: { positive: target.compiled_page.positive_prompt, negative: target.compiled_page.negative_prompt },
    loras: target.page_loras.map(lora => ({ ...lora, trigger_words: [...new Set([
      ...(lora.activation_triggers ?? []).map(trigger => trigger.text),
      ...(typeof lora.trigger==='string'&&lora.trigger.trim()?[lora.trigger.trim()]:[]),
      ...(native?.trigger_sources.filter(source=>source.lora_sha256===lora.sha256).flatMap(source=>source.words)??[]),
      ...(lora.kind === "style" ? Object.values(bundle.effective_profile.style_loras ?? {})
        .filter(style => style.filename === lora.filename).map(style => style.trigger?.trim()).filter(Boolean) : []),
    ])] })),
    render: { profile, workflows: bundle.workflow_definitions, canvas: target.project.canvas,route:frozenRoute(profile,inputSource) },
    ...(native?{native_input:native}:{}),
    ...(target.reference_images?.length ? { reference_images: target.reference_images } : {}),
    ...(includeReferenceBytes ? { reference_image_bytes: target.reference_image_bytes ?? [] } : {}),
    source: { project_id: projectId, page_key: pageKey, imported_at: new Date().toISOString(), target_sha256: target.target_sha256 },
  };
}

export async function createBlankComparisonInput(repositoryRoot, profileId, canvas = "3:4") {
  const bundle = await readResolvedRenderProfile(repositoryRoot, profileId);
  return { version:1,id: `input-${randomUUID()}`, label: "新测试输入", prompt: { positive: "", negative: "" }, loras: [],
    render: { profile: bundle.resolved_profile, workflows: bundle.workflow_definitions, canvas,route:frozenRoute(bundle.resolved_profile,'empty_latent') },
    ...(bundle.resolved_profile.architecture_family==='moss-image'?{native_input:emptyMossComparisonNative()}:{}),source: null };
}

export function assertComparisonInput(value,{legacy=false,allow_empty=false}={}) {
  const fail = message => { throw new ApiError(422, "invalid_comparison_input", [message]); };
  if (!value || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value.id ?? "") || typeof value.label !== "string" || !value.label.trim()) fail("测试输入缺少 id 或名称");
  if(!legacy&&value.version!==1)throw new ApiError(422,'comparison_input_reimport_required',['旧测试输入需重新导入，不会按新版语义解释']);
  if (legacy&&(typeof value.prompt?.positive !== "string" || !value.prompt.positive.trim() || typeof value.prompt?.negative !== "string")) fail("测试输入需要完整正向与负向文本");
  const render = value.render;
  if (!render?.profile || !render.workflows || !["3:4", "1:1", "4:3", "2:3", "9:16"].includes(render.canvas)) fail("测试输入缺少生成配置或画幅");
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
  if(legacy)return structuredClone(value);
  if(!render.route)fail('测试输入缺少冻结候选路线，请重新导入');
  comparisonInputRoute(value);
  const compiled=compileComparisonInput(value,{allow_empty});
  return {...structuredClone(value),prompt:{positive:compiled.positive,negative:compiled.negative}};
}

export function comparisonRenderIdentity(input) {
  const { profile, canvas } = input.render;
  return { profile_id: profile.id, profile_sha256: hashCanonicalJson(profile), canvas,
    architecture_family: profile.architecture_family, prompt_family: profile.architecture_family, models: profile.models };
}
