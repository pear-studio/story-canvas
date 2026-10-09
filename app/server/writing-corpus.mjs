import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./http-support.mjs";

// 语料由所属项目持有；调用者传已解析的项目目录。
// 偏移语义与 scripts/corpus-search.mjs 一致：从文件头起的 UTF-8 字节偏移。
export function writingCorpusRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), "writing-corpus");
}

function corpusRelativePath(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// source_file 必须解析到语料库内的普通文件：拒绝绝对路径、.. 逃逸与符号链接。
export async function resolveWritingCorpusFile(projectRoot, sourceFile) {
  if (typeof sourceFile !== "string" || !sourceFile.trim() || path.isAbsolute(sourceFile)) {
    throw new ApiError(422, "invalid_text_source_path", [`source_file 必须是语料库内的相对路径：${String(sourceFile)}`]);
  }
  const corpusRoot = writingCorpusRoot(projectRoot);
  const target = path.resolve(corpusRoot, sourceFile);
  if (!corpusRelativePath(corpusRoot, target)) {
    throw new ApiError(422, "invalid_text_source_path", [`source_file 越出语料库：${sourceFile}`]);
  }
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) {
    throw new ApiError(422, "text_source_file_missing", [`语料文件不存在：${sourceFile}，请用 corpus:search 重新定位偏移`]);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ApiError(422, "invalid_text_source_path", [`语料路径不能是链接或目录：${sourceFile}`]);
  }
  const [realRoot, realTarget] = await Promise.all([realpath(corpusRoot), realpath(target)]);
  if (!corpusRelativePath(realRoot, realTarget)) {
    throw new ApiError(422, "invalid_text_source_path", [`语料路径经链接越出语料库：${sourceFile}`]);
  }
  return target;
}

// 按字节核验：定长读取 offset 起 Buffer.byteLength(sentence) 字节，须与 sentence 完全一致。
export async function verifyWritingCorpusSentence(projectRoot, { sourceFile, offset, sentence, label }) {
  const target = await resolveWritingCorpusFile(projectRoot, sourceFile);
  const length = Buffer.byteLength(sentence, "utf8");
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length || buffer.toString("utf8") !== sentence) {
      throw new ApiError(422, "text_source_offset_mismatch", [
        `${label} 的原文与语料不符（${sourceFile}@${offset}），请用 corpus:search 重新定位偏移`,
      ]);
    }
  } finally {
    await handle.close();
  }
}

// 语料上下文：在解码后的文本上按行切（不按字节切，防切断多字节字符），返回命中行 ±radius 行。
export async function readWritingCorpusContext(projectRoot, sourceFile, offset, { radius = 2 } = {}) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError(400, "invalid_text_source_offset", [`offset 必须是非负整数：${String(offset)}`]);
  }
  const target = await resolveWritingCorpusFile(projectRoot, sourceFile);
  const buffer = await readFile(target);
  if (offset >= buffer.length) {
    throw new ApiError(422, "text_source_offset_mismatch", [`偏移超出语料文件长度（${sourceFile}@${offset}），请用 corpus:search 重新定位偏移`]);
  }
  const text = buffer.toString("utf8");
  const charIndex = buffer.subarray(0, offset).toString("utf8").length;
  const lines = text.split(/\r?\n/);
  let acc = 0;
  let hitLine = 0;
  for (let index = 0; index < lines.length; index++) {
    const end = acc + lines[index].length;
    if (charIndex <= end) { hitLine = index; break; }
    acc = end + 1;
  }
  const from = Math.max(0, hitLine - radius);
  const to = Math.min(lines.length - 1, hitLine + radius);
  return {
    source_file: sourceFile,
    offset,
    hit_line: hitLine + 1,
    lines: lines.slice(from, to + 1).map((line, index) => ({
      number: from + index + 1,
      text: line,
      hit: from + index === hitLine,
    })),
  };
}
