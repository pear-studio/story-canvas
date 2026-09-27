import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 端口缺省仅用于字段缺失或配置不存在；无效 JSON、非法端口明确失败，不回退。
export function resolveWorkbenchPort(config) {
  const port = Number(config.port ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("工作台端口配置无效"), { code: "invalid_workbench_config" });
  }
  return port;
}

export async function loadWorkbenchConfig(repositoryRoot = path.resolve(appRoot, "..")) {
  const text = await readFile(path.join(repositoryRoot, "Config", "local.json"), "utf8")
    .catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (text === null) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Config/local.json 不是有效 JSON"), { code: "invalid_workbench_config" });
  }
}

export async function requestWorkbench(route, { method = "GET", body, revision, etag, signal } = {}) {
  if (!route.startsWith("/api/")) throw new Error("请求路径必须以 /api/ 开头");
  const port = resolveWorkbenchPort(await loadWorkbenchConfig());
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      signal,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(revision ? { "x-story-canvas-expected-revision": revision } : {}), ...(etag ? { 'if-match': etag } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw Object.assign(new Error("无法连接本地工作台，请先启动 npm --prefix app run dev 或 start"), { code: "workbench_unavailable", cause });
  }
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message ?? value.error), { code: value.error, status: response.status, details: value.details });
  return { value, revision: response.headers.get("x-story-canvas-revision"), ...(response.headers.has('etag') ? { etag: response.headers.get('etag') } : {}) };
}

// 领域与 kind 的合法性以服务端为准；路径片段作为单个编码片段构造，不拼接原始参数。
const factRoute = (domain, kind, action) =>
  `/api/agent/facts/${encodeURIComponent(domain)}/${encodeURIComponent(kind)}/${action}`;

export async function readFactDraft(domain, kind, projectId, targetId) {
  return (await requestWorkbench(factRoute(domain, kind, "read"), {
    method: "POST", body: { project_id: projectId, ...(targetId === undefined ? {} : { target_id: targetId }) },
  })).value;
}

export async function saveFactDraft(domain, kind, draft) {
  return (await requestWorkbench(factRoute(domain, kind, "save"), { method: "POST", body: draft })).value;
}

export async function readPromptContext(projectId, pageKey) {
  return (await requestWorkbench("/api/agent/prompt-context", {
    method: "POST", body: { project_id: projectId, page_key: pageKey },
  })).value;
}

// 从完整 Prompt 上下文文件取保存目标与草稿提交；只读 context 与 page_key 不进入请求体。
// 保存目标限于当前上下文契约 page/prompt，身份必须一致，不按 JSON 形状猜测入口。
export async function savePromptContextDraft(pack) {
  const fail = message => { throw Object.assign(new Error(message), { code: "invalid_prompt_context_file" }); };
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) fail("上下文文件不是完整 Prompt 上下文包");
  const { page_key: pageKey, save, draft } = pack;
  if (!save || save.domain !== "page" || save.kind !== "prompt") fail("上下文文件缺少 page/prompt 保存目标");
  if (!pageKey || typeof pageKey.page_id !== "string") fail("上下文文件缺少 page_key.page_id");
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) fail("上下文文件缺少草稿");
  if (draft.target_id !== pageKey.page_id) fail(`草稿目标 ${draft.target_id} 与页面 ${pageKey.page_id} 不一致`);
  return saveFactDraft(save.domain, save.kind, draft);
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
  if (action === "read") return readFactDraft(domain, kind, args[0], args[1]);
  return saveFactDraft(domain, kind, await readJsonInput(args[0]));
}

export function printResult(value) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

// --out 只做一件事：把命令原本应输出的成功 JSON 以 UTF-8 写入指定的一个文件。
// 在业务参数解析前统一提取；缺值与重复选项明确拒绝。
export function extractOutputOption(argv) {
  const args = [];
  let outFile;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--out") { args.push(argv[i]); continue; }
    if (outFile !== undefined) throw new Error("--out 选项重复");
    if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error("--out 缺少输出文件路径");
    outFile = argv[++i];
  }
  return { args, outFile };
}

export async function writeJsonOutput(file, value) {
  const absolute = path.resolve(file);
  const text = (typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n";
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
  return { output_file: absolute, bytes: Buffer.byteLength(text, "utf8") };
}

const printError = error => console.error(JSON.stringify({
  error: error.code ?? "command_failed", message: error.message,
  ...(error.status ? { status: error.status } : {}), ...(error.details === undefined ? {} : { details: error.details }),
}));

export function runCommand(main) {
  (async () => {
    const { args, outFile } = extractOutputOption(process.argv.slice(2));
    const value = await main(args);
    if (outFile === undefined) { printResult(value); return; }
    try {
      printResult(await writeJsonOutput(outFile, value));
    } catch (error) {
      // 业务已成功、结果落盘失败：保留已获得的成功结果或任务标识，不能让 Agent 因文件错误重放业务操作。
      printError(Object.assign(new Error(`结果写入 ${outFile} 失败：${error.message}`), {
        code: "output_write_failed", details: { result: value },
      }));
      process.exitCode = 1;
    }
  })().catch(error => {
    printError(error);
    process.exitCode = 1;
  });
}
