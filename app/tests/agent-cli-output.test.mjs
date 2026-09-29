import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveWorkbenchPort } from "../scripts/workbench-client.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

// 端口缺省仅用于字段缺失；非法端口明确失败，不回退到 3000。
test("端口解析：缺省 3000，合法非默认端口生效，非法端口拒绝", () => {
  assert.equal(resolveWorkbenchPort({}), 3000);
  assert.equal(resolveWorkbenchPort({ port: 3456 }), 3456);
  for (const port of [0, 70000, "abc", 3.5]) {
    assert.throws(() => resolveWorkbenchPort({ port }), /端口配置无效/);
  }
});

async function fixture(testContext, { config } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-cli-"));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "app", "scripts");
  await mkdir(scripts, { recursive: true });
  for (const file of ["workbench-client.mjs", "workbench-api.mjs", "agent-fact.mjs"]) {
    await cp(path.join(sourceRoot, "scripts", file), path.join(scripts, file));
  }
  await mkdir(path.join(root, "app", "server"), { recursive: true });
  await cp(path.join(sourceRoot, "server", "page-key.mjs"), path.join(root, "app", "server", "page-key.mjs"));
  await mkdir(path.join(root, "Config"), { recursive: true });
  if (config !== null) await writeFile(path.join(root, "Config", "local.json"), config);
  return { root, scripts };
}

async function stubServer(testContext) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += chunk;
    const body = input ? JSON.parse(input) : undefined;
    requests.push({ url: request.url, method: request.method, body, revision: request.headers["x-story-canvas-expected-revision"] });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/ping") return response.end(JSON.stringify({ ok: true, note: "中文内容 ✓" }));
    if (request.url === "/api/fail") {
      response.statusCode = 400;
      return response.end(JSON.stringify({ error: "boom", message: "业务失败", details: { reason: "测试" } }));
    }
    const fact = /^\/api\/agent\/facts\/([^/]+)\/([^/]+)\/(read|save)$/.exec(request.url);
    if (fact && fact[3] === "read") {
      return response.end(JSON.stringify({ project_id: body.project_id, target_id: body.target_id,
        document: { text: `来自 ${decodeURIComponent(fact[1])}/${decodeURIComponent(fact[2])}` },
        expected_sha256: "a".repeat(64), expected_context_sha256: "b".repeat(64) }));
    }
    if (fact) return response.end(JSON.stringify({ value: body.document, saved: true }));
    if (request.url === "/api/agent/prompt-context") {
      return response.end(JSON.stringify({ page_key: body.page_key,
        edit: {operation:'prompt.read',args:{project_id:body.project_id,target:{kind:'page',id:body.page_key.page_id}}},
        context: { status: "complete", note: "只读上下文" } }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found", message: request.url }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  testContext.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, requests };
}

const cli = (scripts, file, args, options) => run(process.execPath, [path.join(scripts, file), ...args], options);

test("--out 单文件原样输出：GET 与 POST，确认信息含绝对路径与字节数，UTF-8 中文不损坏", async t => {
  const { port } = await stubServer(t);
  const { root, scripts } = await fixture(t, { config: JSON.stringify({ port }) });
  const outFile = path.join(root, "Saved", "Agent", "任务 一", "结果.json");
  const confirmation = JSON.parse((await cli(scripts, "workbench-api.mjs", ["GET", "/api/ping", "--out", outFile])).stdout);
  assert.equal(confirmation.output_file, outFile);
  assert.equal(confirmation.bytes, Buffer.byteLength(await readFile(outFile, "utf8")));
  assert.deepEqual(JSON.parse(await readFile(outFile, "utf8")), { value: { ok: true, note: "中文内容 ✓" }, revision: null });

  const draftFile = path.join(root, "Saved", "Agent", "任务 一", "draft.json");
  await cli(scripts, "agent-fact.mjs", ["read", "scene", "profile", "demo", "room", "--out", draftFile]);
  const draft = JSON.parse(await readFile(draftFile, "utf8"));
  assert.equal(draft.document.text, "来自 scene/profile");
  assert.equal(draft.expected_sha256, "a".repeat(64));
});

test("--out 在任意 cwd 与带空格中文路径下写对位置；相对路径按调用者 cwd 解释", async t => {
  const { port } = await stubServer(t);
  const { root, scripts } = await fixture(t, { config: JSON.stringify({ port }) });
  const elsewhere = path.join(root, "其他地方");
  await mkdir(elsewhere, { recursive: true });
  const outFile = path.join(root, "Saved", "Agent", "任务 二", "草稿.json");
  await cli(scripts, "agent-fact.mjs", ["read", "story", "outline", "demo", "--out", outFile], { cwd: elsewhere });
  assert.equal(JSON.parse(await readFile(outFile, "utf8")).project_id, "demo");
  await cli(scripts, "agent-fact.mjs", ["read", "story", "outline", "demo", "--out", "相对结果.json"], { cwd: elsewhere });
  assert.equal(JSON.parse(await readFile(path.join(elsewhere, "相对结果.json"), "utf8")).project_id, "demo");
});

test("失败请求不写结果文件、不覆盖已有成功文件；重复或缺值 --out 拒绝", async t => {
  const { port } = await stubServer(t);
  const { root, scripts } = await fixture(t, { config: JSON.stringify({ port }) });
  const outFile = path.join(root, "Saved", "Agent", "t", "keep.json");
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, "{\"保留\":true}", "utf8");
  await assert.rejects(cli(scripts, "workbench-api.mjs", ["GET", "/api/fail", "--out", outFile]), error => {
    assert.equal(JSON.parse(error.stderr).error, "boom");
    return true;
  });
  assert.equal(await readFile(outFile, "utf8"), "{\"保留\":true}");
  await assert.rejects(cli(scripts, "workbench-api.mjs", ["GET", "/api/ping", "--out"]), /缺/);
  await assert.rejects(cli(scripts, "workbench-api.mjs", ["GET", "/api/ping", "--out", "a.json", "--out", "b.json"]), /重复/);
});

test("业务已成功而结果落盘失败时：只执行一次，错误保留成功结果，不误导重试", async t => {
  const { port, requests } = await stubServer(t);
  const { root, scripts } = await fixture(t, { config: JSON.stringify({ port }) });
  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "占用", "utf8");
  const draftFile = path.join(root, "draft.json");
  await writeFile(draftFile, JSON.stringify({ project_id: "demo", document: { title: "已保存的标题" },
    expected_sha256: "a".repeat(64), expected_context_sha256: "b".repeat(64) }), "utf8");
  await assert.rejects(cli(scripts, "agent-fact.mjs", ["save", "story", "outline", draftFile, "--out", path.join(blocker, "out.json")]), error => {
    const output = JSON.parse(error.stderr);
    assert.equal(output.error, "output_write_failed");
    assert.deepEqual(output.details.result, { value: { title: "已保存的标题" }, saved: true });
    return true;
  });
  assert.equal(requests.filter(request => request.url.endsWith("/save")).length, 1, "业务只执行一次");
});

