import { cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import { createStoryPage } from "../server/story-facts.mjs";
import { createCharacter } from "../server/character-facts.mjs";
import { createCharacterPage } from "../server/character-page-facts.mjs";

import { createStoryCanvasServer } from "../server/index.mjs";
import { handleRuntimeRequest } from "../server/runtime-http.mjs";
import { enqueueGenerationTask, generationQueueFile, generationReference, readGenerationQueue } from "../server/generation-queue.mjs";
import { MEDIA_VARIANT_WIDTHS, warmMediaVariants } from "../server/media-variants.mjs";
import { createRenderTask, listProjectRenderTaskStates, readRenderTaskState, updateRenderTask } from "../server/render-task-storage.mjs";
import {
  createProject,
  readProjectCreationTemplate,
} from "../server/project-creation.mjs";

async function startCurrentProjectServer(context, options = {}) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "story-canvas-api-"));
  const appRoot = path.join(projectRoot, "app");
  await mkdir(path.join(appRoot, "dist"), { recursive: true });
  await writeFile(path.join(appRoot, "dist", "index.html"), "<!doctype html><title>Workbench</title>");

  if (options.createProject !== false) {
    const session = await readProjectCreationTemplate(projectRoot, "current-story");
    const creation = structuredClone(session.document);
    creation.metadata.title = "当前故事";
    creation.outline = {
      synopsis: "一次简短相遇。",
      chapters: [{
        id: "meeting",
        title: "相遇",
        summary: "两人相遇。",
        sequences: [{ id: "doorstep", title: "门口", summary: "在门口碰面。" }],
      }],
    };
    session.document = structuredClone(creation);
    await createProject(projectRoot, session);
  }
  await options.beforeServer?.({ projectRoot });

  const server = await createStoryCanvasServer({
    projectRoot,
    appRoot,
    production: true,
    localConfig: { comfyui_urls: ["http://127.0.0.1:8188"] },
    comfyEndpointSelector: options.comfyEndpointSelector ?? {
      urls: () => ["http://127.0.0.1:8188"],
      currentUrl: () => "http://127.0.0.1:8188",
      status: () => ({ status: "available", reason: null, url: "http://127.0.0.1:8188", endpoint_index: 0, endpoint_count: 1, version: null, checked_at: null }),
      refresh: async () => undefined,
    },
    hardwareStatusReader: options.hardwareStatusReader ?? (async () => ({ sampled_at: new Date(0).toISOString() })),
    workbenchRenderLauncher: options.workbenchRenderLauncher,
    generationQueueDrainOptions: options.generationQueueDrainOptions,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { origin: `http://127.0.0.1:${address.port}`, projectRoot };
}

test("空工作区返回完整任务集合契约并终结仍在跟踪的任务", async (context) => {
  const { origin } = await startCurrentProjectServer(context, { createProject: false });
  const taskId = "render-20260828T010200Z-00000000";
  const response = await fetch(`${origin}/api/tasks?tracked=${encodeURIComponent(`removed-story/${taskId}`)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { tasks: [], history: [], tracked: [], missing_tracked_task_ids: [taskId] });
});

test("HTTP 工作台只公开当前项目视图", async (context) => {
  const { origin } = await startCurrentProjectServer(context);

  const response = await fetch(`${origin}/api/projects/current-story/workbench`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version, 6);
  assert.equal(body.project.title, "当前故事");
  assert.equal(body.outline.chapters[0].sequences[0].id, "doorstep");
  assert.equal(JSON.stringify(body).includes('"media"'), false);
  assert.equal(Object.hasOwn(body, "candidate_assessments"), false);
});

test("显式刷新按当前选择结果更新远程 ComfyUI 状态", async (context) => {
  let currentUrl = "http://primary:8188";
  let refreshes = 0;
  const selector = {
    urls: () => ["http://primary:8188", "http://backup:8188"],
    currentUrl: () => currentUrl,
    status: () => ({ status: "available", reason: null, url: currentUrl, endpoint_index: currentUrl.includes("backup") ? 1 : 0, endpoint_count: 2, version: null, checked_at: null }),
    refresh: async () => { refreshes += 1; currentUrl = "http://backup:8188"; },
    select: (url) => { currentUrl = url; return { selected: true }; },
  };
  const hardwareStatusReader = async () => ({ sampled_at: new Date(0).toISOString(), comfyui: { status: "available", url: currentUrl } });
  const { origin } = await startCurrentProjectServer(context, { comfyEndpointSelector: selector, hardwareStatusReader });

  const response = await fetch(`${origin}/api/comfyui/refresh`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(refreshes, 2, "启动检测一次，用户刷新再检测一次");
  assert.equal((await response.json()).hardware.comfyui.url, "http://backup:8188");

  const selected = await fetch(`${origin}/api/comfyui/select`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://primary:8188" }) });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).hardware.comfyui.url, "http://primary:8188");
});

test("轻量revision接口发现独立CLI写入，派生文件变化不改变事实revision", async (context) => {
  const { origin, projectRoot } = await startCurrentProjectServer(context);
  const endpoint = `${origin}/api/projects/current-story/revision`;
  const read = async () => {
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(Object.keys(value), ["revision"]);
    return value.revision;
  };
  const initial = await read();
  await createStoryPage(projectRoot, "current-story", "doorstep");
  let updated = initial;
  for (let attempt = 0; attempt < 50 && updated === initial; attempt += 1) {
    await delay(20);
    updated = await read();
  }
  assert.notEqual(updated, initial);
  const cache = path.join(projectRoot, "workspace", "current-story", "cache");
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, "candidate-selection-state.json"), JSON.stringify({ version: 2, pages: {} }));
  await delay(30);
  assert.equal(await read(), updated);
  assert.equal((await fetch(`${origin}/api/projects/current-story/workbench`)).headers.get("x-story-canvas-revision"), updated);
});

test("导航语义 API 使用项目 revision，冲突后不自动重试", async (context) => {
  const { origin } = await startCurrentProjectServer(context);
  const initial = await fetch(`${origin}/api/projects/current-story/workbench`);
  const revision = initial.headers.get("x-story-canvas-revision");
  assert.ok(revision);

  const create = await fetch(`${origin}/api/projects/current-story/workbench/navigation/create-story-page`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": revision },
    body: JSON.stringify({ sequence_id: "doorstep" }),
  });
  const created = await create.json();
  assert.equal(create.status, 200);
  assert.match(created.page_id, /^page-[a-f0-9]{12}$/);

  const stale = await fetch(`${origin}/api/projects/current-story/workbench/navigation/create-story-page`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": revision },
    body: JSON.stringify({ sequence_id: "doorstep" }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "project_revision_conflict");

  const current = await fetch(`${origin}/api/projects/current-story/workbench`);
  assert.equal((await current.json()).outline.chapters[0].sequences[0].pages.length, 1);

  const pageKey = { page_id: created.page_id };
  const mediaResponse = await fetch(`${origin}/api/projects/current-story/workbench/page-media`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey }),
  });
  assert.equal(mediaResponse.status, 200);
  const mediaBody = await mediaResponse.json();
  assert.match(mediaBody.revision, /^[a-f0-9]{64}$/);
  assert.equal(mediaResponse.headers.get("x-story-canvas-revision"), null, "派生媒体查询不更新事实版本");
  assert.deepEqual(mediaBody, {
    revision: mediaBody.revision,
    version: 1,
    page_key: pageKey,
    media: { candidates: [] },
  });
  const unchanged = await fetch(`${origin}/api/projects/current-story/workbench/page-media`, {
    method: "POST", headers: { "content-type": "application/json", "x-story-canvas-media-revision": mediaBody.revision },
    body: JSON.stringify({ page_key: pageKey }),
  });
  assert.deepEqual(await unchanged.json(), { unchanged: true, revision: mediaBody.revision });

  const invalidMediaResponse = await fetch(`${origin}/api/projects/current-story/workbench/page-media`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey, unexpected: true }),
  });
  assert.equal(invalidMediaResponse.status, 400);
  assert.equal((await invalidMediaResponse.json()).error, "invalid_page_media_request");
});

test("旧聚合、协作记录、评估、Prompt 引用与通用渲染入口不再公开", async (context) => {
  const { origin } = await startCurrentProjectServer(context);
  const routes = [
    "/api/projects/current-story/story-document",
    "/api/projects/current-story/characters",
    "/api/projects/current-story/character-pages",
    "/api/projects/current-story/collaboration",
    "/api/projects/current-story/candidate-assessments",
    "/api/projects/current-story/prompt-references",
    "/api/projects/current-story/render",
  ];

  const responses = await Promise.all(routes.map((route) => fetch(`${origin}${route}`)));

  assert.deepEqual(responses.map((response) => response.status), routes.map(() => 404));
});

test("工作台生成使用完整PageKey且不要求项目revision", async (context) => {
  let received = null;
  const { origin } = await startCurrentProjectServer(context, {
    workbenchRenderLauncher: async (request) => {
      received = request;
      return {
        task_id: "render-20260827T010203Z",
        status: "queued",
        operation: request.value.operation,
        page_key: request.value.page_key,
        count: request.value.count,
      };
    },
  });
  const pageKey = { page_id: "page-001" };
  const response = await fetch(`${origin}/api/projects/current-story/workbench/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey, operation: "candidates", count: 3, seed: 17 }),
  });
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-story-canvas-revision"), null);
  assert.deepEqual(received.value, { page_key: pageKey, operation: "candidates", count: 3, seed: 17 });
  assert.deepEqual(body.task, {
    task_id: "render-20260827T010203Z", status: "queued", operation: "candidates", page_key: pageKey, count: 3,
  });
});

