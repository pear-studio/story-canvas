import { open } from "node:fs/promises";
import path from "node:path";

const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_ENTRIES = 10_000;
const MAX_METADATA_KEY_LENGTH = 1_024;
const MAX_METADATA_VALUE_LENGTH = 1_048_576;
const DTYPE_BYTE_WIDTHS = Object.freeze({
  BOOL: 1,
  U8: 1,
  I8: 1,
  U16: 2,
  I16: 2,
  U32: 4,
  I32: 4,
  U64: 8,
  I64: 8,
  F16: 2,
  BF16: 2,
  F32: 4,
  F64: 8,
  C64: 8,
  C128: 16,
  F8_E4M3: 1,
  F8_E5M2: 1,
  F8_E8M0: 1,
});

export class SafeTensorsMetadataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SafeTensorsMetadataError";
    this.code = code;
  }
}

function invalid(code, message) {
  throw new SafeTensorsMetadataError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseHeaderLength(prefix, strict) {
  if (prefix.length !== 8) {
    if (strict) invalid("invalid_safetensors_header", "SafeTensors 文件缺少完整的 8 字节 header length");
    return null;
  }
  const headerLength = Number(prefix.readBigUInt64LE());
  if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
    if (strict) invalid("invalid_safetensors_header_length", "SafeTensors header length 超出安全范围");
    return null;
  }
  return headerLength;
}

async function readExactAt(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  return offset;
}

function decodeUtf8(buffer, strict) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    if (strict) invalid("invalid_safetensors_header_encoding", "SafeTensors header 不是合法 UTF-8");
    return null;
  }
}

function parseJsonHeader(headerText, strict) {
  try {
    return JSON.parse(headerText);
  } catch (error) {
    if (strict) invalid("invalid_safetensors_header_json", "SafeTensors header 不是合法 JSON");
    return null;
  }
}

function normalizeMetadata(header, strict) {
  if (!isPlainObject(header)) {
    if (strict) invalid("invalid_safetensors_header_json", "SafeTensors header 必须是 JSON 对象");
    return {};
  }
  if (!Object.hasOwn(header, "__metadata__")) return {};
  const metadata = header.__metadata__;
  if (!isPlainObject(metadata)) {
    if (strict) invalid("invalid_safetensors_metadata", "SafeTensors __metadata__ 必须是对象");
    return {};
  }
  if (Object.keys(metadata).length > MAX_METADATA_ENTRIES) {
    if (strict) invalid("invalid_safetensors_metadata", "SafeTensors __metadata__ 字段数量超出安全范围");
    return {};
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!key || key.length > MAX_METADATA_KEY_LENGTH || typeof value !== "string" || value.length > MAX_METADATA_VALUE_LENGTH) {
      if (strict) invalid("invalid_safetensors_metadata", "SafeTensors __metadata__ 必须是合理大小的字符串键值表");
      return {};
    }
  }
  return structuredClone(metadata);
}

