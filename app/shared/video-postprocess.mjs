export const defaultVideoPostprocess = Object.freeze({ trim_start_seconds: 0, trim_end_seconds: 0, speed: 1 });

export function normalizeVideoPostprocess(value = defaultVideoPostprocess) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(defaultVideoPostprocess, key))) throw new TypeError('动态后处理设置无效');
  const result = { ...defaultVideoPostprocess, ...value };
  for (const key of ['trim_start_seconds', 'trim_end_seconds']) {
    if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < 0 || result[key] > 3600) throw new TypeError('首尾裁剪秒数必须在 0–3600 之间');
  }
  if (typeof result.speed !== 'number' || !Number.isFinite(result.speed) || result.speed < .1 || result.speed > 4
    || Math.abs(result.speed * 10 - Math.round(result.speed * 10)) > 1e-8) throw new TypeError('播放倍率必须为 0.1–4.0，步长为 0.1');
  result.speed = Math.round(result.speed * 10) / 10;
  return result;
}

export function hasVideoPostprocess(value) {
  const edit = normalizeVideoPostprocess(value);
  return edit.trim_start_seconds !== 0 || edit.trim_end_seconds !== 0 || edit.speed !== 1;
}

// 首尾裁剪对齐最近的原片帧；预览和输出都采用相同帧区间。
export function videoPostprocessTiming(video, value) {
  const edit = normalizeVideoPostprocess(value);
  if (!Number.isInteger(video?.frames) || video.frames < 1 || !Number.isFinite(video.fps) || video.fps <= 0) throw new TypeError('视频帧数或帧率无效');
  const start = Math.floor(edit.trim_start_seconds * video.fps + .5);
  const end = video.frames - Math.floor(edit.trim_end_seconds * video.fps + .5);
  if (end <= start) throw new TypeError('裁剪后至少需要保留一帧，请减少开头或结尾裁剪');
  return { start_frame: start, end_frame: end, frames: end - start, fps: video.fps * edit.speed, duration_seconds: (end - start) / (video.fps * edit.speed) };
}
