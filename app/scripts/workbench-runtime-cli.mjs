import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalConfig } from "../server/http-support.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const appRoot = path.resolve(path.dirname(scriptFile), "..");

export async function probeWorkbench({ port, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    return { status: "stopped" };
  }
  if (!response.ok) return { status: "occupied" };
  try {
    const health = await response.json();
    return health?.service === "story-canvas" && health?.ok === true
      ? { status: "running" }
      : { status: "occupied" };
  } catch {
    return { status: "occupied" };
  }
}

async function main() {
  const command = process.argv[2];
  if (command !== "check" && command !== "target") throw new Error("只支持 check 或 target");
  const config = await loadLocalConfig(appRoot);
  const port = Number(config.port ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("工作台端口配置无效");
  if (command === "target") {
    console.log(`http://127.0.0.1:${port}`);
    return;
  }
  const result = await probeWorkbench({ port });
  if (result.status === "running") {
    console.log(`StoryCanvas already running: http://127.0.0.1:${port}/`);
    return;
  }
  if (result.status === "occupied") {
    console.error(`Port ${port} is occupied by another service.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) await main();
