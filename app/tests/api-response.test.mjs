import assert from "node:assert/strict";
import test from "node:test";

import { responseJson, ProjectRefreshRequiredError, workbenchResponseJson } from "../src/api-response.ts";

test("失败响应不让空 details 吞掉具体 message 或 error", async () => {
  await assert.rejects(
    () => responseJson(new Response(JSON.stringify({
      error: "render_plan_compilation_failed",
      message: "当前渲染配置不可用",
      details: [],
    }), { status: 422 })),
    { message: "当前渲染配置不可用" },
  );

  await assert.rejects(
    () => responseJson(new Response(JSON.stringify({
      error: "render_plan_compilation_failed",
      details: [],
    }), { status: 422 })),
    { message: "render_plan_compilation_failed" },
  );
});

test("失败响应的非空 details 优先于概括消息", async () => {
  await assert.rejects(
    () => responseJson(new Response(JSON.stringify({
      error: "pages_not_ready",
      message: "页面尚未就绪",
      details: ["主体缺少 Prompt", "角色 LoRA 缺失"],
    }), { status: 422 })),
    { message: "主体缺少 Prompt；角色 LoRA 缺失" },
  );
});

test("项目 revision 冲突只返回刷新提示，不触发读取", async () => {
  await assert.rejects(
    () => responseJson(new Response(JSON.stringify({ error: "project_revision_conflict" }), { status: 409 })),
    { message: "项目内容已更新，请刷新页面后继续" },
  );
  await assert.rejects(
    () => workbenchResponseJson(new Response(JSON.stringify({ error: "story_edit_target_busy", details: ["page-001"] }), { status: 409 })),
    { message: "操作正在进行，请稍后再试" },
  );
});

test("由写入口标记的过期保存静默终止，不能被当成保存成功", async () => {
  for (const parse of [responseJson, workbenchResponseJson]) {
    await assert.rejects(() => parse(new Response("{}", { status: 409, headers: { "x-story-canvas-refresh-required": "true" } })),
      (error) => error instanceof ProjectRefreshRequiredError && error.message === "");
  }
});
