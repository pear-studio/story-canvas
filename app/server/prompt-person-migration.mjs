// 一次性维护转换；运行时只接受 person，不兼容旧分类。
export function migratePromptPerson(value) {
  if (Array.isArray(value)) {
    if (value.includes("appearance") && value.includes("action")) {
      return value.filter(item => item !== "action").map(item => item === "appearance" ? "person" : migratePromptPerson(item));
    }
    return value.map(migratePromptPerson);
  }
  if (!value || typeof value !== "object") return value;
  const old = Object.hasOwn(value, "appearance") || Object.hasOwn(value, "action");
  if (old && (!Array.isArray(value.appearance) || !Array.isArray(value.action) || Object.hasOwn(value, "person"))) {
    throw new Error("旧 Prompt 分类不完整或同时存在 person，拒绝迁移");
  }
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (old && key === "action") return [];
    if (old && key === "appearance") return [["person", [...value.appearance, ...value.action].map(migratePromptPerson)]];
    return [[key, migratePromptPerson(item)]];
  }));
}
