const projectDirectoryPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const recordIdPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const windowsReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class ProjectContractError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function requireProjectDirectoryName(value) {
  if (typeof value !== "string" || !projectDirectoryPattern.test(value) || windowsReservedNames.test(value)) {
    throw new ProjectContractError(400, "invalid_project_id", ["项目目录名只能包含小写字母、数字、连字符和下划线，长度不超过 80 个字符"]);
  }
  return value;
}

export function emptyMaterialMetadata() {
  return { items: [] };
}

export function emptyCreativeAgreement() {
  return { items: [] };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkExactKeys(value, keys, path, errors) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path} 含有未知字段：${key}`);
}

function checkText(value, path, errors, { required = true, max = 20000 } = {}) {
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) {
    errors.push(`${path} 必须是${required ? "非空" : ""}文本，且不超过 ${max} 个字符`);
  }
}

function checkRecordId(value, path, errors) {
  if (typeof value !== "string" || !recordIdPattern.test(value)) errors.push(`${path} 不是有效 ID`);
}

export function normalizeMaterialPath(value) {
  if (typeof value !== "string") throw new ProjectContractError(422, "invalid_material_path");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    !normalized || normalized === "index.json" || normalized.includes("/") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git" || windowsReservedNames.test(segment) || /[<>:\"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment))
  ) throw new ProjectContractError(422, "invalid_material_path");
  return normalized;
}

export function validateMaterialMetadata(value) {
  const errors = [];
  if (!isRecord(value)) return ["materials/index.json 必须是对象"];
  checkExactKeys(value, ["$schema", "items"], "materials/index.json", errors);
  if (!Array.isArray(value.items)) errors.push("materials/index.json 的 items 必须是数组");
  const files = new Set();
  for (const [index, item] of (Array.isArray(value.items) ? value.items : []).entries()) {
    const itemPath = `materials/index.json.items[${index}]`;
    if (!isRecord(item)) { errors.push(`${itemPath} 必须是对象`); continue; }
    checkExactKeys(item, ["title", "file"], itemPath, errors);
    checkText(item.title, `${itemPath}.title`, errors, { max: 200 });
    try {
      const file = normalizeMaterialPath(item.file);
      if (files.has(file)) errors.push(`${itemPath}.file 与其他材料重复`);
      files.add(file);
    } catch { errors.push(`${itemPath}.file 不是 materials/ 下的有效文件名`); }
  }
  return errors;
}

export function validateCreativeAgreement(value) {
  const errors = [];
  if (!isRecord(value)) return ["creative-agreement.json 必须是对象"];
  checkExactKeys(value, ["$schema", "items"], "creative-agreement.json", errors);
  if (!Array.isArray(value.items)) errors.push("creative-agreement.json 的 items 必须是数组");
  const itemIds = new Set();
  for (const [index, item] of (Array.isArray(value.items) ? value.items : []).entries()) {
    const itemPath = `creative-agreement.json.items[${index}]`;
    if (!isRecord(item)) { errors.push(`${itemPath} 必须是对象`); continue; }
    checkExactKeys(item, ["id", "text", "strength"], itemPath, errors);
    checkRecordId(item.id, `${itemPath}.id`, errors);
    if (itemIds.has(item.id)) errors.push(`${itemPath}.id 重复`);
    itemIds.add(item.id);
    checkText(item.text, `${itemPath}.text`, errors);
    if (!new Set(["hard", "preference"]).has(item.strength)) errors.push(`${itemPath}.strength 必须为 hard 或 preference`);
  }
  return errors;
}
