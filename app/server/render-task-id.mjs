import { randomUUID } from "node:crypto";

export const renderTaskIdPattern = /^render-\d{8}T\d{6}Z(?:-[a-f0-9]{8})?$/;

export function createRenderTaskId({
  now = () => new Date(),
  randomSuffix = () => randomUUID().slice(0, 8),
} = {}) {
  const timestamp = now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = randomSuffix();
  if (!/^[a-f0-9]{8}$/.test(suffix)) throw new Error("渲染任务随机后缀无效");
  return `render-${timestamp}-${suffix}`;
}

