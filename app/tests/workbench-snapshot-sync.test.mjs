import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(/^\.\/[\w-]+$/.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { createWorkbenchSnapshotSync } = await import("../src/workbench-snapshot-sync.ts");
const { createProjectRequestGuard } = await import("../src/project-request-guard.ts");
const { registerProjectSnapshotReader } = await import("../src/project-snapshot-sync.ts");
const client = await import("../src/project-write-client.ts");
hooks.deregister();

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(value, revision) {
  return new Response(JSON.stringify(value), { headers: { "x-story-canvas-revision": revision } });
}

function setup(context) {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://test.local" } };
  const requests = [];
  globalThis.fetch = (url, init) => {
    const request = { url, init, ...deferred() };
    requests.push(request);
    return request.promise;
  };
  client.setProjectWriteRevision("demo", "old");
  const guard = createProjectRequestGuard("demo");
  const views = [];
  const sync = createWorkbenchSnapshotSync(guard, (view) => views.push(view));
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
    client.clearProjectWriteRevision("demo");
  });
  return { requests, guard, views, sync };
}

test("工作台等待关联事实准备完毕才一起接纳数据、版本与导航意图", async (context) => {
  const { requests, views, sync } = setup(context);
  const reading = deferred();
  let materials = "旧材料";
  context.after(registerProjectSnapshotReader("demo", async (read) => {
    const pending = read("/api/projects/demo/materials");
    reading.resolve();
    const next = await pending;
    return () => { materials = next.text; };
  }));
  const accepted = [];
  const loading = sync.load("demo", { onApplied: (view) => {
    accepted.push({ view, materials, revision: client.getProjectWriteRevision("demo") });
  } });
  requests[0].resolve(response({ title: "新项目" }, "new"));
  await reading.promise;
  assert.deepEqual(views, []);
  assert.equal(materials, "旧材料");
  assert.equal(client.getProjectWriteRevision("demo"), "old");
  assert.equal(await sync.load("demo", { background: true }), false);
  assert.equal(requests.length, 2, "后台轮询不重复载入正在准备的快照");
  requests[1].resolve(response({ text: "新材料" }, "new"));
  assert.equal(await loading, true);
  assert.deepEqual(views, [{ title: "新项目" }]);
  assert.deepEqual(accepted, [{ view: { title: "新项目" }, materials: "新材料", revision: "new" }]);
  assert.equal(sync.loading, false);
});

test('同项目切换读取范围后，迟到的上一视图不得更新内容或写入版本', async context => {
  const {requests,guard,views} = setup(context);
  let scope = {kind:'page',page_id:'page-001'};
  const sync = createWorkbenchSnapshotSync(guard, view=>views.push(view), ()=>scope);
  const first = sync.load('demo');
  scope = {kind:'page',page_id:'page-002'};
  requests[0].resolve(response({scope:{kind:'page',page_id:'page-001'}}, 'stale'));
  assert.equal(await first, false);
  assert.deepEqual(views, []);
  assert.equal(client.getProjectWriteRevision('demo'), 'old');
  const second = sync.load('demo');
  requests[1].resolve(response({scope}, 'current'));
  assert.equal(await second, true);
  assert.deepEqual(views, [{scope}]);
  assert.equal(client.getProjectWriteRevision('demo'), 'current');
});

test("项目切换、后发读取和取消均阻止旧结果及其导航回调", async (context) => {
  for (const action of ["switch", "newer", "abort"]) {
    await context.test(action, async (t) => {
      const { requests, guard, views, sync } = setup(t);
      const controller = new AbortController();
      let navigated = false;
      const stale = sync.load("demo", { signal: controller.signal, onApplied: () => { navigated = true; } });
      if (action === "switch") guard.activate("other");
      if (action === "abort") controller.abort();
      if (action === "newer") {
        const newer = sync.load("demo");
        requests[1].resolve(response({ title: "最新" }, "latest"));
        assert.equal(await newer, true);
      }
      requests[0].resolve(response({ title: "迟到" }, "stale"));
      assert.equal(await stale, false);
      assert.equal(navigated, false);
      assert.deepEqual(views, action === "newer" ? [{ title: "最新" }] : []);
      assert.equal(client.getProjectWriteRevision("demo"), action === "newer" ? "latest" : "old");
      assert.equal(sync.loading, false);
    });
  }
});

