import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProject, readProjectCreationTemplate } from "../server/project-creation.mjs";
import { createCharacter } from "../server/character-facts.mjs";
import { createScene } from "../server/scene-facts.mjs";
import { readFactDraft } from "../server/fact-drafts.mjs";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleWorkbenchRequest } from "../server/workbench-http.mjs";

function jsonRequest(method, value) {
  const request = Readable.from([Buffer.from(JSON.stringify(value))]);
  request.method = method;
  return request;
}

function unused() {
  throw new Error("unexpected context dependency");
}

function context(overrides = {}) {
  return {
    request: jsonRequest("GET", {}),
    response: {},
    decodedPath: "/api/health",
    projectRoot: "D:/repository",
    config: { comfyui_urls: ["http://127.0.0.1:8188"] },
    readFacts: unused,
    mutateFacts: unused,
    mutateDerived: unused,
    mutateDerivedState: unused,
    sendOperation: unused,
    workbenchRenderLauncher: null,
    ...overrides,
  };
}

test("workbench adapter leaves unrelated routes to the outer HTTP server", async () => {
  assert.equal(await handleWorkbenchRequest(context()), false);
});

test("workbench render stays inside the derived mutation boundary and returns the queued task contract", async () => {
  const calls = [];
  const task = {
    task_id: "render-20260828T010203Z",
    status: "queued",
    operation: "candidates",
    page_key: { page_id: "page-001" },
    count: 3,
  };
  const handled = await handleWorkbenchRequest(context({
    request: jsonRequest("POST", { page_key: task.page_key, operation: "candidates", count: 3 }),
    decodedPath: "/api/projects/demo/workbench/render",
    mutateDerived: async (projectId, operation) => {
      calls.push(["mutateDerived", projectId]);
      return { value: await operation({ projectId: "demo", projectDirectory: "D:/repository/workspace/demo" }), revision: "revision-1" };
    },
    workbenchRenderLauncher: async (request) => {
      calls.push(["launcher", request.projectId, request.projectDirectory, request.value.count]);
      return task;
    },
    sendOperation: (status, result, body) => calls.push(["response", status, result.revision, body]),
  }));

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    ["mutateDerived", "demo"],
    ["launcher", "demo", "D:/repository/workspace/demo", 3],
    ["response", 202, "revision-1", { task }],
  ]);
});

test("invalid inspection payload is rejected before facts or dictionary reads", async () => {
  await assert.rejects(
    handleWorkbenchRequest(context({
      request: jsonRequest("POST", { page_key: { page_id: "page-001" }, unexpected: true }),
      decodedPath: "/api/projects/demo/workbench/page-render-inspection",
    })),
    (error) => error?.status === 400 && error?.code === "invalid_page_render_inspection_request",
  );
});

test("媒体首读不强制扫描；只有显式fresh请求才强制校验", async () => {
  const calls = [];
  for (const fresh of [false, true]) {
    const request = jsonRequest("POST", { page_key: { page_id: "page-001" } });
    request.headers = fresh ? { "x-story-canvas-media-fresh": "1" } : {};
    assert.equal(await handleWorkbenchRequest(context({
      request, decodedPath: "/api/projects/demo/workbench/page-media",
      response: { writeHead() {}, end() {} },
      pageMediaReader: { async read(id, value, options) { calls.push(options.fresh); return { revision: "r", media: { candidates: [] } }; } },
    })), true);
  }
  assert.deepEqual(calls, [false, true]);
});

test("数量读取绕过事实扫描和当前页媒体投影", async () => {
  const request = jsonRequest("GET", {});
  request.headers = { "x-story-canvas-media-revision": "counts-r" };
  let body;
  assert.equal(await handleWorkbenchRequest(context({
    request, decodedPath: "/api/projects/demo/workbench/candidate-counts",
    response: { writeHead() {}, end(value) { body = JSON.parse(value); } },
    pageMediaReader: { read: unused, async counts(id) { assert.equal(id, "demo"); return { counts: { "page-001": 2 }, revision: "counts-r" }; } },
  })), true);
  assert.deepEqual(body, { unchanged: true, revision: "counts-r" });
});


