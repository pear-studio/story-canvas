type ApiErrorPayload = {
  error?: string;
  message?: string;
  details?: unknown;
};

export const PROJECT_REVISION_CONFLICT_MESSAGE = "项目内容已更新，请刷新页面后继续";
export const WORKBENCH_CONFLICT_MESSAGE = "当前操作无法完成";

// 旧保存已被拒绝；根组件会载入最新事实。不是成功保存，也不要求用户选择冲突版本。
export class ProjectRefreshRequiredError extends Error {
  constructor() { super(""); this.name = "ProjectRefreshRequiredError"; }
}

export async function workbenchResponseJson<T>(response: Response): Promise<T> {
  if (response.headers.get("x-story-canvas-refresh-required") === "true") throw new ProjectRefreshRequiredError();
  if (response.status === 409) {
    const payload = await response.json().catch(() => null) as { error?: unknown; details?: unknown } | null;
    const code = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : null;
    if (code === "story_edit_target_busy") throw new Error("操作正在进行，请稍后再试");
    if (code === "candidate_task_active") throw new Error("该候选所属任务仍在运行，请等待任务结束后再删除");
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