test("关联视图准备期间完成的写入使整组读取过期，即使写入已不再排队", async (context) => {
  const { requests, views, sync } = setup(context);
  const reading = deferred();
  const prepared = deferred();
  let materials = "原材料";
  context.after(registerProjectSnapshotReader("demo", async () => {
    reading.resolve();
    await prepared.promise;
    return () => { materials = "过期材料"; };
  }));
  const loading = sync.load("demo");
  requests[0].resolve(response({ title: "过期" }, "read-revision"));
  await reading.promise;
  const writing = client.mutateFacts("/api/projects/demo/project", { method: "PUT", body: "{}" });
  await Promise.resolve();
  assert.equal(await sync.load("demo", { background: true }), false);
  requests[1].resolve(response({}, "saved"));
  await writing;
  assert.equal(client.isProjectWritePending("demo"), false);
  prepared.resolve();
  assert.equal(await loading, false);
  assert.deepEqual(views, []);
  assert.equal(materials, "原材料");
  assert.equal(client.getProjectWriteRevision("demo"), "saved");
});

test("写入中切走再返回项目，前台载入等待保存后恢复内容与导航，离开的载入失效", async (context) => {
  const { requests, guard, views, sync } = setup(context);
  const writing = client.mutateFacts("/api/projects/demo/project", { method: "PUT", body: "{}" });
  await Promise.resolve();
  let staleNavigated = false;
  const stale = sync.load("demo", { onApplied: () => { staleNavigated = true; } });
  guard.activate("other");
  guard.activate("demo");
  let navigated = false;
  const returned = sync.load("demo", { onApplied: () => { navigated = true; } });
  assert.deepEqual(views, []);
  await new Promise(resolve => setImmediate(resolve));
  requests[0].resolve(response({}, "saved"));
  await writing;
  await stale;
  // 等待写队列结束后，新载入才发出工作台读取。
  await Promise.resolve();
  requests[1].resolve(response({ title: "保存后的项目" }, "saved"));
  assert.equal(await returned, true);
  assert.equal(staleNavigated, false);
  assert.equal(navigated, true);
  assert.deepEqual(views, [{ title: "保存后的项目" }]);
  assert.equal(client.getProjectWriteRevision("demo"), "saved");
});

test("关联视图版本不一致时保留原事实与凭据，并允许下一轮重新加载", async (context) => {
  const { requests, views, sync } = setup(context);
  const reading = deferred();
  let materials = "原材料";
  const unregister = registerProjectSnapshotReader("demo", async (read) => {
    const pending = read("/api/projects/demo/materials");
    reading.resolve();
    const next = await pending;
    return () => { materials = next.text; };
  });
  context.after(unregister);
  let settled = false;
  const loading = sync.load("demo", { onSettled: () => { settled = true; } });
  requests[0].resolve(response({ title: "不能接纳" }, "r1"));
  await reading.promise;
  requests[1].resolve(response({ text: "另一版材料" }, "r2"));
  await assert.rejects(loading, /同步期间发生变化/);
  assert.deepEqual(views, []);
  assert.equal(materials, "原材料");
  assert.equal(client.getProjectWriteRevision("demo"), "old");
  assert.equal(settled, true);
  assert.equal(sync.loading, false);
  unregister();
  const retry = sync.load("demo", { background: true });
  requests[2].resolve(response({ title: "重读成功" }, "r2"));
  assert.equal(await retry, true);
  assert.deepEqual(views, [{ title: "重读成功" }]);
  assert.equal(client.getProjectWriteRevision("demo"), "r2");
});

test('前台计时关联请求，后台载入不上报，日志失败不影响载入', async context => {
  const {requests,sync} = setup(context);
  const previous = Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const reports=[];
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{sendBeacon:(url,body)=>{reports.push({url,body});return true;}}});
  context.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;});
  const pending=sync.load('demo');
  requests[0].resolve(response({title:'ready'},'new'));
  assert.equal(await pending,true);
  const record=JSON.parse(await reports[0].body.text());
  assert.equal(reports[0].url,'/api/performance');
  assert.equal(record.request_id,new Headers(requests[0].init.headers).get('x-story-canvas-request-id'));
  assert.equal(record.outcome,'applied');
  assert.ok(record.duration_ms>=0);
  const background=sync.load('demo',{background:true});
  requests[1].resolve(response({title:'ready'},'new'));
  await background;
  assert.equal(reports.length,1);
  globalThis.navigator.sendBeacon=()=>{throw new Error('offline');};
  const final=sync.load('demo');
  requests[2].resolve(response({title:'ready'},'new'));
  assert.equal(await final,true);
});
