import assert from "node:assert/strict";
import test from "node:test";

import { comfyRuntimePresentation, stabilizeComfyRuntimeProbe } from "../src/comfy-runtime-status.ts";

const unavailable = (reason) => ({ status: "unavailable", reason, pid: null, version: null });

test("ComfyUI 启动中状态覆盖旧探针结果并持续显示等待时间", () => {
  assert.deepEqual(comfyRuntimePresentation({
    status: unavailable("endpoint_unavailable"),
    action: "start",
    elapsedSeconds: 18,
  }), {
    tone: "warning",
    summary: "ComfyUI 正在启动",
    detail: "已等待 18 秒，启动后会自动确认",
    canStart: false,
    canStop: false,
    busy: true,
    remote: false,
  });
});

test("ComfyUI 已确认运行时直接显示版本和进程身份", () => {
  assert.deepEqual(comfyRuntimePresentation({
    status: { status: "available", reason: null, pid: 24680, version: "0.33.0" },
  }), {
    tone: "normal",
    summary: "ComfyUI 运行中",
    detail: "0.33.0 · PID 24680",
    canStart: false,
    canStop: true,
    busy: false,
    remote: false,
  });
});

test("ComfyUI 可启动的停止状态与需要排查的身份异常明确区分", () => {
  assert.equal(comfyRuntimePresentation({ status: unavailable("listener_not_found") }).summary, "ComfyUI 未启动");
  assert.equal(comfyRuntimePresentation({ status: unavailable("listener_not_found") }).canStart, true);
  assert.deepEqual(comfyRuntimePresentation({ status: unavailable("process_identity_mismatch") }), {
    tone: "critical",
    summary: "ComfyUI 状态异常",
    detail: "ComfyUI 进程身份不符",
    canStart: false,
    canStop: false,
    busy: false,
    remote: false,
  });
});

test("ComfyUI 控制失败保持具体错误并允许按当前状态重试", () => {
  assert.deepEqual(comfyRuntimePresentation({
    status: unavailable("endpoint_unavailable"),
    failure: { action: "start", message: "comfy-cli 启动超时" },
  }), {
    tone: "critical",
    summary: "ComfyUI 启动失败",
    detail: "comfy-cli 启动超时",
    canStart: true,
    canStop: false,
    busy: false,
    remote: false,
  });
});

test("在线端点与不可管理的本机进程分开显示", () => {
  assert.deepEqual(comfyRuntimePresentation({
    status: {
      ...unavailable("process_identity_mismatch"),
      url: "http://127.0.0.1:8288",
      endpoints: [{ url: "http://127.0.0.1:8288", status: "available", version: "0.33.0" }],
    },
  }), {
    tone: "warning",
    summary: "ComfyUI 在线",
    detail: "0.33.0 · 生成可用，但无法管理本机进程",
    canStart: false,
    canStop: false,
    busy: false,
    remote: false,
  });
});

test("远程 ComfyUI 只显示连接状态且不提供本机启停操作", () => {
  assert.deepEqual(comfyRuntimePresentation({
    status: { status: "available", reason: "remote_instance", pid: null, version: "0.4.0", url: "http://windows-gpu:8188", endpoint_count: 2 },
  }), {
    tone: "normal",
    summary: "远程 ComfyUI 在线",
    detail: "windows-gpu:8188 · 0.4.0",
    canStart: false,
    canStop: false,
    busy: false,
    remote: true,
  });
  assert.deepEqual(comfyRuntimePresentation({ status: unavailable("remote_endpoint_unavailable") }), {
    tone: "critical",
    summary: "远程 ComfyUI 离线",
    detail: "无法连接配置的远程地址",
    canStart: false,
    canStop: false,
    busy: false,
    remote: true,
  });
  assert.equal(comfyRuntimePresentation({
    status: { ...unavailable("remote_endpoint_unavailable"), endpoint_count: 2 },
  }).detail, "2 个远程地址均不可用");
});

test("ComfyUI 探针刷新期间保留最近一次已确认运行状态，但不掩盖真正停止", () => {
  const confirmed = { status: "available", reason: null, pid: 24680, version: "0.33.0" };
  assert.equal(stabilizeComfyRuntimeProbe(confirmed, unavailable("process_metrics_unavailable")), confirmed);
  assert.equal(stabilizeComfyRuntimeProbe(confirmed, { status: "checking", reason: null, pid: null, version: null }), confirmed);
  assert.deepEqual(stabilizeComfyRuntimeProbe(confirmed, unavailable("endpoint_unavailable")), unavailable("endpoint_unavailable"));
  assert.equal(comfyRuntimePresentation({ status: unavailable("process_metrics_unavailable") }).summary, "ComfyUI 状态待确认");
});
