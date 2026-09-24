#!/usr/bin/env node
import { CAMERA_DEFAULTS, changeCameraPerspective, changeCameraView, createCameraFragment, parseCameraSettings } from "../shared/camera-prompt.mjs";

// 仅输出片段，项目写入继续使用现有 read/save；不直接写项目 JSON。
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log('用法: npm --prefix app run camera:prompt -- --direction side --height above --shot 中景\n方向: --direction front|side|back|none；高度: --height above|below|none；景别: --shot 特写|近景|中景|全身|远景|none\n观察视角: --view pov|female_pov|over_shoulder|none；入镜: --hands true|false --legs true|false --shadow true|false\n效果: --perspective true|false --foreshortening true|false --background-blur true|false --foreground-blur true|false\n恢复设置: --from <camera_settings的JSON>，可继续用参数覆盖；方向、高度、景别与视角可传 none 取消。所有词条均为裸词，不带权重。输出 JSON 的 fragment 用于页面 camera 数组，已有片段保留 ID；description 为空时移除标记片段。');
  } else {
    const options = {};
    const keys = { "--direction": "direction", "--height": "height", "--shot": "shot", "--view": "view", "--hands": "hands", "--legs": "legs", "--shadow": "shadow", "--perspective": "perspective", "--foreshortening": "foreshortening", "--background-blur": "backgroundBlur", "--foreground-blur": "foregroundBlur" };
    let settings = { ...CAMERA_DEFAULTS }, warning;
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (value === undefined || (!Object.hasOwn(keys, key) && key !== "--from")) throw new Error(`未知参数或缺少值: ${key}`);
      if (key === "--from") {
        let parsed;
        try { parsed = parseCameraSettings(JSON.parse(value)); } catch { parsed = null; }
        if (!parsed) warning = "无法解析现有机位设置，已使用初始设置；应用时将覆盖。";
        settings = { ...(parsed ?? CAMERA_DEFAULTS) };
      } else options[keys[key]] = value === "none" ? null : ["--hands", "--legs", "--shadow", "--perspective", "--foreshortening", "--background-blur", "--foreground-blur"].includes(key) ? value === "true" ? true : value === "false" ? false : value : value;
    }
    if (Object.hasOwn(options, "view")) settings = changeCameraView(settings, options.view);
    if (Object.hasOwn(options, "perspective")) settings = changeCameraPerspective(settings, options.perspective);
    Object.assign(settings, options);
    console.log(JSON.stringify({ settings, ...(warning ? { warning } : {}), fragment: createCameraFragment(settings) }, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
