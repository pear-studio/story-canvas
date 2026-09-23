import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./http-support.mjs";
import { referenceImageFilename } from "./reference-image.mjs";

const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const stageDirectory = (root, token) => path.join(root, "Saved", "comparison-imports", token);

// 导入接口只返回轻量身份；图片暂存于 Saved，创建实验时复制到实验快照。
export async function stageComparisonImports(root, imports) {
  const token = imports.some(input => input.reference_images?.length) ? randomUUID() : null;
  if (token) await mkdir(stageDirectory(root, token), { recursive: true });
  for (const input of imports) for (const image of input.reference_image_bytes ?? []) {
    referenceImageFilename(image.identity);
    if (hash(image.bytes) !== image.identity.sha256) throw new ApiError(422, "comparison_reference_changed", ["导入参考图内容校验失败"]);
    await writeFile(path.join(stageDirectory(root, token), `${image.identity.sha256}.png`), image.bytes);
  }
  return imports.map(({ reference_image_bytes: _bytes, ...input }) => input.reference_images?.length
    ? { ...input, reference_import_id: token } : input);
}

export async function materializeComparisonReferences(root, inputs) {
  const images = new Map();
  const clean = [];
  for (const value of inputs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_comparison_input", ["测试输入必须是对象"]);
    const { reference_import_id: token, reference_image_bytes: _bytes, ...input } = value;
    if (_bytes !== undefined) throw new ApiError(422, "invalid_comparison_input", ["参考图字节只能通过导入接口传递"]);
    const references = input.reference_images ?? [];
    if (references.length && (typeof token !== "string" || !tokenPattern.test(token))) throw new ApiError(422, "comparison_reference_import_required", ["带参考图输入需要先通过导入接口获取"]);
    for (const reference of references) {
      try { referenceImageFilename(reference); } catch { throw new ApiError(422, "invalid_comparison_input", ["参考图冻结身份无效"]); }
      let bytes;
      try { bytes = await readFile(path.join(stageDirectory(root, token), `${reference.sha256}.png`)); }
      catch (error) { if (error.code === "ENOENT") throw new ApiError(422, "comparison_reference_missing", ["暂存参考图已丢失，请重新导入页面"]); throw error; }
      if (hash(bytes) !== reference.sha256) throw new ApiError(422, "comparison_reference_changed", ["暂存参考图内容已变化，请重新导入页面"]);
      images.set(reference.sha256, { identity: reference, bytes });
    }
    clean.push(input);
  }
  return { inputs: clean, images: [...images.values()] };
}
