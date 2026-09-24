import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { CAMERA_DEFAULTS, changeCameraPerspective, changeCameraView, createCameraFragment, parseCameraSettings } from "../shared/camera-prompt.mjs";
import { applyCameraDraft } from "../src/camera-prompt-draft.ts";

const cwd = new URL("../../", import.meta.url);
const run = (...args) => JSON.parse(execFileSync(process.execPath, ["app/scripts/camera-prompt.mjs", ...args], { cwd, encoding: "utf8" }));

test("固定配方逐项输出裸词并按顺序连接", () => {
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, direction: "front" }).description, "from front");
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, direction: "side" }).description, "from side");
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, direction: "back" }).description, "from behind");
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, height: "above" }).description, "from above");
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, height: "below" }).description, "from below");
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, shot: "特写" }).description, "extreme close-up");
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, view: "pov" }).description, "pov");
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, view: "female_pov" }).description, "female pov");
  assert.equal(createCameraFragment({ ...CAMERA_DEFAULTS, view: "over_shoulder" }).description, "over-the-shoulder shot");
  assert.equal(createCameraFragment(CAMERA_DEFAULTS).description, "");
  const full = { direction: "side", height: "above", shot: "中景", view: "pov", hands: true, legs: true, shadow: true, perspective: true, foreshortening: true, backgroundBlur: true, foregroundBlur: true };
  assert.equal(createCameraFragment(full).description, "from side, from above, medium shot, pov, pov hands, pov legs, pov shadow, perspective, foreshortening, blurry background, blurry foreground");
});

test("机位独立字段往返恢复，非法枚举与多余字段不能恢复", () => {
  const settings = { ...CAMERA_DEFAULTS, direction: "side", shot: "中景", view: "female_pov", hands: true };
  const fragment = createCameraFragment(settings);
  assert.deepEqual(fragment.camera_settings, settings);
  assert.deepEqual(parseCameraSettings(fragment.camera_settings), settings);
  assert.equal(parseCameraSettings({ ...settings, direction: "diagonal" }), null);
  assert.equal(parseCameraSettings({ ...settings, hands: "unknown" }), null);
  assert.equal(parseCameraSettings({ ...settings, extra: true }), null);
  assert.equal(parseCameraSettings(null), null);
});

test("CLI 与共享模块输出一致，--from 恢复与失败回退", () => {
  const settings = { ...CAMERA_DEFAULTS, direction: "back", height: "below", shot: "近景" };
  const fragment = createCameraFragment(settings);
  assert.deepEqual(run("--direction", "back", "--height", "below", "--shot", "近景").fragment, fragment);
  const restored = run("--from", JSON.stringify(fragment.camera_settings), "--direction", "none");
  assert.equal(restored.fragment.description, "from below, close-up");
  assert.equal(restored.settings.direction, null);
  const fallback = run("--from", "{}");
  assert.deepEqual(fallback.settings, CAMERA_DEFAULTS);
  assert.match(fallback.warning, /初始设置/);
});

test("枚举非法时 CLI 报错退出", () => {
  assert.throws(() => run("--direction", "diagonal"), /请选择有效方向/);
  assert.throws(() => run("--shot", "大全景"), /请选择有效景别/);
  assert.throws(() => run("--hands", "yes"), /布尔值/);
});

test("应用草稿新增、替换保留 ID、清空移除标记片段", () => {
  const manual = { id: "manual", prompt_type: "custom_description", prompt_text: "shallow depth of field" };
  const marked = { id: "token-camera", prompt_type: "custom_description", camera_settings: { ...CAMERA_DEFAULTS }, prompt_text: "old", enabled: false, weight: 2, role: "person" };
  const draft = { camera: [manual, marked], person: [{ id: "action", prompt_text: "standing" }] };
  const before = structuredClone(draft);
  const selected = { ...CAMERA_DEFAULTS, direction: "front", shot: "中景" };
  const result = applyCameraDraft(draft, selected, () => { throw new Error("不应分配新 ID"); });
  assert.deepEqual(draft, before);
  assert.equal(result.camera[0], manual);
  assert.equal(result.person, draft.person);
  assert.deepEqual(result.camera[1], { id: "token-camera", prompt_type: "custom_description", camera_settings: createCameraFragment(selected).camera_settings, prompt_text: "from front, medium shot" });
  const added = applyCameraDraft({ camera: [manual] }, selected, () => ({ id: "new" }));
  assert.equal(added.camera[1].id, "new");
  assert.equal(applyCameraDraft(added, selected, () => { throw new Error("不应重复新增"); }).camera.length, 2);
  const cleared = applyCameraDraft(added, CAMERA_DEFAULTS, () => { throw new Error("不应创建"); });
  assert.deepEqual(cleared.camera, [manual]);
  const untouched = { camera: [manual] };
  assert.equal(applyCameraDraft(untouched, CAMERA_DEFAULTS, () => { throw new Error("不应创建"); }), untouched);
});

test("观察视角控制入镜，切换或取消视角清空入镜", () => {
  const settings = { ...CAMERA_DEFAULTS, view: "pov", hands: true, legs: true, shadow: true };
  const fragment = createCameraFragment(settings);
  assert.equal(fragment.description, "pov, pov hands, pov legs, pov shadow");
  assert.deepEqual(parseCameraSettings(fragment.camera_settings), settings);
  assert.equal(createCameraFragment(changeCameraView(settings, "female_pov")).description, "female pov, pov hands, pov legs, pov shadow");
  assert.equal(createCameraFragment(changeCameraView(settings, "over_shoulder")).description, "over-the-shoulder shot");
  assert.equal(createCameraFragment(changeCameraView(settings, null)).description, "");
  assert.throws(() => createCameraFragment({ ...settings, view: null }), /需要第一人称/);
  const output = run("--view", "female_pov", "--hands", "true", "--shadow", "true");
  assert.equal(output.fragment.description, "female pov, pov hands, pov shadow");
  const cleared = run("--from", JSON.stringify(fragment.camera_settings), "--view", "none");
  assert.equal(cleared.fragment.description, "");
  assert.equal(cleared.settings.hands, false);
});

test("透视缩短依赖透视，虚化独立组合", () => {
  const settings = { ...CAMERA_DEFAULTS, perspective: true, foreshortening: true, backgroundBlur: true };
  const fragment = createCameraFragment(settings);
  assert.equal(fragment.description, "perspective, foreshortening, blurry background");
  assert.deepEqual(parseCameraSettings(fragment.camera_settings), settings);
  assert.equal(createCameraFragment(changeCameraPerspective(settings, false)).description, "blurry background");
  assert.throws(() => createCameraFragment({ ...settings, perspective: false }), /需要启用透视/);
  assert.deepEqual(run("--perspective", "true", "--foreshortening", "true", "--background-blur", "true").fragment, fragment);
  assert.throws(() => run("--foreshortening", "true"), /需要启用透视/);
});
