const canvases = new Set(["3:4", "1:1", "4:3", "2:3", "9:16"]);

export const STORY_PROJECT_FORMAT = "story-models-v1";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkExactKeys(value, allowed, valuePath, errors) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) errors.push(`${valuePath} 包含未知字段：${key}`);
}

export function validateProjectManifest(project) {
  const errors = [];
  if (!isRecord(project)) return ["project.json 必须是 JSON 对象"];
  checkExactKeys(project, ["$schema", "format", "title", "canvas", "default_render_profile"], "project.json", errors);
  if (project.format !== STORY_PROJECT_FORMAT) errors.push(`project.json 的 format 必须是 ${STORY_PROJECT_FORMAT}`);
  if (typeof project.title !== "string" || !project.title.trim()) errors.push("project.json 的 title 必须是非空字符串");
  if (!canvases.has(project.canvas)) errors.push("project.json 的 canvas 无效");
  if (typeof project.default_render_profile !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(project.default_render_profile)) errors.push("project.json 的 default_render_profile 不是有效 ID");
  return errors;
}
