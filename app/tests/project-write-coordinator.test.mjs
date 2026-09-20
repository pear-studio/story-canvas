import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createProjectWriteCoordinator, isProjectFactChange } from "../server/project-write-coordinator.mjs";

import {
  createProjectOperations,
  projectCredentialFromRequest,
} from "../server/project-operations.mjs";

async function makeProject(t, { name = "project", title = "初始项目" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-project-operations-"));
  const projectDirectory = path.join(root, "workspace", name);
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(path.join(projectDirectory, "project.json"), JSON.stringify({ title }));
  t.after(() => rm(root, { recursive: true, force: true }));
  registerFixtureProjects(root); return { root, projectDirectory, projectId: name };
}

function browser(expectedRevision = null) {
  return { expectedRevision };
}

test("revision 轮询复用缓存，CLI 事实变化失效；任务媒体不触发扫描", async (t) => {
  const project = await makeProject(t);
  let changed;
  let closed = false;
  const watcher = new EventEmitter();
  watcher.close = () => { closed = true; };
  const coordinator = createProjectWriteCoordinator({ watchDirectory: (_root, _options, callback) => { changed = callback; return watcher; } });
  t.after(() => coordinator.close());
  const initial = await coordinator.getObservedState(project.projectDirectory);
  await writeFile(path.join(project.projectDirectory, "project.json"), JSON.stringify({ title: "外部 Agent 已保存" }));
  assert.equal(await coordinator.getObservedState(project.projectDirectory), initial, "没有变化通知时不重新扫描事实");
  changed("rename", "Saved/render/active/task/state.json");
  changed("rename", "cache/candidate-selection-state.json");
  assert.equal(await coordinator.getObservedState(project.projectDirectory), initial);
  changed("rename", "project.json");
  const latest = await coordinator.getObservedState(project.projectDirectory);
  assert.notEqual(latest, initial);
  assert.equal(await coordinator.getObservedState(project.projectDirectory), latest);
  coordinator.close();
  assert.equal(closed, true);
  for (const filename of ["pages/index.json", "scenes/example.prompt.json", "characters/a.prompt.json", "lettering", null]) {
    assert.equal(isProjectFactChange(filename), true);
  }
  for (const filename of ["Saved/render/state.json", "output/base/page.png", "cache/preview-state.json"]) {
    assert.equal(isProjectFactChange(filename), false);
  }
});

test("ProjectOperations 暴露事实写入、事实派生和本机派生的不同并发语义", async (t) => {
  const project = await makeProject(t);
  const operations = createProjectOperations({ projectRoot: project.root });
  const initial = await operations.state(project.projectId);

  await assert.rejects(
    () => operations.mutateFacts(project.projectId, browser(), async () => undefined),
    (error) => error.code === "expected_project_revision_required" && error.status === 428,
  );

  const fact = await operations.mutateFacts(project.projectId, browser(initial), async ({ projectDirectory }) => {
    const target = path.join(projectDirectory, "creative-agreement.json");
    await writeFile(target, JSON.stringify({ version: 1, constraints: [] }));
    return "fact-result";
  });
  assert.equal(fact.value, "fact-result");
  assert.notEqual(fact.revision, initial);

  const derived = await operations.deriveFromFacts(project.projectId, browser(fact.revision), async () => "frozen");
  assert.equal(derived.value, "frozen");
  assert.equal(derived.revision, fact.revision);

  const derivedState = await operations.mutateDerived(project.projectId, async ({ projectDirectory }) => {
    await writeFile(path.join(projectDirectory, "derived-state.json"), "local");
    return "local-result";
  });
  assert.equal(derivedState.value, "local-result");
  assert.equal((await operations.state(project.projectId)), fact.revision);

  const beforeFailure = await operations.state(project.projectId);
  await assert.rejects(
    () => operations.mutateFacts(project.projectId, browser(beforeFailure), async () => { throw new Error("mutation failed"); }),
    /mutation failed/,
  );
  assert.equal((await operations.state(project.projectId)), beforeFailure);
});

test("旧 revision 的事实写入和事实派生都拒绝，项目事实不被覆盖", async (t) => {
  const project = await makeProject(t);
  let now = 10_000;
  const operations = createProjectOperations({ projectRoot: project.root, now: () => now });
  const initial = await operations.state(project.projectId);
  await operations.mutateFacts(project.projectId, browser(initial), async ({ projectDirectory }) => {
    await writeFile(path.join(projectDirectory, "project.json"), JSON.stringify({ title: "已更新" }));
  });
  const current = await operations.state(project.projectId);

  await assert.rejects(
    () => operations.mutateFacts(project.projectId, browser(initial), async ({ projectDirectory }) => {
      await writeFile(path.join(projectDirectory, "project.json"), JSON.stringify({ title: "不应覆盖" }));
    }),
    (error) => error.code === "project_revision_conflict" && error.status === 409,
  );
  await assert.rejects(
    () => operations.deriveFromFacts(project.projectId, browser(initial), async () => "不应执行"),
    (error) => error.code === "project_revision_conflict" && error.status === 409,
  );
  assert.equal(await readFile(path.join(project.projectDirectory, "project.json"), "utf8"), JSON.stringify({ title: "已更新" }));
  assert.equal(await operations.state(project.projectId), current);
});

test("一致性事实读取只重试一次，嵌套项目 mutation 和项目移动明确失败", async (t) => {
  const project = await makeProject(t);
  const operations = createProjectOperations({ projectRoot: project.root });
  let attempts = 0;
  const read = await operations.readFacts(project.projectId, async ({ projectDirectory }) => {
    attempts += 1;
    if (attempts === 1) {
      await mkdir(path.join(projectDirectory, "materials"), { recursive: true });
      await writeFile(path.join(projectDirectory, "materials", "external.txt"), "changed");
    }
    return attempts;
  });
  assert.equal(attempts, 2);
  assert.equal(read.value, 2);

  let unstableAttempts = 0;
  await assert.rejects(
    () => operations.readFacts(project.projectId, async ({ projectDirectory }) => {
      unstableAttempts += 1;
      await writeFile(path.join(projectDirectory, "materials", `unstable-${unstableAttempts}.txt`), "changed");
      return unstableAttempts;
    }),
    (error) => error.code === "project_changed_during_read" && error.status === 409,
  );

  await assert.rejects(
    () => operations.mutateDerived(project.projectId, () => operations.mutateDerived(project.projectId, async () => undefined)),
    (error) => error.code === "nested_project_operation" && error.status === 500,
  );

  const second = await makeProject(t, { name: "moved-project" });
  const secondOps = createProjectOperations({ projectRoot: second.root });
  const secondState = await secondOps.state(second.projectId);
  let releaseFirst;
  const firstEntered = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const first = secondOps.mutateDerived(second.projectId, async () => {
    markEntered();
    await firstEntered;
  });
  await entered;
  const renameOperation = secondOps.renameProject(second.projectId, browser(secondState), async (context) => {
    assert.equal(context.projectId, second.projectId);
    assert.equal(Object.hasOwn(context, "state"), false);
    const { projectDirectory } = context;
    const nextDirectory = path.join(second.root, "workspace", "moved-project-renamed");
    await rename(projectDirectory, nextDirectory);
    registerFixtureProjects(second.root);
    return { id: "moved-project-renamed", directory: "workspace/moved-project-renamed" };
  });
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = secondOps.mutateDerived(second.projectId, async () => undefined);
  releaseFirst();
  await first;
  await renameOperation;
  await assert.rejects(
    () => waiting,
    (error) => error.code === "project_moved" && error.status === 409,
  );
});

test("复制项目返回源项目 revision，副本在切换后独立载入自己的 revision", async (t) => {
  const project = await makeProject(t);
  const operations = createProjectOperations({ projectRoot: project.root });
  const sourceRevision = await operations.state(project.projectId);
  const copied = await operations.copyProject(project.projectId, browser(sourceRevision), async () => {
    const copiedDirectory = path.join(project.root, "workspace", "project-copy");
    await mkdir(copiedDirectory, { recursive: true });
    await writeFile(path.join(copiedDirectory, "project.json"), JSON.stringify({ title: "副本项目" }));
    registerFixtureProjects(project.root);
    return { id: "project-copy" };
  });

  assert.equal(copied.revision, sourceRevision);
  assert.notEqual(await operations.state("project-copy"), sourceRevision);
  assert.equal(await operations.state(project.projectId), sourceRevision);
});

test("同项目 mutation 串行、不同项目并行", async (t) => {
  const firstProject = await makeProject(t, { name: "serial-project" });
  const secondProject = {
    root: firstProject.root,
    projectId: "parallel-project",
    projectDirectory: path.join(firstProject.root, "workspace", "parallel-project"),
  };
  await mkdir(secondProject.projectDirectory, { recursive: true });
  await writeFile(path.join(secondProject.projectDirectory, "project.json"), JSON.stringify({ title: "并行项目" }));
  registerFixtureProjects(firstProject.root);
  const operations = createProjectOperations({ projectRoot: firstProject.root });
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => { markFirstEntered = resolve; });
  const first = operations.mutateDerived(firstProject.projectId, async () => {
    markFirstEntered();
    await new Promise((resolve) => { releaseFirst = () => { resolve(); }; });
  });
  await firstEntered;
  let secondStarted = false;
  const second = operations.mutateDerived(firstProject.projectId, async () => { secondStarted = true; });
  let otherFinished = false;
  let markOtherEntered;
  const otherEntered = new Promise((resolve) => { markOtherEntered = resolve; });
  const other = operations.mutateDerived(secondProject.projectId, async () => {
    otherFinished = true;
    markOtherEntered();
  });
  await otherEntered;
  assert.equal(secondStarted, false);
  assert.equal(otherFinished, true);
  releaseFirst();
  await Promise.all([first, second, other]);
  assert.equal(secondStarted, true);
});