test("统一任务控制路由取消排队任务，且不补建队列", async (context) => {
  const { origin, projectRoot } = await startCurrentProjectServer(context);
  const taskId = "render-20260828T010203Z-abcdef12";
  await createRenderTask(path.join(projectRoot, "workspace", "current-story"), {
    version: 2,
    id: taskId,
    project: "current-story",
    render_profile: "anima-base-v1",
    purpose: "candidate",
    status: "queued",
    created_at: "2026-08-28T01:02:03.000Z",
    snapshot: {},
    items: [{ id: "item-1", page_key: { page_id: "page-001" }, seed: 1, status: "queued" }],
  }, { project_title: "当前故事", pages: [] });
  const endpoint = `${origin}/api/tasks/current-story/${taskId}/control`;
  const control = async (action) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, purpose: "candidate" }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(typeof body.task.status, "string");
    return body.task.status;
  };
  assert.equal(await control("cancel"), "cancelled");
  assert.deepEqual((await readGenerationQueue(projectRoot)).items, []);
});

test("持久 ComfyUI drain 不阻塞服务监听，调度器只 dispatch 等待中的 worker", async (context) => {
  let releaseDrain;
  const drainBlocked = new Promise((resolve) => { releaseDrain = resolve; });
  const taskId = "render-20260828T010208Z-88888888";
  const startPromise = startCurrentProjectServer(context, {
    beforeServer: async ({ projectRoot }) => {
      const projectDirectory = path.join(projectRoot, "workspace", "current-story");
      const reference = generationReference("current-story", taskId, "candidate", "2026-08-28T01:02:08.000Z");
      await createRenderTask(projectDirectory, {
        version: 2,
        id: taskId,
        project: "current-story",
        render_profile: "anima-base-v1",
        purpose: "candidate",
        status: "queued",
        created_at: "2026-08-28T01:02:08.000Z",
        snapshot: {},
        items: [{ id: "item-1", page_key: { page_id: "page-001" }, seed: 1, status: "queued" }],
      }, { project_title: "当前故事", pages: [] });
      await enqueueGenerationTask(projectRoot, reference);
      const queueFile = generationQueueFile(projectRoot);
      const queue = JSON.parse(await readFile(queueFile, "utf8"));
      queue.active = {
        ...reference,
        unit_id: "stale-unit",
        lease_token: "stale-token",
        owner_pid: 999999,
        claimed_at: "2026-08-28T01:02:08.000Z",
      };
      await writeFile(queueFile, `${JSON.stringify(queue)}\n`);
    },
    generationQueueDrainOptions: {
      fetchImpl: async () => {
        await drainBlocked;
        return { ok: true, async json() { return { queue_running: [], queue_pending: [] }; } };
      },
      requestTimeoutMs: 10_000,
      pollMs: 1,
      retryMs: 1,
    },
  });
  try {
    const startup = await Promise.race([
      startPromise.then(() => "started"),
      delay(5000).then(() => "blocked"),
    ]);
    assert.equal(startup, "started");
    const { origin, projectRoot } = await startPromise;
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    assert.equal((await readRenderTaskState(path.join(projectRoot, "workspace", "current-story"), taskId)).status, "queued");
  } finally {
    releaseDrain?.();
    const started = await startPromise;
    const deadline = Date.now() + 5000;
    let queue;
    do {
      queue = await readGenerationQueue(started.projectRoot);
      if (!queue.items.length) break;
      await delay(20);
    } while (Date.now() < deadline);
    assert.equal(queue.items.length, 0, "等待 worker 完成后再清理项目");
    assert.equal((await readRenderTaskState(path.join(started.projectRoot, "workspace", "current-story"), taskId)).status, "failed");
  }
});