test("场景 Prompt 和子设定重命名拒绝过期指纹，成功返回公共设定文档", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scene-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root, await readProjectCreationTemplate(root, "demo"));
  await createScene(root, "demo", "station", { name: "车站" });
  const read = kind => readFactDraft(root, { domain: "scene", kind, projectId: "demo", targetId: "station" });
  const visual = await read("visual"), prompt = await read("prompt");
  const publicPrompt = structuredClone(prompt.document); delete publicPrompt.$schema;
  const request = async (endpoint, method, value) => {
    let response;
    await handleWorkbenchRequest(context({
      projectRoot: root, decodedPath: `/api/projects/demo/workbench/${endpoint}`, request: jsonRequest(method, value),
      mutateTargetFacts: async (projectId, operation) => ({ value: await operation({ projectId }) }),
      sendOperation: (_status, result) => { response = result.value; },
    }));
    return response;
  };
  const payload = { scene_id: "station", prompt: publicPrompt, expected_sha256: prompt.expected_sha256, expected_visual_sha256: visual.expected_sha256 };
  await assert.rejects(request("scene-prompt", "PUT", { ...payload, expected_visual_sha256: "0".repeat(64) }), error => error.code === "scene_prompt_visual_conflict");
  assert.deepEqual((await read("prompt")).document, prompt.document);
  const saved = await request("scene-prompt", "PUT", payload);
  assert.equal(saved.prompt.$schema, undefined);
  const rename = { scene_id: "station", old_id: "default", new_id: "day", expected_sha256: visual.expected_sha256, expected_prompt_sha256: saved.prompt_sha256 };
  await assert.rejects(request("scene-variant-rename", "POST", { ...rename, expected_prompt_sha256: "0".repeat(64) }), error => error.code === "scene_variant_rename_conflict");
  const renamed = await request("scene-variant-rename", "POST", rename);
  assert.equal(renamed.visual.variants[0].id, "day");
  assert.equal(renamed.visual.$schema, undefined);
  assert.equal(renamed.prompt.$schema, undefined);
  assert.equal(renamed.visual_sha256, (await read("visual")).expected_sha256);
});


test("公共页面模板创建传递显式人物引用", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-page-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("../../library/visual-page-templates", import.meta.url), path.join(root, "library/visual-page-templates"), { recursive: true });
  const creation = await readProjectCreationTemplate(root, "demo");
  creation.document.outline.chapters[0].sequences.push({ id: "arrival", title: "抵达", summary: "抵达车站。" });
  await createProject(root, creation);
  await createScene(root, "demo", "station", { name: "车站" });
  await createCharacter(root, "demo", "ellen", { name: "艾莲" });
  for (const owner of [{ owner_kind: "story", sequence_id: "arrival" }, { owner_kind: "scene", scene_id: "station", variant_id: "default" }]) {
  let result;
  assert.equal(await handleWorkbenchRequest(context({
    projectRoot: root, decodedPath: "/api/projects/demo/workbench/navigation/create-page",
    request: jsonRequest("POST", { owner, template_id: owner.owner_kind === "story" ? "upper-body-portrait" : null, character_id: "ellen", variant_id: "default" }),
    mutateFacts: async (_id, operation) => ({ value: await operation() }),
    sendOperation: (_status, operation) => { result = operation.value; },
  })), true);
  const content = JSON.parse(await readFile(result.content_file, "utf8"));
  assert.deepEqual(content.characters, [{ character_id: "ellen", variant_id: "default" }]);
  const prompt = JSON.parse(await readFile(result.prompt_file, "utf8"));
  if (owner.owner_kind === "scene") {
    assert.equal(prompt.scene_id, "station");
    assert.equal(prompt.scene_variant_id, "default");
  }
  }
});
