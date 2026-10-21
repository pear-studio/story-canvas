import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadLocalConfig } from "../server/http-support.mjs";
import { createComfyEndpointSelector } from "../server/comfy-endpoint-selector.mjs";

const temporaryRoot = fileURLToPath(new URL("../../Saved/Tests/", import.meta.url));

async function fixture(context) {
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, "local-config-"));
  context.after(async () => {
    assert.equal(path.dirname(root), path.resolve(temporaryRoot));
    await rm(root, { recursive: true, force: true });
  });
  return {
    appRoot: path.join(root, "app"),
    async write(name, text) {
      await mkdir(path.join(root, "Config"), { recursive: true });
      await writeFile(path.join(root, "Config", name), text);
    },
  };
}

test("无端点文件时仍可启动，只有本机直连配置时使用直连地址", async (context) => {
  const f = await fixture(context);
  const empty = await loadLocalConfig(f.appRoot);
  assert.deepEqual(empty.comfyui_urls, []);
  const selector = createComfyEndpointSelector({
    urls: empty.comfyui_urls,
    probe: async () => assert.fail("未配置时不能发起网络探测"),
  });
  assert.equal((await selector.refresh()).reason, "not_configured");

  await f.write("local.json", JSON.stringify({ port: 3100, comfyui_urls: ["http://127.0.0.1:8188"] }));
  const local = await loadLocalConfig(f.appRoot);
  assert.equal(local.port, 3100);
  assert.deepEqual(local.comfyui_urls, ["http://127.0.0.1:8188"]);
});

test("私有端点文件独立加载并保留优先级，无 local.json 时也可使用", async (context) => {
  const f = await fixture(context);
  await f.write("comfyui-endpoints.json", JSON.stringify([
    "http://renderer-a.example.invalid:8188/",
    "https://renderer-b.example.invalid:8188",
    "http://renderer-a.example.invalid:8188",
  ]));
  const shared = await loadLocalConfig(f.appRoot);
  assert.deepEqual(shared.comfyui_urls, [
    "http://renderer-a.example.invalid:8188",
    "https://renderer-b.example.invalid:8188",
  ]);
  await f.write("local.json", JSON.stringify({ comfyui_urls: ["http://127.0.0.1:8288"] }));
  assert.deepEqual((await loadLocalConfig(f.appRoot)).comfyui_urls, [
    ...shared.comfyui_urls, "http://127.0.0.1:8288",
  ]);
});

test("端点文件错误明确报错，不能作为未配置静默忽略", async (context) => {
  const f = await fixture(context);
  await f.write("comfyui-endpoints.json", "[");
  await assert.rejects(loadLocalConfig(f.appRoot), /comfyui-endpoints\.json 不是有效 JSON/);
  for (const invalid of [{}, null, [123], [""], ["not-a-url"], ["file:///tmp/service"]]) {
    await f.write("comfyui-endpoints.json", JSON.stringify(invalid));
    await assert.rejects(loadLocalConfig(f.appRoot), /comfyui-endpoints\.json 必须是 HTTP\(S\) 地址数组/);
  }
});