test("流程预览是无需expected revision的只读POST，配置不可用仍返回inspection", async (context) => {
  const { origin } = await startCurrentProjectServer(context);
  const initial = await fetch(`${origin}/api/projects/current-story/workbench`);
  const revision = initial.headers.get("x-story-canvas-revision");
  const createdResponse = await fetch(`${origin}/api/projects/current-story/workbench/navigation/create-story-page`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": revision },
    body: JSON.stringify({ sequence_id: "doorstep" }),
  });
  const created = await createdResponse.json();

  const response = await fetch(`${origin}/api/projects/current-story/workbench/page-render-inspection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      page_key: { page_id: created.page_id },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.inspection.page_key.page_id, created.page_id);
  assert.equal(body.inspection.ready, false);
  assert.ok(body.inspection.blockers.some((item) => item.code === "render_profile_compilation_failed"));
});

test("活动任务列表汇总角色视觉页并使用角色显示名", async (context) => {
  const { origin, projectRoot } = await startCurrentProjectServer(context);
  const initial = await fetch(`${origin}/api/projects/current-story/workbench`);
  let revision = initial.headers.get("x-story-canvas-revision");

  const createCharacter = await fetch(`${origin}/api/projects/current-story/workbench/navigation/create-character`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": revision },
    body: JSON.stringify({ id: "classmate", name: "Classmate" }),
  });
  const character = await createCharacter.json();
  assert.equal(createCharacter.status, 200);
  assert.equal(character.character_id, "classmate");
  revision = createCharacter.headers.get("x-story-canvas-revision");

  const createPage = await fetch(`${origin}/api/projects/current-story/workbench/navigation/create-character-page`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": revision },
    body: JSON.stringify({ character_id: character.character_id, variant_id: "default" }),
  });
  const page = await createPage.json();
  assert.equal(createPage.status, 200);

  const taskId = "render-20260828T010203Z-1234abcd";
  const pageKey = { page_id: page.page_id };
  const projectDirectory = path.join(projectRoot, "workspace", "current-story");
  await createRenderTask(projectDirectory, {
    version: 2,
    id: taskId,
    project: "current-story",
    render_profile: "anima-base-v1",
    purpose: "candidate",
    status: "queued",
    created_at: "2026-08-28T01:02:03.000Z",
    snapshot: {},
    items: [{ id: "candidate-001", page_key: pageKey, seed: 1, status: "queued" }],
  }, {
    project_title: "当前故事",
    pages: [{ page_key: pageKey, page_id: page.page_id, order: 1, title: "基础形象", owner_kind: "character", owner_label: "Classmate" }],
  });
  assert.deepEqual((await listProjectRenderTaskStates(projectDirectory, { scope: "active" })).map((state) => state.id), [taskId]);
  await writeFile(path.join(projectDirectory, "characters", `${character.character_id}.profile.json`), "{broken", "utf8");

  const response = await fetch(`${origin}/api/tasks`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.tasks.map((task) => ({
    project_id: task.project_id,
    current_owner_kind: task.current_owner_kind,
    current_owner_label: task.current_owner_label,
    current_page_key: task.current_page_key,
  })), [{
    project_id: "current-story",
    current_owner_kind: "character",
    current_owner_label: "Classmate",
    current_page_key: pageKey,
  }]);
});

test("子设定重命名端点联动更新引用并返回新指纹", async (context) => {
  const { origin, projectRoot } = await startCurrentProjectServer(context);
  const initial = await fetch(`${origin}/api/projects/current-story/workbench`);
  let revision = initial.headers.get("x-story-canvas-revision");

  const createCharacter = await fetch(`${origin}/api/projects/current-story/workbench/navigation/create-character`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": revision },
    body: JSON.stringify({ id: "classmate", name: "Classmate" }),
  });
  const character = await createCharacter.json();
  assert.equal(createCharacter.status, 200);
  revision = createCharacter.headers.get("x-story-canvas-revision");

  const createPage = await fetch(`${origin}/api/projects/current-story/workbench/navigation/create-character-page`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": revision },
    body: JSON.stringify({ character_id: character.character_id, variant_id: "default" }),
  });
  const page = await createPage.json();
  assert.equal(createPage.status, 200);
  revision = createPage.headers.get("x-story-canvas-revision");

  const rename = await fetch(`${origin}/api/projects/current-story/workbench/character-variant-rename`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": revision },
    body: JSON.stringify({ character_id: character.character_id, old_id: "default", new_id: "casual" }),
  });
  const renamed = await rename.json();
  assert.equal(rename.status, 200);
  assert.equal(renamed.character_id, character.character_id);
  assert.equal(renamed.old_id, "default");
  assert.equal(renamed.new_id, "casual");
  assert.deepEqual(renamed.updated_page_ids, [page.page_id]);
  assert.deepEqual(renamed.visual.variants.map((variant) => variant.id), ["casual"]);
  assert.deepEqual(Object.keys(renamed.prompt.variants), ["casual"]);
  assert.equal(Object.hasOwn(renamed.visual, "$schema"), false);
  assert.equal(Object.hasOwn(renamed.prompt, "$schema"), false);
  assert.match(renamed.visual_sha256, /^[a-f0-9]{64}$/);
  assert.match(renamed.prompt_sha256, /^[a-f0-9]{64}$/);
  const projectDirectory = path.join(projectRoot, "workspace", "current-story");
  const pagesIndex = JSON.parse(await readFile(path.join(projectDirectory, "pages", "index.json"), "utf8"));
  assert.deepEqual(pagesIndex.pages[0], { page_id: page.page_id, owner_kind: "character", character_id: character.character_id, variant_id: "casual" });
  const persistedPrompt = JSON.parse(await readFile(path.join(projectDirectory, "characters", `${character.character_id}.prompt.json`), "utf8"));
  assert.deepEqual(Object.keys(persistedPrompt.variants), ["casual"]);
  // sha 与落盘事实一致，可直接刷新前端乐观锁指纹。
  const view = await (await fetch(`${origin}/api/projects/current-story/workbench`)).json();
  const viewCharacter = view.characters.find((item) => item.id === character.character_id);
  assert.equal(viewCharacter.visual_sha256, renamed.visual_sha256);
  assert.equal(viewCharacter.prompt_sha256, renamed.prompt_sha256);

  const conflict = await fetch(`${origin}/api/projects/current-story/workbench/character-variant-rename`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-story-canvas-expected-revision": rename.headers.get("x-story-canvas-revision") },
    body: JSON.stringify({ character_id: character.character_id, old_id: "missing", new_id: "other" }),
  });
  assert.equal(conflict.status, 422);
  assert.equal((await conflict.json()).error, "character_variant_not_found");
});

test("任务精确跟踪不受最近历史展示窗口限制", async (context) => {
  const { origin, projectRoot } = await startCurrentProjectServer(context);
  const projectDirectory = path.join(projectRoot, "workspace", "current-story");
  const taskIds = [];
  for (let index = 0; index < 9; index += 1) {
    const taskId = `render-20260828T01020${index}Z-${String(index).padStart(8, "0")}`;
    taskIds.push(taskId);
    await createRenderTask(projectDirectory, {
      version: 2,
      id: taskId,
      project: "current-story",
      render_profile: "anima-base-v1",
      purpose: "candidate",
      status: "queued",
      created_at: `2026-08-28T01:02:0${index}.000Z`,
      snapshot: {},
      items: [],
    }, { project_title: "当前故事", pages: [] });
    await updateRenderTask(projectDirectory, taskId, (task) => {
      task.status = "completed";
      task.completed_at = `2026-08-28T01:03:0${index}.000Z`;
    });
  }

  const tracked = encodeURIComponent(`current-story/${taskIds[0]}`);
  const response = await fetch(`${origin}/api/tasks?tracked=${tracked}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.history.length, 0);
  assert.equal(body.history.some((task) => task.id === taskIds[0]), false);
  assert.deepEqual(body.tracked, [{ id: taskIds[0], status: "completed" }]);
  assert.deepEqual(body.missing_tracked_task_ids, []);
  const history = await (await fetch(`${origin}/api/tasks/history`)).json();
  assert.equal(history.history.length, 9, "历史按需读取，不截断在8条");
  assert.equal(history.history.some((task) => task.id === taskIds[0]), true);
  assert.equal(history.next_cursor, null);
});

