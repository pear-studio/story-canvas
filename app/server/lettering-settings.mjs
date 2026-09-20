import { characterIdPattern } from "./character-files.mjs";

export const LETTERING_SETTINGS_SCHEMA_ID = "https://storyvisualizer.local/schemas/lettering-settings.schema.json";
export const DEFAULT_CHARACTER_DISPLAY_COLOR = "#26322D";

const directions = new Set(["horizontal", "vertical"]);
const letteringKinds = new Set(["plain", "balloon", "caption", "float"]);
const letteringPresetKeys = ["character_speech", "character_thought", "npc_speech"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkExactKeys(value, allowed, valuePath, errors) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) errors.push(`${valuePath} 包含未知字段：${key}`);
}

export function defaultLetteringSettings() {
  return {
    $schema: LETTERING_SETTINGS_SCHEMA_ID,
    font_family: "LXGW WenKai",
    font_size: 28,
    character_speech: { direction: "horizontal", kind: "balloon" },
    character_thought: { direction: "horizontal", kind: "plain" },
    npc_speech: { direction: "horizontal", kind: "balloon" },
    character_colors: {},
  };
}

export function validateLetteringSettingsDocument(settings, valuePath = "lettering settings") {
  const errors = [];
  if (!isRecord(settings)) return [`${valuePath} 必须是对象`];
  checkExactKeys(settings, ["$schema", "font_family", "font_size", ...letteringPresetKeys, "character_colors"], valuePath, errors);
  if (settings.$schema !== LETTERING_SETTINGS_SCHEMA_ID) errors.push(`${valuePath}.$schema 不匹配`);
  if (typeof settings.font_family !== "string" || !settings.font_family.trim() || settings.font_family.length > 100) errors.push(`${valuePath}.font_family 必须是 1 到 100 个字符`);
  if (!Number.isInteger(settings.font_size) || settings.font_size < 12 || settings.font_size > 96) errors.push(`${valuePath}.font_size 必须是 12 到 96 的整数`);
  for (const key of letteringPresetKeys) {
    const preset = settings[key];
    const presetPath = `${valuePath}.${key}`;
    if (!isRecord(preset)) { errors.push(`${presetPath} 必须是对象`); continue; }
    checkExactKeys(preset, ["direction", "kind"], presetPath, errors);
    if (!directions.has(preset.direction)) errors.push(`${presetPath}.direction 无效`);
    if (!letteringKinds.has(preset.kind)) errors.push(`${presetPath}.kind 无效`);
  }
  if (!isRecord(settings.character_colors)) errors.push(`${valuePath}.character_colors 必须是对象`);
  else for (const [characterId, color] of Object.entries(settings.character_colors)) {
    const colorPath = `${valuePath}.character_colors.${characterId}`;
    if (!characterIdPattern.test(characterId) || characterId === "npc") errors.push(`${colorPath} 的角色 ID 无效`);
    if (!/^#[0-9A-Fa-f]{6}$/.test(color ?? "")) errors.push(`${colorPath} 必须是 #RRGGBB`);
  }
  return errors;
}