test("save-context 拒绝只读上下文和旧草稿，不发送保存请求", async t => {
  const { port, requests } = await stubServer(t);
  const { root, scripts } = await fixture(t, { config: JSON.stringify({ port }) });
  const contextFile = path.join(root, "prompt-context.json");
  const pack = JSON.parse((await cli(scripts, "agent-fact.mjs", ["prompt-context", "demo", "v3/page-001"])).stdout);
  assert.equal(pack.edit.operation, 'prompt.read');
  assert.equal(pack.save, undefined);assert.equal(pack.draft, undefined);
  await writeFile(contextFile, JSON.stringify(pack), "utf8");
  const legacy = { ...pack, save:{domain:'page',kind:'prompt'}, draft:{project_id:'demo',target_id:'page-001',document:{text:'旧草稿'},expected_sha256:'a'.repeat(64),expected_context_sha256:'b'.repeat(64)} };
  for (const value of [pack, legacy]) {
    await writeFile(contextFile, JSON.stringify(value), 'utf8');
    await assert.rejects(cli(scripts, "agent-fact.mjs", ["save-context", contextFile]), error => {
      assert.equal(JSON.parse(error.stderr).error, "prompt_editor_moved");
      return true;
    });
  }
  assert.equal(requests.some(request=>request.url.endsWith('/save')),false);
});

test("revision 请求头透传与错误细节保留", async t => {
  const { port, requests } = await stubServer(t);
  const { root, scripts } = await fixture(t, { config: JSON.stringify({ port }) });
  const bodyFile = path.join(root, "body.json");
  await writeFile(bodyFile, JSON.stringify({ project_id: "demo" }), "utf8");
  await cli(scripts, "workbench-api.mjs", ["POST", "/api/agent/facts/story/outline/read", "--body", bodyFile, "--revision", "17"]);
  assert.equal(requests.at(-1).revision, "17");
  await assert.rejects(cli(scripts, "workbench-api.mjs", ["GET", "/api/fail"]), error => {
    const output = JSON.parse(error.stderr);
    assert.equal(output.error, "boom");
    assert.equal(output.status, 400);
    assert.deepEqual(output.details, { reason: "测试" });
    return true;
  });
});

test("连接失败报 workbench_unavailable；非法 JSON 配置报 invalid_workbench_config", async t => {
  const { scripts } = await fixture(t, { config: JSON.stringify({ port: 1 }) });
  await assert.rejects(cli(scripts, "workbench-api.mjs", ["GET", "/api/ping"]), error => {
    assert.equal(JSON.parse(error.stderr).error, "workbench_unavailable");
    return true;
  });
  const bad = await fixture(t, { config: "{ 不是 JSON" });
  await assert.rejects(cli(bad.scripts, "workbench-api.mjs", ["GET", "/api/ping"]), error => {
    assert.equal(JSON.parse(error.stderr).error, "invalid_workbench_config");
    return true;
  });
  const badPort = await fixture(t, { config: JSON.stringify({ port: 70000 }) });
  await assert.rejects(cli(badPort.scripts, "workbench-api.mjs", ["GET", "/api/ping"]), error => {
    assert.equal(JSON.parse(error.stderr).error, "invalid_workbench_config");
    return true;
  });
});