test("任务精确跟踪不设与前端状态数量不一致的硬上限", async (context) => {
  const { origin } = await startCurrentProjectServer(context);
  const taskIds = Array.from({ length: 101 }, (_, index) => `render-20260828T020000Z-${index.toString(16).padStart(8, "0")}`);
  const query = new URLSearchParams();
  for (const taskId of taskIds) query.append("tracked", `current-story/${taskId}`);

  const response = await fetch(`${origin}/api/tasks?${query}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.tracked, []);
  assert.deepEqual(body.missing_tracked_task_ids, taskIds);
});

test("候选数量提供独立版本，移除选用和PNG合成接口且只接受候选生成", async (context) => {
  const { origin } = await startCurrentProjectServer(context, { workbenchRenderLauncher: () => { throw new Error("不应调用"); } });
  const base = `${origin}/api/projects/current-story/workbench`;
  const first = await fetch(`${base}/candidate-counts`);
  assert.equal(first.status, 200);
  const snapshot = await first.json();
  assert.deepEqual(snapshot.counts, {});
  const second = await fetch(`${base}/candidate-counts`, { headers: { "x-story-canvas-media-revision": snapshot.revision } });
  assert.deepEqual(await second.json(), { unchanged: true, revision: snapshot.revision });
  for (const endpoint of ["candidate-selection", "lettering-preview"]) {
    const result = await fetch(`${base}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(result.status, 404);
  }
  const unsupported = await fetch(`${base}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "upscale" }) });
  assert.equal(unsupported.status, 400);
});

test("候选原图使用不可变私有缓存；其他媒体仍不缓存", async (context) => {
  const { origin, projectRoot } = await startCurrentProjectServer(context);
  const project = path.join(projectRoot, "workspace", "current-story");
  const { PNG } = (await import("pngjs")).default;
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  for (const file of ["Outputs/story/page-001/candidate-11111111-1111-4111-8111-111111111111/image.png", "materials/reference.png"]) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), png);
    const response = await fetch(`${origin}/api/projects/current-story/media/${file}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), file.startsWith("Outputs/") ? "private, max-age=31536000, immutable" : "no-store");
    assert.equal((await response.arrayBuffer()).byteLength, png.length);
  }
});

