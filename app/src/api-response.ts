type ApiErrorPayload = {
  error?: string;
  message?: string;
  details?: unknown;
  saved?: boolean;
  refresh_required?: boolean;
};

export const PROJECT_REVISION_CONFLICT_MESSAGE = "项目内容已更新，请刷新页面后继续";
export const WORKBENCH_CONFLICT_MESSAGE = "当前操作无法完成";

// 区分过期提交被拒绝与已保存但回执读取失败，两者都需要载入最新事实。
export class ProjectRefreshRequiredError extends Error {
  saved: boolean;
  constructor(saved = false) {
    super(saved ? '修改已保存，但最新内容读取失败，请重新载入，不要重复提交' : '内容已更新，本次修改未保存，请载入最新内容后重新编辑');
    this.name = 'ProjectRefreshRequiredError'; this.saved = saved;
  }
}

export async function workbenchResponseJson<T>(response: Response): Promise<T> {
  if (response.headers.get("x-story-canvas-refresh-required") === "true") throw new ProjectRefreshRequiredError();
  if (response.status === 409) {
    const payload = await response.json().catch(() => null) as { error?: unknown; details?: unknown } | null;
    const code = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : null;
    if (code === "story_edit_target_busy") throw new Error("操作正在进行，请稍后再试");
    if (code === "candidate_file_busy") throw new Error("移动候选文件失败，已短时重试；可能是文件占用或权限问题，可继续其他工作，无需等待生成结束");
    if (code === "candidate_generation_signature_stale") throw new Error("当前生成条件已变化，请重新扫描后确认");
    if (code === "page_content_prompt_reference_conflict") {
      throw new Error("页面 Prompt 仍引用待移除的出场角色；请先在 Prompt 中解除对应角色绑定并保存");
    }
    if (code === "page_content_lettering_reference_conflict") {
      throw new Error("嵌字布局仍引用待移除的对白；请先在“嵌字”中移除对应文字并保存布局");
    }
    throw new Error(`${WORKBENCH_CONFLICT_MESSAGE}${code ? `（${code}）` : ""}`);
  }
  return responseJson<T>(response);
}

export async function responseJson<T>(response: Response): Promise<T> {
  if (response.headers.get("x-story-canvas-refresh-required") === "true") throw new ProjectRefreshRequiredError();
  const result = await response.json() as T & ApiErrorPayload;
  if (response.ok && result.saved && result.refresh_required) throw new ProjectRefreshRequiredError(true);
  if (!response.ok) {
    if (response.status === 409 && result.error === "project_revision_conflict") {
      throw new Error(PROJECT_REVISION_CONFLICT_MESSAGE);
    }
    const details = Array.isArray(result.details)
      ? result.details.filter((detail): detail is string => typeof detail === "string" && detail.trim().length > 0)
      : [];
    const message = details.length > 0
      ? details.join("；")
      : result.message?.trim() || result.error?.trim() || String(response.status);
    throw new Error(message);
  }
  return result;
}
