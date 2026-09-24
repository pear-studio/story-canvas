export const CAMERA_MARKER = "[机位]";
// 机位参数独立保存，不占用 Prompt 的界面注释。
export const CAMERA_DIRECTIONS = Object.freeze({ front: "正面", side: "侧面", back: "背面" });
export const CAMERA_HEIGHTS = Object.freeze({ above: "俯视", below: "仰视" });
export const CAMERA_SHOTS = Object.freeze({ "特写": "extreme close-up", "近景": "close-up", "中景": "medium shot", "全身": "full body", "远景": "wide shot" });
export const CAMERA_VIEWS = Object.freeze({ pov: "第一人称", female_pov: "女性第一人称", over_shoulder: "越肩" });
export const CAMERA_BODY = Object.freeze({ hands: "手", legs: "腿 / 脚", shadow: "影子" });
export const CAMERA_EFFECTS = Object.freeze({ perspective: { label: "强调透视", word: "perspective" }, foreshortening: { label: "透视缩短", word: "foreshortening" }, backgroundBlur: { label: "背景虚化", word: "blurry background" }, foregroundBlur: { label: "前景虚化", word: "blurry foreground" } });
export function changeCameraPerspective(settings, perspective) { return { ...settings, perspective, ...(perspective ? {} : { foreshortening: false }) }; }
export function changeCameraView(settings, view) {
  return { ...settings, view, ...(view === "pov" || view === "female_pov" ? {} : { hands: false, legs: false, shadow: false }) };
}
export const CAMERA_DEFAULTS = Object.freeze({ direction: null, height: null, shot: null, view: null, hands: false, legs: false, shadow: false, perspective: false, foreshortening: false, backgroundBlur: false, foregroundBlur: false });

export function validateCameraSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || Object.keys(settings).some(key => !Object.hasOwn(CAMERA_DEFAULTS, key))) throw new Error("机位参数字段无效");
  if (settings.direction !== null && !Object.hasOwn(CAMERA_DIRECTIONS, settings.direction)) throw new Error("请选择有效方向");
  if (settings.height !== null && !Object.hasOwn(CAMERA_HEIGHTS, settings.height)) throw new Error("请选择有效高度");
  if (settings.shot !== null && !Object.hasOwn(CAMERA_SHOTS, settings.shot)) throw new Error("请选择有效景别");
  if (settings.view !== null && !Object.hasOwn(CAMERA_VIEWS, settings.view)) throw new Error("请选择有效观察视角");
  for (const key of Object.keys(CAMERA_BODY)) {
    if (typeof settings[key] !== "boolean") throw new Error("入镜选项必须为布尔值");
    if (settings[key] && settings.view !== "pov" && settings.view !== "female_pov") throw new Error("观察者入镜需要第一人称视角");
  }
  for (const key of Object.keys(CAMERA_EFFECTS)) if (typeof settings[key] !== "boolean") throw new Error("镜头效果必须为布尔值");
  if (settings.foreshortening && !settings.perspective) throw new Error("透视缩短需要启用透视");
  return settings;
}

export function parseCameraSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try { return { ...validateCameraSettings(value) }; } catch { return null; }
}

export function createCameraFragment(settings) {
  validateCameraSettings(settings);
  const parts = [];
  if (settings.direction !== null) parts.push({ front: "from front", side: "from side", back: "from behind" }[settings.direction]);
  if (settings.height !== null) parts.push({ above: "from above", below: "from below" }[settings.height]);
  if (settings.shot !== null) parts.push(CAMERA_SHOTS[settings.shot]);
  if (settings.view !== null) parts.push({ pov: "pov", female_pov: "female pov", over_shoulder: "over-the-shoulder shot" }[settings.view]);
  for (const key of Object.keys(CAMERA_BODY)) if (settings[key]) parts.push(`pov ${key}`);
  for (const [key, effect] of Object.entries(CAMERA_EFFECTS)) if (settings[key]) parts.push(effect.word);
  return { description: parts.join(", "), camera_settings: { ...settings } };
}

export function cameraFragmentIndex(fragments) {
  return fragments.findIndex(fragment => fragment.camera_settings !== undefined);
}
