import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredComfyUiUrls,
  createComfyEndpointSelector,
  primaryComfyUiUrl,
  resolveComfyUiUrls,
} from "../server/comfy-endpoint-selector.mjs";

test("ComfyUI 刷新并行扫描全部地址并允许选择任一在线实例", async () => {
  const calls = [];
  let primaryOnline = false;
  const selector = createComfyEndpointSelector({
    urls: ["http://primary:8188/", "http://backup:8188", "http://backup:8188"],
    clock: () => 1_000,
    probe: async (url) => {
      calls.push(url);
      if (url === "http://primary:8188" && !primaryOnline) throw new Error("offline");
      return { version: url.includes("primary") ? "primary-version" : "backup-version" };
    },
  });

  assert.equal(selector.currentUrl(), "http://primary:8188");
  assert.equal(selector.status().status, "checking");
  assert.deepEqual(calls, []);

  assert.deepEqual(await selector.refresh(), {
    status: "available", reason: null, url: "http://backup:8188",
    endpoint_index: 1, endpoint_count: 2, version: "backup-version",
    checked_at: "1970-01-01T00:00:01.000Z",
  });
  assert.deepEqual(new Set(calls), new Set(["http://primary:8188", "http://backup:8188"]));
  assert.deepEqual(selector.endpoints().map(({ url, status }) => ({ url, status })), [
    { url: "http://primary:8188", status: "unavailable" },
    { url: "http://backup:8188", status: "available" },
  ]);

  primaryOnline = true;
  assert.equal(selector.currentUrl(), "http://backup:8188", "状态读取不能自动改选地址");
  await selector.refresh();
  assert.equal(selector.currentUrl(), "http://backup:8188", "刷新后保留仍在线的用户选择");
  assert.deepEqual(selector.select("http://primary:8188"), {
    selected: true,
    endpoint: { status: "available", reason: null, url: "http://primary:8188", endpoint_index: 0, endpoint_count: 2, version: "primary-version", checked_at: "1970-01-01T00:00:01.000Z" },
  });
  assert.equal(selector.currentUrl(), "http://primary:8188");
  assert.deepEqual(selector.select("http://missing:8188"), { selected: false, reason: "not_found" });
});

test("ComfyUI 配置只保留有序且去重的非空地址", () => {
  const config = { comfyui_urls: [" http://first:8188/ ", "", "http://first:8188", "http://second:8188/"] };
  assert.deepEqual(configuredComfyUiUrls(config), ["http://first:8188", "http://second:8188"]);
  assert.equal(primaryComfyUiUrl(config), "http://first:8188");
});

test("共享地址在当前生成设备上以本机直连替代自己的 Tailscale 地址", () => {
  const sharedUrls = [
    "http://desktop-home.tail6c2b26.ts.net:8188",
    "http://gih-d-27166.tail6c2b26.ts.net:8188",
  ];

  assert.deepEqual(resolveComfyUiUrls({
    sharedUrls,
    localUrls: ["http://127.0.0.1:8288"],
    hostName: "GIH-D-27166",
  }), [
    "http://desktop-home.tail6c2b26.ts.net:8188",
    "http://127.0.0.1:8288",
  ]);
  assert.deepEqual(resolveComfyUiUrls({
    sharedUrls,
    localUrls: ["http://127.0.0.1:8188"],
    hostName: "Desktop_Home",
  }), [
    "http://127.0.0.1:8188",
    "http://gih-d-27166.tail6c2b26.ts.net:8188",
  ]);
  assert.deepEqual(resolveComfyUiUrls({
    sharedUrls,
    hostName: "VM-0-5-ubuntu",
  }), sharedUrls);
});
