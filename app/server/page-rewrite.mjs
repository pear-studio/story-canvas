import { lstat, readFile } from "node:fs/promises";

import { ApiError } from "./http-support.mjs";
import { decodePageKey, encodePageKey } from "./page-key.mjs";
import { compilePageRenderInspectionContext, compilePageRenderTarget } from "./page-render-resolver.mjs";
import { factStorage } from "./story-facts.mjs";
import { hashCanonicalJson } from "./workflow-definition.mjs";
import { profileModelAdapter } from './model-adapters.mjs';

const REWRITE_ENGINE = "qwen-pe-t2i-int8";

function relativeFile(pageId) { return `pages/${pageId}.rewrite.json`; }

export function validatePageRewriteDocument(value) {
  return !value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1 || value.mode !== "t2i"
    || (value.engine !== undefined && value.engine !== REWRITE_ENGINE)
    || typeof value.rewritten_prompt !== "string" || !value.rewritten_prompt.trim()
    || typeof value.wh_ratio !== "string" || !/^\d{1,3}:\d{1,3}$/.test(value.wh_ratio)
    || !/^[a-f0-9]{64}$/.test(value.input_sha256 ?? "")
    || typeof value.created_at !== "string" ? ["page_rewrite_invalid"] : [];
}

function checkedDocument(value) {
  if (validatePageRewriteDocument(value).length) throw new ApiError(422, "page_rewrite_invalid");
  return value;
}

async function readDocument(projectDirectory, pageId) {
  const relative = relativeFile(pageId);
  const target = factStorage.targetPath(projectDirectory, relative);
  const info = await lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new ApiError(422, "page_rewrite_path_invalid", [relative]);
  await factStorage.assertProjectFactBoundary(projectDirectory, projectDirectory, target, relative);
  let value;
  try { value = JSON.parse(await readFile(target, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ApiError(422, "page_rewrite_json_invalid", [relative]);
    throw error;
  }
  return checkedDocument(value);
}

function sourceSha(context) {
  const positive = context.compiled_page?.positive_prompt;
  if (typeof positive !== "string" || !positive.trim() || !Array.isArray(context.reference_images)) return null;
  return hashCanonicalJson({
    page_key: encodePageKey(context.snapshot.page_key),
    positive_prompt: positive,
    canvas: context.project.canvas,
    model_profile: context.project.default_render_profile,
    reference_images: context.reference_images.map(image => ({
      material_file: image.material_file,
      source_sha256: image.source_sha256,
      sha256: image.sha256,
    })),
  });
}

function referencePrefix(compiledPage) {
  const images = compiledPage?.images ?? [];
  if (!images.length) return "";
  const sections = compiledPage.sections ?? [];
  const lines = images.map((image) => {
    const section = sections.find((entry) => entry.source === image.source && entry.image_ids?.includes(image.id));
    let purpose = "本页附图参考。";
    if (section?.kind === "character") purpose = `${section.prompt_name}的身份与服装参考。`;
    else if (section?.kind === "scene") purpose = `${section.prompt_name}的环境外观参考。`;
    else if (section?.kind === "attachment") purpose = section.text;
    return `<image${image.index}>：${purpose}`;
  });
  return `参考图用途：\n${lines.join("\n")}`;
}

function effectivePrompt(document, compiledPage) {
  const prefix = referencePrefix(compiledPage);
  return prefix ? `${prefix}\n\n${document.rewritten_prompt}` : document.rewritten_prompt;
}

function projection(document, compiledPage, inputSha) {
  const current = document?.engine === REWRITE_ENGINE && inputSha && document.input_sha256 === inputSha;
  return {
    status: !document ? "missing" : current ? "current" : "stale",
    rewrite: document ? { rewritten_prompt: document.engine === REWRITE_ENGINE
      ? effectivePrompt(document, compiledPage) : document.rewritten_prompt, wh_ratio: document.wh_ratio } : null,
    original_prompt: compiledPage?.positive_prompt ?? "",
    input_sha256: inputSha,
    rewrite_sha256: document ? hashCanonicalJson(document) : null,
  };
}

export async function readPageRewriteState({ repositoryRoot, projectDirectory, pageKey }) {
  const key = decodePageKey(pageKey);
  const context = await compilePageRenderInspectionContext({ repositoryRoot, projectDirectory, pageKey: key });
  const document = await readDocument(projectDirectory, key.page_id);
  return projection(document, context.compiled_page, sourceSha(context));
}

export async function rewriteSource({ repositoryRoot, projectDirectory, pageKey }) {
  const resolved = await compilePageRenderTarget({ repositoryRoot, projectDirectory, pageKey });
  if (!profileModelAdapter(resolved.compiled_profile.effective_profile).capabilities.rewrite) throw new ApiError(422,'model_rewrite_unsupported');
  const inputSha = sourceSha({
    snapshot: resolved,
    compiled_page: resolved.compiled_page,
    reference_images: resolved.reference_images,
    project: resolved.project,
  });
  const before = await readDocument(projectDirectory, resolved.page_id);
  if (!inputSha) throw new ApiError(422, "page_rewrite_source_unavailable");
  return {
    page_key: resolved.page_key,
    page_id: resolved.page_id,
    original_prompt: resolved.compiled_page.positive_prompt,
    compiled_page: resolved.compiled_page,
    canvas: resolved.project.canvas,
    input_sha256: inputSha,
    rewrite_sha256: before ? hashCanonicalJson(before) : null,
  };
}

export async function savePageRewriteResult({ repositoryRoot, projectDirectory, source, result }) {
  const current = await rewriteSource({ repositoryRoot, projectDirectory, pageKey: source.page_key });
  if (current.input_sha256 !== source.input_sha256) throw new ApiError(409, "page_rewrite_input_conflict");
  if (current.rewrite_sha256 !== source.rewrite_sha256) throw new ApiError(409, "page_rewrite_target_conflict");
  if (!result || typeof result.rewritten_prompt !== "string" || !result.rewritten_prompt.trim()
    || typeof result.wh_ratio !== "string" || !/^\d{1,3}:\d{1,3}$/.test(result.wh_ratio)) {
    throw new ApiError(422, "page_rewrite_result_invalid");
  }
  const document = checkedDocument({
    version: 1,
    mode: "t2i",
    engine: REWRITE_ENGINE,
    rewritten_prompt: result.rewritten_prompt,
    wh_ratio: result.wh_ratio,
    input_sha256: source.input_sha256,
    created_at: new Date().toISOString(),
  });
  const relative = relativeFile(current.page_id);
  const target = factStorage.targetPath(projectDirectory, relative);
  await factStorage.writeJsonAtomic(target, document);
  return projection(document, current.compiled_page, source.input_sha256);
}

export async function selectedPagePrompt({ projectDirectory, resolved, promptSource = "original" }) {
  if (promptSource === "original") return resolved.compiled_page;
  if (promptSource !== "rewrite") throw new ApiError(400, "invalid_prompt_source");
  if (resolved.model_id === 'anima') throw new ApiError(422,'model_rewrite_unsupported');
  const document = await readDocument(projectDirectory, resolved.page_id);
  if (!document) throw new ApiError(409, "page_rewrite_missing");
  const prefix = referencePrefix(resolved.compiled_page);
  const prompt = effectivePrompt(document, resolved.compiled_page);
  return {
    ...resolved.compiled_page,
    positive_prompt: prompt,
    sections: [
      ...(prefix ? [{ kind: "reference", text: prefix, source: relativeFile(resolved.page_id) }] : []),
      { kind: "rewrite", text: document.rewritten_prompt, source: relativeFile(resolved.page_id) },
    ],
  };
}