test("候选图按 w 参数生成缩放变体并落盘缓存，其他媒体忽略变体", async (context) => {
  const { origin, projectRoot } = await startCurrentProjectServer(context);
  const project = path.join(projectRoot, "workspace", "current-story");
  const { PNG } = (await import("pngjs")).default;
  const sharp = (await import("sharp")).default;
  const png = PNG.sync.write(new PNG({ width: 2000, height: 1000 }));
  const file = "Outputs/story/page-001/candidate-22222222-2222-4222-8222-222222222222/image.png";
  await mkdir(path.dirname(path.join(project, file)), { recursive: true });
  await writeFile(path.join(project, file), png);

  const first = await fetch(`${origin}/api/projects/current-story/media/${file}?w=100`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/webp");
  assert.equal(first.headers.get("cache-control"), "private, max-age=31536000, immutable");
  const variant = Buffer.from(await first.arrayBuffer());
  assert.equal((await sharp(variant).metadata()).width, 320, "请求宽度向上吸附到档位");

  const cacheDir = path.join(project, "Saved", "media-cache");
  const cached = await readdir(cacheDir);
  assert.equal(cached.length, 1);
  assert.ok(cached[0].endsWith(".webp"));

  const second = await fetch(`${origin}/api/projects/current-story/media/${file}?w=320`);
  assert.equal(second.status, 200);
  assert.equal(Buffer.from(await second.arrayBuffer()).length, variant.length, "第二次命中同一缓存文件");
  assert.equal((await readdir(cacheDir)).length, 1, "命中缓存不再生成新文件");

  for (const file of ["Outputs/finished/example/image.png"]) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), png);
    const response = await fetch(`${origin}/api/projects/current-story/media/${file}?w=320`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width, 320);
  }

  const oversized = await fetch(`${origin}/api/projects/current-story/media/${file}?w=9999`);
  assert.equal(oversized.headers.get("content-type"), "image/png", "超过最大档位回退原图");

  const material = "materials/reference-variant.png";
  await writeFile(path.join(project, material), png);
  const plain = await fetch(`${origin}/api/projects/current-story/media/${material}?w=100`);
  assert.equal(plain.headers.get("content-type"), "image/png", "非候选路径忽略变体参数");

  const broken = "Outputs/story/page-001/candidate-33333333-3333-4333-8333-333333333333/image.png";
  await mkdir(path.dirname(path.join(project, broken)), { recursive: true });
  await writeFile(path.join(project, broken), Buffer.from("not a real png"));
  const fallback = await fetch(`${origin}/api/projects/current-story/media/${broken}?w=320`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("content-type"), "image/png", "变体生成失败回退原图");
});