function assertStrictTensorHeaderWithLength(header, headerLength, fileSize) {
  const tensorEntries = Object.entries(header).filter(([key]) => key !== "__metadata__");
  if (!tensorEntries.length) invalid("invalid_safetensors_tensors", "SafeTensors header 至少需要一个 tensor");
  const ranges = [];
  for (const [name, tensor] of tensorEntries) {
    if (!isPlainObject(tensor)) invalid("invalid_safetensors_tensor", `SafeTensors tensor ${name} 必须是对象`);
    const keys = Object.keys(tensor).sort();
    if (keys.length !== 3 || keys[0] !== "data_offsets" || keys[1] !== "dtype" || keys[2] !== "shape") {
      invalid("invalid_safetensors_tensor", `SafeTensors tensor ${name} 的字段必须恰好为 dtype、shape、data_offsets`);
    }
    const width = DTYPE_BYTE_WIDTHS[tensor.dtype];
    if (!width) invalid("invalid_safetensors_dtype", `SafeTensors tensor ${name} 的 dtype 无效`);
    if (!Array.isArray(tensor.shape) || tensor.shape.some((dimension) => !Number.isSafeInteger(dimension) || dimension < 0)) {
      invalid("invalid_safetensors_shape", `SafeTensors tensor ${name} 的 shape 必须是非负安全整数数组`);
    }
    let elementCount = 1;
    for (const dimension of tensor.shape) {
      if (dimension !== 0 && elementCount > Number.MAX_SAFE_INTEGER / dimension) {
        invalid("invalid_safetensors_shape", `SafeTensors tensor ${name} 的 shape 乘积超出安全范围`);
      }
      elementCount *= dimension;
    }
    if (!Array.isArray(tensor.data_offsets) || tensor.data_offsets.length !== 2
      || tensor.data_offsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0)
      || tensor.data_offsets[0] > tensor.data_offsets[1]) {
      invalid("invalid_safetensors_offsets", `SafeTensors tensor ${name} 的 data_offsets 无效`);
    }
    const [start, end] = tensor.data_offsets;
    if (elementCount > Number.MAX_SAFE_INTEGER / width || end - start !== elementCount * width) {
      invalid("invalid_safetensors_offsets", `SafeTensors tensor ${name} 的 data_offsets 与 shape/dtype 不一致`);
    }
    ranges.push({ start, end });
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  let payloadEnd = 0;
  for (const range of ranges) {
    if (range.start !== payloadEnd) invalid("invalid_safetensors_offsets", "SafeTensors tensor 数据区必须从 0 连续覆盖且不能重叠");
    payloadEnd = range.end;
  }
  if (!Number.isSafeInteger(fileSize) || fileSize !== 8 + headerLength + payloadEnd) {
    invalid("invalid_safetensors_payload", "SafeTensors 文件 payload 长度不匹配");
  }
  return payloadEnd;
}

/**
 * 在已经打开的文件句柄上读取 header。严格模式还验证 tensor layout 与文件总长度；
 * 容错模式只保留历史 metadata reader 行为。
 */
export async function readSafeTensorsMetadataFromHandle(handle, { strict = false, fileInfo = null } = {}) {
  try {
    const prefix = Buffer.alloc(8);
    if (await readExactAt(handle, prefix, 0) !== 8) {
      if (strict) invalid("invalid_safetensors_header", "SafeTensors 文件缺少完整的 8 字节 header length");
      return {};
    }
    const headerLength = parseHeaderLength(prefix, strict);
    if (headerLength === null) return {};
    const header = Buffer.alloc(headerLength);
    if (await readExactAt(handle, header, 8) !== headerLength) {
      if (strict) invalid("invalid_safetensors_header", "SafeTensors header 不完整");
      return {};
    }
    const headerText = decodeUtf8(header, strict);
    if (headerText === null) return {};
    const parsed = parseJsonHeader(headerText, strict);
    if (parsed === null) return {};
    const metadata = normalizeMetadata(parsed, strict);
    if (strict) assertStrictTensorHeaderWithLength(parsed, headerLength, fileInfo?.size);
    return metadata;
  } catch (error) {
    if (error instanceof SafeTensorsMetadataError) throw error;
    if (strict) throw new SafeTensorsMetadataError("safetensors_read_failed", `读取 SafeTensors header 失败：${error.message}`);
    return {};
  }
}

/**
 * 只读取 SafeTensors 的固定大小 header，不触碰权重 payload。
 * 非严格模式保持 LoRA 资源提升流程的历史容错：任意格式问题都返回空对象。
 */
export async function readSafeTensorsMetadata(target, { strict = false } = {}) {
  if (strict && (typeof target !== "string" || path.extname(target) !== ".safetensors")) {
    invalid("invalid_safetensors_extension", "SafeTensors 文件必须使用 .safetensors 扩展名");
  }
  let handle;
  try {
    handle = await open(target, "r");
    const fileInfo = await handle.stat();
    return await readSafeTensorsMetadataFromHandle(handle, { strict, fileInfo });
  } catch (error) {
    if (error instanceof SafeTensorsMetadataError) throw error;
    if (strict) throw new SafeTensorsMetadataError("safetensors_read_failed", `读取 SafeTensors header 失败：${error.message}`);
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export const SAFE_TENSORS_METADATA_LIMITS = Object.freeze({
  max_header_bytes: MAX_HEADER_BYTES,
  max_entries: MAX_METADATA_ENTRIES,
  max_key_length: MAX_METADATA_KEY_LENGTH,
  max_value_length: MAX_METADATA_VALUE_LENGTH,
});

export const SAFE_TENSORS_DTYPE_BYTE_WIDTHS = DTYPE_BYTE_WIDTHS;
