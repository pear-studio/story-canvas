import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { configuredComfyUiUrls } from "../server/comfy-endpoint-selector.mjs";
import { queryComfySystemStats, resolveLocalComfyTarget } from "../server/comfy-runtime.mjs";
import { loadLocalConfig } from "../server/http-support.mjs";
import { probeWorkbench } from "./workbench-runtime-cli.mjs";

const execFileAsync = promisify(execFile);
const scriptFile = fileURLToPath(import.meta.url);

async function readTailscale(args) {
  const { stdout } = await execFileAsync("tailscale", args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function checkServices({ config, tailscale = readTailscale, write = console.log }) {
  let ok = true;
  const port = Number(config.port ?? 3000);
  const comfyUrl = configuredComfyUiUrls(config).find((url) => resolveLocalComfyTarget(url, config.comfyui_root).target);
  write("本机服务（只读检查，不启动或关闭服务）");
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    const workbench = await probeWorkbench({ port });
    const state = { running: "在线", stopped: "无法连接", occupied: "响应不是健康的工作台" }[workbench.status];
    write(`工作台：${state} — http://127.0.0.1:${port}/`);
    if (workbench.status !== "running") ok = false;
  } else {
    write("工作台：本机端口配置无效");
    ok = false;
  }
  if (comfyUrl) {
    try {
      const stats = await queryComfySystemStats(comfyUrl);
      write(`ComfyUI：在线${stats.version ? `（${stats.version}）` : ""} — ${comfyUrl}`);
    } catch (error) {
      write(`ComfyUI：${error.code === "endpoint_unavailable" ? "无法连接或服务未就绪" : "响应不是有效的 ComfyUI"} — ${comfyUrl}`);
      ok = false;
    }
  } else {
    write("ComfyUI：未配置本机地址（不检测远程设备）");
  }

  write("\nTailscale");
  let dnsName = "";
  try {
    const status = await tailscale(["status", "--json"]);
    dnsName = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
    write(`连接：${status.BackendState === "Running" ? "已连接" : `未连接（${status.BackendState ?? "未知"}）`}`);
    if (status.BackendState !== "Running") ok = false;
  } catch (error) {
    write(`连接：无法读取，请检查 Tailscale 是否已安装并运行。${error.message}`);
    ok = false;
  }

  write("\nServe 映射与访问地址");
  try {
    const serve = await tailscale(["serve", "status", "--json"]);
    let mappings = 0;
    for (const [authority, web] of Object.entries(serve?.Web ?? {})) {
      for (const [route, handler] of Object.entries(web.Handlers ?? {})) {
        if (!handler.Proxy) continue;
        const webPort = new URL(`https://${authority}`).port || "443";
        const protocol = serve.TCP?.[webPort]?.HTTPS ? "https" : "http";
        write(`${new URL(route, `${protocol}://${authority}`).href} -> ${handler.Proxy}`);
        mappings += 1;
      }
    }
    for (const [listenPort, tcp] of Object.entries(serve?.TCP ?? {})) {
      if (!tcp.TCPForward) continue;
      const comfyTarget = comfyUrl ? new URL(comfyUrl) : null;
      const isComfy = comfyTarget && tcp.TCPForward === `127.0.0.1:${comfyTarget.port || "80"}`;
      const source = dnsName ? `${isComfy ? "http" : "tcp"}://${dnsName}:${listenPort}` : `端口 ${listenPort}（本机域名未知）`;
      write(`${isComfy ? "ComfyUI：" : ""}${source} -> ${tcp.TCPForward}`);
      mappings += 1;
    }
    if (!mappings) {
      write("没有已配置的 Web/TCP 转发，请运行对应的配置脚本。");
      ok = false;
    }
  } catch (error) {
    write(`无法读取 Serve 配置：${error.message}`);
    ok = false;
  }
  write("\n映射存在不代表目标服务在线；本检查未验证手机或其他设备的访问权限与连通性。");
  return ok;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try {
    const config = await loadLocalConfig(path.resolve(path.dirname(scriptFile), ".."));
    process.exitCode = await checkServices({ config }) ? 0 : 1;
  } catch (error) {
    console.error(`检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