test("候选发布预热全部变体档位", async () => {
  const projectDirectory = await mkdtemp(path.join(tmpdir(), "media-warm-"));
  try {
    const { PNG } = (await import("pngjs")).default;
    const png = PNG.sync.write(new PNG({ width: 2000, height: 1000 }));
    const file = "Outputs/story/page-001/candidate-44444444-4444-4444-8444-444444444444/image.png";
    await mkdir(path.dirname(path.join(projectDirectory, file)), { recursive: true });
    await writeFile(path.join(projectDirectory, file), png);
    await warmMediaVariants(projectDirectory, file);
    const cached = await readdir(path.join(projectDirectory, "Saved", "media-cache"));
    assert.equal(cached.length, MEDIA_VARIANT_WIDTHS.length, "每个档位各生成一份缓存");
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});


test("Agent 草稿与网页共用窄写入：无关页面放行，目标和 Prompt 依赖变化拒绝陈旧保存", async context => {
  let first;
  let second;
  const { origin, projectRoot } = await startCurrentProjectServer(context, { beforeServer: async ({ projectRoot }) => {
    first = await createStoryPage(projectRoot, "current-story", "doorstep");
    second = await createStoryPage(projectRoot, "current-story", "doorstep");
  } });
  const base = "/api/projects/current-story/workbench";
  const call = async (route, body, method = "POST") => {
    const response = await fetch(origin + route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const view = await (await fetch(origin + base)).json();
  const [page, other] = view.outline.chapters[0].sequences[0].pages;
  const begin = await call("/api/agent/facts/story/narrative/read", { project_id: "current-story", target_id: first.page_id });
  assert.equal(begin.status, 200);
  const draft = begin.body.document;
  draft.title = "Agent 的修改";
  const content = p => ({ title: p.title, scene_description: p.scene_description, characters: p.characters, dialogue: p.dialogue });
  assert.equal((await call(base + "/page-content", { page_key: other.page_key, expected_sha256: other.content_sha256, content: { ...content(other), title: "另一页" } }, "PUT")).status, 200);
  const promptRequest = { kind: "story", page_id: first.page_id, prompt: page.prompt, expected_sha256: page.prompt_sha256, expected_context_sha256: page.prompt_context_sha256 };
  assert.equal((await call(base + "/page-prompt", promptRequest, "PUT")).status, 200, "无关页面变化不能阻塞 Prompt 保存");
  assert.equal((await call("/api/agent/facts/story/narrative/save", begin.body)).status, 200);
  const stalePrompt = await call(base + "/page-prompt", promptRequest, "PUT");
  assert.equal(stalePrompt.status, 409);
  assert.equal(stalePrompt.body.error, "page_prompt_upstream_conflict");
  const current = (await (await fetch(origin + base)).json()).outline.chapters[0].sequences[0].pages[0];
  assert.equal(current.title, "Agent 的修改");
  const pending = await call("/api/agent/facts/story/narrative/read", { project_id: "current-story", target_id: first.page_id });
  const changed = await call(base + "/page-content", { page_key: current.page_key, expected_sha256: current.content_sha256, content: { ...content(current), title: "网页的新修改" } }, "PUT");
  assert.equal(changed.status, 200);
  const refreshedPrompt = await call(base + "/page-prompt", { ...promptRequest, expected_context_sha256: changed.body.prompt_context_sha256 }, "PUT");
  assert.equal(refreshedPrompt.status, 200, "内容保存返回新依赖指纹，紧接着可保存 Prompt");
  const conflict = await call("/api/agent/facts/story/narrative/save", pending.body);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "fact_target_conflict");
  assert.equal(JSON.parse(await readFile(path.join(projectRoot, "workspace/current-story/pages", first.page_id + ".content.json"))).title, "网页的新修改");
  assert.equal(pending.body.document.title, "Agent 的修改", "冲突保留可编辑草稿");
});

test("Agent read/save 共用领域规则，依赖冲突与 LoRA 分离在无文件草稿时仍然有效", async context => {
  let storyPage;
  let characterPage;
  const { origin, projectRoot } = await startCurrentProjectServer(context, { beforeServer: async ({ projectRoot }) => {
    storyPage = await createStoryPage(projectRoot, "current-story", "doorstep");
    await createCharacter(projectRoot, "current-story", "ellen", { name: "艾莲" });
    characterPage = await createCharacterPage(projectRoot, "current-story", "ellen", "default");
  } });
  const call = async (domain, kind, action, body, expectedStatus = 200) => {
    const response = await fetch(`${origin}/api/agent/facts/${domain}/${kind}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(result));
    return result;
  };
  const read = (domain, kind, targetId) => call(domain, kind, "read", { project_id: "current-story", target_id: targetId });
  for (const route of ["facts/story/narrative/edit", "facts/story/narrative/write", "project-create/edit", "project-create/write"]) {
    const response = await fetch(`${origin}/api/agent/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 404, "旧会话接口必须移除：" + route);
  }
  for (const [domain, kind] of [["story", "outline"], ["story", "index"], ["character", "page-index"]]) {
    const draft = await read(domain, kind);
    const result = await call(domain, kind, "save", draft);
    assert.deepEqual(result.value, draft.document);
  }
  for (const [pageKey, domain, kind] of [
    [{ page_id: storyPage.page_id }, "page", "prompt"],
    [{ page_id: characterPage.page_id }, "page", "prompt"],
  ]) {
    const response = await fetch(`${origin}/api/agent/prompt-context`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: "current-story", page_key: pageKey }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result.page_key, pageKey);
    assert.deepEqual(result.draft, await read(domain, kind, pageKey.page_id));
    assert.deepEqual(result.save, { domain, kind });
    assert.equal(Object.hasOwn(result.draft, "context"), false, "只读上下文不混入保存正文");
  }
  const prompt = await read("story", "prompt", storyPage.page_id);
  const narrative = await read("story", "narrative", storyPage.page_id);
  await call("story", "narrative", "save", { ...narrative, expected_context_sha256: undefined }, 400);
  narrative.document.scene_description = "女孩站在门口";
  assert.equal((await call("story", "narrative", "save", narrative)).value.scene_description, "女孩站在门口");
  assert.equal((await call("story", "prompt", "save", prompt, 409)).error, "fact_upstream_conflict");
  const freshPrompt = await read("story", "prompt", storyPage.page_id);
  freshPrompt.document.text = "女孩站在安静的门口。";
  const savedPrompt = await call("story", "prompt", "save", freshPrompt);
  assert.equal(savedPrompt.value.text, "女孩站在安静的门口。");
  for (const [domain, kind, targetId, change, field, expected] of [
    ["character", "profile", "ellen", document => { document.name = "新名字"; }, value => value.name, "新名字"],
    ["character", "visual", "ellen", document => { document.variants[0].name = "日常服"; }, value => value.variants[0].name, "日常服"],
    ["page", "content", characterPage.page_id, document => { document.scene_description = "验证目标"; }, value => value.scene_description, "验证目标"],
    ["page", "prompt", characterPage.page_id, document => { document.text = "干净背景。"; }, value => value.text, "干净背景。"],
  ]) {
    const draft = await read(domain, kind, targetId);
    change(draft.document);
    const saved = await call(domain, kind, "save", draft);
    assert.equal(field(saved.value), expected, kind);
    assert.deepEqual(JSON.parse(await readFile(saved.target_file, "utf8")), saved.value);
  }
  const characterPrompt = await read("character", "prompt", "ellen");
  characterPrompt.document.variants.default.text = "银发少女。";
  const characterSaved = await call('character', 'prompt', 'save', characterPrompt);
  assert.equal(characterSaved.value.variants.default.text, "银发少女。");
  const staleCharacterPrompt = await call('character', 'prompt', 'save', characterPrompt, 409);
  assert.equal(staleCharacterPrompt.error, 'fact_target_conflict');
  const lora = await call("character", "lora", "read", { project_id: "current-story", target_id: "ellen" }, 400);
  assert.equal(lora.error, "fact_draft_not_supported");
  const draftsDirectory = path.join(projectRoot, "Saved/state/edit-sessions/current-story");
  await assert.rejects(readdir(draftsDirectory), { code: "ENOENT" });
});

test("真实 CLI 经服务创建与管理项目，支持 stdin 事实提交，并返回纯 JSON 结果和结构化错误", async context => {
  let submitted;
  const { origin, projectRoot } = await startCurrentProjectServer(context, { createProject: false,
    workbenchRenderLauncher: async ({ value }) => {
      submitted = value;
      return { task_id: "render-20260908T010203Z-12345678", status: "queued", page_key: value.page_key, count: value.count };
    },
  });
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");
  const scripts = path.join(projectRoot, "app/scripts");
  await mkdir(scripts, { recursive: true });
  for (const file of ["workbench-client.mjs", "workbench-api.mjs", "create-project.mjs", "story-page.mjs", "character-fact.mjs", "manage-project.mjs", "visual-production.mjs"]) await cp(path.join(source, file), path.join(scripts, file));
  await mkdir(path.join(projectRoot, "app/server"), { recursive: true });
  await cp(path.resolve(source, "../server/page-key.mjs"), path.join(projectRoot, "app/server/page-key.mjs"));
  await mkdir(path.join(projectRoot, "Config"), { recursive: true });
  await writeFile(path.join(projectRoot, "Config/local.json"), JSON.stringify({ port: Number(new URL(origin).port) }));
  const cliInput = (file, args, input) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(scripts, file), ...args], (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stdout, stderr }));
      try { assert.equal(stderr, ""); resolve(stdout.trim()); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
  const cli = (file, ...args) => cliInput(file, args);
  const template = JSON.parse(await cli("create-project.mjs", "template", "cli-story"));
  const draft = template.document;
  draft.metadata.title = "命令行项目";
  draft.outline.chapters[0].sequences = [{ id: "intro", title: "开场", summary: "简单开场。" }];
  assert.equal(JSON.parse(await cliInput("create-project.mjs", ["create", "-"], JSON.stringify(template))).id, "cli-story");
  const summary = JSON.parse(await cli("story-page.mjs", "sequence", "read", "cli-story", "intro"));
  summary.document.summary = "门口相遇。";
  const summaryResult = JSON.parse(await cliInput("story-page.mjs", ["sequence", "save", "-"], JSON.stringify(summary)));
  assert.deepEqual(summaryResult.value, { title: "开场", summary: "门口相遇。" });
  const outlineContext = JSON.parse(await cli("story-page.mjs", "context", "read", "cli-story", "intro"));
  assert.equal(outlineContext.chapter.sequences[0].summary, "门口相遇。");
  const page = JSON.parse(await cli("story-page.mjs", "page", "create", "cli-story", "intro"));
  const smallDraft = JSON.parse(await cli("story-page.mjs", "narrative", "read", "cli-story", page.page_id));
  smallDraft.document.title = "管道中的中文标题";
  const saved = JSON.parse(await cliInput("story-page.mjs", ["narrative", "save", "-"], JSON.stringify(smallDraft)));
  assert.equal(saved.value.title, "管道中的中文标题");
  assert.equal(JSON.parse(await readFile(saved.target_file, "utf8")).title, "管道中的中文标题");
  const viaApi = JSON.parse(await cliInput("workbench-api.mjs", ["POST", "/api/agent/facts/story/narrative/read", "--body", "-"], "\uFEFF" + JSON.stringify({ project_id: "cli-story", target_id: page.page_id })));
  assert.equal(viaApi.value.document.title, "管道中的中文标题");
  assert.match(viaApi.value.expected_context_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(viaApi.value.expected_sha256, smallDraft.expected_sha256);
  await assert.rejects(cliInput("story-page.mjs", ["narrative", "save", "-"], JSON.stringify(smallDraft)), error => {
    assert.equal(JSON.parse(error.stderr).error, "fact_target_conflict");
    assert.equal(error.stdout, "");
    return true;
  });
  const queued = JSON.parse(await cli("visual-production.mjs", "render", "page", "cli-story", "v3/" + page.page_id, "--count", "2", "--seed", "42"));
  assert.equal(queued.status, "queued");
  assert.deepEqual(submitted, { page_key: { page_id: page.page_id }, operation: "candidates", count: 2, seed: 42 });
  const renamed = JSON.parse(await cli("manage-project.mjs", "rename", "cli-story", "renamed-story"));
  assert.equal(renamed.project.id, "renamed-story");
  const copied = JSON.parse(await cli("manage-project.mjs", "copy", "renamed-story"));
  assert.equal(copied.copied, true);
  assert.notEqual(copied.project.id, "renamed-story");
  await assert.rejects(cli("story-page.mjs", "narrative", "write", "removed-entry"), error => {
    const output = JSON.parse(error.stderr);
    assert.equal(output.error, "command_failed");
    assert.equal(error.stdout, "");
    return true;
  });
});
