import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function requestWorkbench(route, { method = "GET", body, revision } = {}) {
  if (!route.startsWith("/api/")) throw new Error("请求路径必须以 /api/ 开头");
  const config = await readFile(path.join(appRoot, "..", "Config", "local.json"), "utf8")
    .then(JSON.parse, error => error.code === "ENOENT" ? {} : Promise.reject(error));
  const port = Number(config.port ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("工作台端口配置无效");
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(revision ? { "x-story-canvas-expected-revision": revision } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw Object.assign(new Error("无法连接本地工作台，请先启动 npm --prefix app run dev 或 start"), { code: "workbench_unavailable", cause });
  }
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message ?? value.error), { code: value.error, status: response.status, details: value.details });
  return { value, revision: response.headers.get("x-story-canvas-revision") };
}

export const projectRoute = id => `/api/projects/${encodeURIComponent(id)}`;
export async function navigation(projectId, action, body) {
  const { value } = await requestWorkbench(`${projectRoute(projectId)}/revision`);
  return (await requestWorkbench(`${projectRoute(projectId)}/workbench/navigation/${action}`, { method: "POST", body, revision: value.revision })).value;
}

export async function readJsonInput(source) {
  let text;
  if (source === "-") {
    process.stdin.setEncoding("utf8");
    text = "";
    for await (const chunk of process.stdin) text += chunk;
  } else text = await readFile(source, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export async function factCommand(domain, kind, action, args) {
  const body = action === "read" ? { project_id: args[0], target_id: args[1] } : await readJsonInput(args[0]);
  const { value } = await requestWorkbench(`/api/agent/facts/${domain}/${kind}/${action}`, { method: "POST", body });
  return value;
}

export function printResult(value) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

export function runCommand(main) {
  main().then(printResult).catch(error => {
    console.error(JSON.stringify({ error: error.code ?? "command_failed", message: error.message,
      ...(error.status ? { status: error.status } : {}), ...(error.details === undefined ? {} : { details: error.details }) }));
    process.exitCode = 1;
  });
}
