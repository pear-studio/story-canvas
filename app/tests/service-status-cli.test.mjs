import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { checkServices } from "../scripts/service-status-cli.mjs";

async function localServices(context, healthy) {
  const server = createServer((request, response) => {
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/health"
      ? { ok: true, service: "story-canvas" }
      : { system: { argv: ["main.py"], comfyui_version: "0.33.0" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const port = server.address().port;
  return { port, comfyui_urls: [`http://127.0.0.1:${port}`] };
}

function tailscaleFixture(port, connected) {
  return async (args) => {
    if (args.join(" ") === "status --json") {
      return { BackendState: connected ? "Running" : "Stopped", Self: { DNSName: "test.example.ts.net." } };
    }
    assert.deepEqual(args, ["serve", "status", "--json"], "检查只能读取 Tailscale 状态");
    return {
      TCP: { 443: { HTTPS: true }, 8188: { TCPForward: `127.0.0.1:${port}` } },
      Web: { "test.example.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
    };
  };
}

test("检查本机健康接口并展示实际 Serve 域名、转发目标和 ComfyUI 浏览器地址", async (context) => {
  const config = await localServices(context, true);
  const lines = [];
  assert.equal(await checkServices({ config, tailscale: tailscaleFixture(config.port, true), write: (line) => lines.push(line) }), true);
  assert.ok(lines.includes(`工作台：在线 — http://127.0.0.1:${config.port}/`));
  assert.ok(lines.includes(`ComfyUI：在线（0.33.0） — http://127.0.0.1:${config.port}`));
  assert.ok(lines.includes("连接：已连接"));
  assert.ok(lines.includes(`https://test.example.ts.net/ -> http://127.0.0.1:${config.port}`));
  assert.ok(lines.includes(`ComfyUI：http://test.example.ts.net:8188 -> 127.0.0.1:${config.port}`));
});

test("服务未就绪且 Tailscale 断开时仍显示保留映射，不误报可用", async (context) => {
  const config = await localServices(context, false);
  const lines = [];
  assert.equal(await checkServices({ config, tailscale: tailscaleFixture(config.port, false), write: (line) => lines.push(line) }), false);
  assert.ok(lines.includes(`工作台：响应不是健康的工作台 — http://127.0.0.1:${config.port}/`));
  assert.ok(lines.includes(`ComfyUI：无法连接或服务未就绪 — http://127.0.0.1:${config.port}`));
  assert.ok(lines.includes("连接：未连接（Stopped）"));
  assert.ok(lines.includes(`https://test.example.ts.net/ -> http://127.0.0.1:${config.port}`));
  assert.match(lines.at(-1), /映射存在不代表目标服务在线/);
});
