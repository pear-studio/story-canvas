import { ApiError } from './http-support.mjs';

// 业务约束的 409 不属于过时草稿；只有读据/依赖比较失败使用此标记。
export function factConflict(code, details = []) {
  return Object.assign(new ApiError(409, code, details), { refresh_required: true });
}