test("HTTP 凭据解析只接受浏览器 expected revision", () => {
  assert.deepEqual(projectCredentialFromRequest({ headers: {
    "x-story-canvas-expected-revision": "browser-revision",
  }}), { expectedRevision: "browser-revision" });
  assert.deepEqual(projectCredentialFromRequest({ headers: {
    "x-story-canvas-expected-revision": "browser-revision",
  }}), { expectedRevision: "browser-revision" });
  assert.deepEqual(projectCredentialFromRequest({ headers: {} }), { expectedRevision: null });
});

test("服务重启不会改变未修改项目的 revision，但事实文件变化仍会被发现", async (t) => {
  const project = await makeProject(t);
  const first = createProjectOperations({ projectRoot: project.root });
  const restarted = createProjectOperations({ projectRoot: project.root });
  const beforeRestart = await first.state(project.projectId);
  const afterRestart = await restarted.state(project.projectId);
  assert.equal(afterRestart, beforeRestart);

  await writeFile(path.join(project.projectDirectory, "project.json"), JSON.stringify({ title: "修改后的项目" }));
  assert.notEqual((await restarted.state(project.projectId)), afterRestart);
  assert.equal(await readFile(path.join(project.projectDirectory, "project.json"), "utf8"), JSON.stringify({ title: "修改后的项目" }));

  const beforeLoraImage = await restarted.state(project.projectId);
  await mkdir(path.join(project.projectDirectory, "lora-training", "dataset-a"), { recursive: true });
  await writeFile(path.join(project.projectDirectory, "lora-training", "dataset-a", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal((await restarted.state(project.projectId)), beforeLoraImage);
});
