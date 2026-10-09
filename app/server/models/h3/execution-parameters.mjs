// 预检与冻结工作流共用尺寸计算，不以基础 recipe 尺寸冒充视频实际尺寸。
export function h3ExecutionParameters(video, input = {}, dimensions = {}) {
  let { width, height } = dimensions;
  if (input.width && input.height) {
    const ratio = input.width / input.height;
    const short = video.quality === 'preview' ? 576 : 768;
    width = ratio >= 1 ? short * ratio : short;
    height = ratio >= 1 ? short : short / ratio;
    const scale = Math.min(1, Math.sqrt((768 * 1344) / (width * height)));
    width = Math.max(32, Math.floor(width * scale / 32) * 32);
    height = Math.max(32, Math.floor(height * scale / 32) * 32);
  } else if (video.quality === 'preview') {
    width = Math.round(width * .75 / 32) * 32;
    height = Math.round(height * .75 / 32) * 32;
  }
  return { dimensions: { width, height }, steps: video.steps, video: { ...video } };
}
