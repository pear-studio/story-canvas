import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(["./api-response", "./project-write-client"].includes(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { registerProjectSnapshotReader, prepareProjectSnapshotReaders } = await import("../src/project-snapshot-sync.ts");
const client = await import("../src/project-write-client.ts");
hooks.deregister();

test("独立事实视图准备同版本快照后才统一应用并推进写入revision", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  context.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
  globalThis.window = { location: { origin: "http://test.local" } };
  let payload = { text: "Agent更新后的约定" };
  let responseRevision = "new";
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { headers: { "x-story-canvas-revision": responseRevision } });
  client.setProjectWriteRevision("demo", "old");
  let form = { text: "旧约定" };
  const unregister = registerProjectSnapshotReader("demo", async (read) => {
    const next = await read("/api/projects/demo/materials");
    return () => { form = next; };
  });
  context.after(unregister);
  const commit = await prepareProjectSnapshotReaders("demo", "new");
  assert.equal(form.text, "旧约定", "读取不提前打断草稿");
  assert.equal(client.getProjectWriteRevision("demo"), "old");
  commit(); client.acceptProjectSnapshot("demo", "new");
  assert.equal(form.text, payload.text);
  assert.equal(client.getProjectWriteRevision("demo"), "new");
  responseRevision = "newer"; payload = { text: "不能应用混合版本" };
  await assert.rejects(prepareProjectSnapshotReaders("demo", "new"), /同步期间发生变化/);
  assert.equal(form.text, "Agent更新后的约定");
  assert.equal(client.getProjectWriteRevision("demo"), "new");
});

test("事实页在同步途中切换则丢弃快照，不更新已离开的编辑区", async (context) => {
  let applied = false;
  const unregister = registerProjectSnapshotReader("switch", async () => () => { applied = true; });
  context.after(unregister);
  const commit = await prepareProjectSnapshotReaders("switch", "rev");
  unregister();
  assert.throws(commit, /活动事实页已切换/);
  assert.equal(applied, false);
});
