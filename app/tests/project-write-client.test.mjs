import assert from "node:assert/strict";
import test from "node:test";

test("项目事实替换会作废在途和尚未发出的旧工作台写入", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const browserWindow = new EventTarget();
  browserWindow.location = { origin: "http://story-canvas.local" };
  globalThis.window = browserWindow;

  let resolveFirstRequest;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Promise((resolve) => { resolveFirstRequest = resolve; });
  };

  try {
    const client = await import(`../src/project-write-client.ts?test=${Date.now()}`);
    client.setProjectWriteRevision("paper-moon", "instance:1:disk");

    const first = client.mutateFacts("/api/projects/paper-moon/project", {
      method: "PUT",
      body: JSON.stringify({ title: "先提交" }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requestCount, 1);
    const generationBeforeQueuedWrite = client.getProjectWriteGeneration("paper-moon");
    assert.equal(client.isProjectWritePending("paper-moon"), true);

    const queued = client.mutateFacts("/api/projects/paper-moon/project", {
      method: "PUT",
      body: JSON.stringify({ title: "应丢弃的旧输入" }),
    });
    assert.notEqual(client.getProjectWriteGeneration("paper-moon"), generationBeforeQueuedWrite, "新写入必须使在途后台快照过期");
    client.invalidateProjectWriteQueue("paper-moon");
    resolveFirstRequest(new Response("{}", {
      status: 200,
      headers: { "x-story-canvas-revision": "instance:2:disk" },
    }));

    assert.equal((await first).status, 409, "失效后的在途响应不能更新客户端 revision");
    const rejected = await queued;
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { error: "project_revision_conflict" });
    assert.equal(requestCount, 1, "旧写入必须在到达 Node 服务前被丢弃");
    assert.equal(client.isProjectWritePending("paper-moon"), false);

    let nextExpectedRevision;
    globalThis.fetch = async (_input, init) => {
      nextExpectedRevision = new Headers(init.headers).get("x-story-canvas-expected-revision");
      return new Response("{}", { status: 200, headers: { "x-story-canvas-revision": "instance:3:disk" } });
    };
    assert.equal((await client.mutateFacts("/api/projects/paper-moon/project", { method: "PUT", body: "{}" })).status, 200);
    assert.equal(nextExpectedRevision, "instance:1:disk", "失效响应返回的 revision 不能污染下一次写入");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
test("浏览器收到 revision 冲突不自动读取或替换当前 revision", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const browserWindow = new EventTarget();
  browserWindow.location = { origin: "http://story-canvas.local" };
  globalThis.window = browserWindow;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ error: "project_revision_conflict" }), {
      status: 409,
      headers: { "content-type": "application/json", "x-story-canvas-revision": "instance:newer:disk" },
    });
  };
  try {
    const client = await import(`../src/project-write-client.ts?conflict=${Date.now()}`);
    client.setProjectWriteRevision("paper-moon", "instance:loaded:disk");
    const response = await client.mutateFacts("/api/projects/paper-moon/project", { method: "PUT", body: "{}" });
    assert.equal(response.status, 409);
    assert.equal(requests, 1);
    assert.equal(client.getProjectWriteRevision("paper-moon"), "instance:loaded:disk");
    assert.equal(client.isProjectRefreshRequired("paper-moon"), true);
    assert.equal(response.headers.get("x-story-canvas-refresh-required"), "true");
    client.acceptProjectSnapshot("paper-moon", "instance:newer:disk");
    assert.equal(client.isProjectRefreshRequired("paper-moon"), false);
    assert.equal(client.getProjectWriteRevision("paper-moon"), "instance:newer:disk");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
test("显式项目 Interface 使用各自的队列和 revision 规则", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const browserWindow = new EventTarget();
  browserWindow.location = { origin: "http://story-canvas.local" };
  globalThis.window = browserWindow;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const request = { path: new URL(String(input), browserWindow.location.origin).pathname, revision: headers.get("x-story-canvas-expected-revision"), method: init?.method ?? "GET" };
    requests.push(request);
    const responseHeaders = request.path.endsWith("/project") || request.path.endsWith("/render")
      ? { "x-story-canvas-revision": `instance:${requests.length}:disk` }
      : undefined;
    return new Response("{}", { status: 200, headers: responseHeaders });
  };

  try {
    const client = await import(`../src/project-write-client.ts?test=${Date.now()}`);
    client.setProjectWriteRevision("paper-moon", "instance:1:disk");

    const read = await client.readFacts("/api/projects/paper-moon/workbench", { method: "GET" });
    const derived = await client.mutateDerived("/api/projects/paper-moon/workbench/candidate", { method: "DELETE" });
    assert.equal(read.status, 200);
    assert.equal(derived.status, 200);
    assert.deepEqual(requests.map(({ path, revision }) => ({ path, revision })), [
      { path: "/api/projects/paper-moon/workbench", revision: null },
      { path: "/api/projects/paper-moon/workbench/candidate", revision: null },
    ]);

    const missingRevision = await client.mutateFacts("/api/projects/paper-moon/project", { method: "PUT" });
    assert.equal(missingRevision.status, 200);
    assert.equal(requests.length, 3, "读事实和本机派生不应被事实写队列拦截");

    client.setProjectWriteRevision("paper-moon", "instance:4:disk");
    const fact = await client.mutateFacts("/api/projects/paper-moon/project", { method: "PUT" });
    assert.equal(fact.status, 200);
    assert.deepEqual(requests.at(-1), { path: "/api/projects/paper-moon/project", revision: "instance:4:disk", method: "PUT" });
    assert.equal(client.getProjectWriteRevision("paper-moon"), "instance:4:disk", "成功响应 revision 应成为下一次事实操作的 expected revision");

    const nextDerived = await client.deriveFromFacts("/api/projects/paper-moon/render", { method: "POST" });
    assert.equal(nextDerived.status, 200);
    assert.deepEqual(requests.at(-1), { path: "/api/projects/paper-moon/render", revision: "instance:4:disk", method: "POST" });

    await client.copyProject("/api/projects/paper-moon/copy", { method: "POST" });
    assert.deepEqual(requests.at(-1), { path: "/api/projects/paper-moon/copy", revision: "instance:5:disk", method: "POST" });
    await client.renameProject("/api/projects/paper-moon/rename", { method: "POST" });
    assert.deepEqual(requests.at(-1), { path: "/api/projects/paper-moon/rename", revision: "instance:5:disk", method: "POST" });
    assert.equal(client.getProjectWriteRevision("paper-moon"), "instance:5:disk", "生命周期响应没有 revision 时保留 source project revision");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("checkpoint PUT 与 DELETE 使用不同显式语义，且 DELETE 不携带 expected revision", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const browserWindow = new EventTarget();
  browserWindow.location = { origin: "http://story-canvas.local" };
  globalThis.window = browserWindow;
  const requests = [];
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ revision: headers.get("x-story-canvas-expected-revision") });
    return new Response("{}", { status: 200, headers: { "x-story-canvas-revision": "instance:next:disk" } });
  };
  try {
    const client = await import(`../src/project-write-client.ts?test=${Date.now()}`);
    client.setProjectWriteRevision("paper-moon", "instance:checkpoint:disk");
    await client.mutateFacts("/api/projects/paper-moon/lora-training/tasks/t/runs/r/checkpoints/c", { method: "PUT" });
    await client.mutateDerived("/api/projects/paper-moon/lora-training/tasks/t/runs/r/checkpoints/c", { method: "DELETE" });
    assert.deepEqual(requests, [
      { revision: "instance:checkpoint:disk" },
      { revision: null },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("项目操作和项目资源必须选择显式 Interface", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const browserWindow = new EventTarget();
  browserWindow.location = { origin: "http://story-canvas.local" };
  globalThis.window = browserWindow;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
  try {
    const client = await import(`../src/project-write-client.ts?test=${Date.now()}`);
    await assert.rejects(
      () => client.workbenchFetch("/api/projects/paper-moon/project", { method: "PUT" }),
      /必须使用显式项目 Interface/,
    );
    assert.equal(called, false);

    await assert.rejects(
      () => client.workbenchFetch("/api/projects/paper-moon/workbench"),
      /必须使用显式项目 Interface/,
    );
    assert.equal(called, false, "项目事实 GET 不能绕过 readFacts Interface");

    await client.readProjectResource("/api/projects/paper-moon/media/output/base/story/page.png");
    assert.equal(called, true, "项目媒体读取不属于项目操作协议");
    called = false;

    await assert.rejects(
      () => client.workbenchFetch("/api/projects/paper-moon/media/output/base/story/page.png"),
      /必须使用显式项目 Interface/,
    );
    await assert.rejects(
      () => client.readProjectResource("/api/projects/paper-moon/materials/file/extra"),
      /必须使用受支持的 GET 资源路径/,
    );

    await assert.rejects(
      () => client.workbenchFetch("/api/projects/paper-moon/materials/file", { method: "PUT" }),
      /必须使用显式项目 Interface/,
    );
    assert.equal(called, false, "项目静态资源路径的非 GET 不能绕过项目操作协议");

    await assert.rejects(
      () => client.workbenchFetch("/api/projects/paper-moon/project", {
        method: "PUT",
        headers: {
          "x-story-canvas-expected-revision": "manual-revision",
        },
      }),
      /必须使用显式项目 Interface/,
    );
    assert.equal(called, false, "手工 header 不能绕过显式项目操作 Interface");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("getProjectWriteRevision 返回拦截器记录的最新 revision", async () => {
  const originalWindow = globalThis.window;
  const browserWindow = new EventTarget();
  browserWindow.location = { origin: "http://story-canvas.local" };
  globalThis.window = browserWindow;
  try {
    const client = await import(`../src/project-write-client.ts?test=${Date.now()}`);
    assert.equal(client.getProjectWriteRevision("paper-moon"), null, "未记录过 revision 的项目返回 null");
    client.setProjectWriteRevision("paper-moon", "instance:1:disk");
    assert.equal(client.getProjectWriteRevision("paper-moon"), "instance:1:disk");
    client.clearProjectWriteRevision("paper-moon");
    assert.equal(client.getProjectWriteRevision("paper-moon"), null);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});


test("目标级写入不携带项目 revision，仍参与写队列并接纳服务返回的版本", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://story-canvas.local" } };
  let release;
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init.headers).has("x-story-canvas-expected-revision"), false);
    assert.deepEqual(JSON.parse(init.body), { expected_sha256: "target-sha", content: "草稿" });
    return new Promise(resolve => { release = resolve; });
  };
  try {
    const client = await import(`../src/project-write-client.ts?target=${Date.now()}`);
    const pending = client.mutateTargetFacts("/api/projects/paper-moon/workbench/page-content", { method: "PUT", body: JSON.stringify({ expected_sha256: "target-sha", content: "草稿" }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.isProjectWritePending("paper-moon"), true);
    release(new Response("{}", { headers: { "x-story-canvas-revision": "new-project-revision" } }));
    assert.equal((await pending).status, 200);
    assert.equal(client.getProjectWriteRevision("paper-moon"), "new-project-revision");
    assert.equal(client.isProjectWritePending("paper-moon"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
