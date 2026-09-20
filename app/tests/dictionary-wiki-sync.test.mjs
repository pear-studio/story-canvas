import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncDictionaryWiki } from "../scripts/dictionary-wiki-sync.mjs";

const row = (id, title, body = `Definition of ${title}`, extra = {}) => ({
  id, title, body, other_names: [], is_deleted: false,
  updated_at: "2026-08-01T10:00:00Z", ...extra,
});

async function fixture(t, tags, respond) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dictionary-wiki-test-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, "danbooru.csv"), tags.map((tag) => `${tag},0,10,`).join("\n"));
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push(url);
    const result = respond(url);
    response.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return {
    directory,
    requests,
    read: async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")),
    run: (options = {}) => syncDictionaryWiki({
      directory,
      checkpointFile: path.join(directory, "checkpoint.json"),
      apiUrl: `http://127.0.0.1:${server.address().port}/wiki_pages.json`,
      limit: 2, intervalMs: 0, retryMs: 0, log() {}, ...options,
    }),
  };
}

test("完整抓取按最大 ID 续传，保留正文和其他名称，遍历结束才判断无说明", async (t) => {
  const body = "h4. Definition\n\nA [[wave_breaker]].\n\n* !post #12345\n\"Source\":https://example.org/\n";
  const pages = new Map([
    ["a0", [row(5, "outside_csv"), row(2, "tetrapod", body, { other_names: ["テトラポッド", "Wave breaker"] })]],
    ["a5", [row(9, "guimpe")]],
    ["a9", []],
  ]);
  const f = await fixture(t, ["tetrapod", "guimpe", "no_definition"], (url) => ({ body: pages.get(url.searchParams.get("page")) }));
  const partial = await f.run({ maxPages: 1 });
  assert.equal(partial.sync.status, "partial");
  assert.equal(partial.entries.no_definition, undefined);
  await assert.rejects(readFile(path.join(f.directory, "wiki.json")), { code: "ENOENT" });
  const complete = await f.run();
  assert.deepEqual(f.requests.map((url) => url.searchParams.get("page")), ["a0", "a5", "a9"]);
  assert.deepEqual(await f.read("wiki.json"), {
    guimpe: { body: "Definition of guimpe", other_names: [] },
    tetrapod: { body, other_names: ["テトラポッド", "Wave breaker"] },
  });
  assert.equal(complete.sync.status, "complete");
  assert.deepEqual(complete.summary, { tags: 3, wiki_entries: 2, with_body: 2, with_other_names: 1, no_wiki: 1 });
  assert.equal(complete.entries.no_definition.status, "no_wiki");
  assert.equal(complete.entries.outside_csv, undefined);
});

test("失败和无效响应不替换正式资料，续传成功才发布已获取的新正文", async (t) => {
  let mode = "initial";
  const f = await fixture(t, ["tetrapod", "guimpe"], (url) => {
    const cursor = url.searchParams.get("page");
    if (mode === "initial") return { body: cursor === "a0" ? [row(2, "tetrapod", "Old body")] : [] };
    if (cursor === "a0") return { body: [row(2, "tetrapod", "New body")] };
    if (mode === "denied") return { status: 403, body: { error: "denied" } };
    if (mode === "invalid") return { body: { error: "not a wiki page array" } };
    return { body: [] };
  });
  await f.run();
  const oldWiki = await readFile(path.join(f.directory, "wiki.json"), "utf8");
  const oldMetadata = await readFile(path.join(f.directory, "wiki-metadata.json"), "utf8");
  mode = "denied";
  await assert.rejects(f.run({ full: true }), /HTTP 403/);
  let checkpoint = await f.read("checkpoint.json");
  assert.equal(checkpoint.metadata.sync.status, "failed");
  assert.equal(checkpoint.metadata.sync.after_id, 2);
  assert.equal(checkpoint.metadata.entries.guimpe, undefined);
  assert.equal(checkpoint.wiki.tetrapod.body, "New body");
  mode = "invalid";
  await assert.rejects(f.run(), /未返回数组/);
  assert.equal(await readFile(path.join(f.directory, "wiki.json"), "utf8"), oldWiki);
  assert.equal(await readFile(path.join(f.directory, "wiki-metadata.json"), "utf8"), oldMetadata);
  mode = "resume";
  await f.run();
  assert.equal((await f.read("wiki.json")).tetrapod.body, "New body");
  assert.equal((await f.read("wiki-metadata.json")).entries.guimpe.status, "no_wiki");
  assert.deepEqual(f.requests.slice(-2).map((url) => url.searchParams.get("page")), ["a2", "a2"]);
});

test("增量包含时间筛选并更新改名与删除，未变化说明完整保留", async (t) => {
  let incremental = false;
  const f = await fixture(t, ["old_name", "new_name", "deleted", "unchanged"], (url) => {
    const cursor = url.searchParams.get("page");
    const pages = incremental
      ? {
        a0: [row(2, "deleted", "Deleted body", { is_deleted: true }), row(1, "new_name", "Renamed body")],
        a2: [row(4, "outside_csv")], a4: [],
      }
      : {
        a0: [row(2, "deleted"), row(1, "old_name")],
        a2: [row(4, "new_name", "Body of former page"), row(3, "unchanged", "Preserved body", { other_names: ["変更なし"] })], a4: [],
      };
    return { body: pages[cursor] };
  });
  const first = await f.run();
  incremental = true;
  const next = await f.run();
  assert.equal(next.sync.mode, "incremental");
  assert.equal(next.sync.since, first.sync.started_at);
  for (const url of f.requests.slice(-3)) assert.equal(url.searchParams.get("search[updated_at]"), `>=${first.sync.started_at}`);
  assert.deepEqual(await f.read("wiki.json"), {
    new_name: { body: "Renamed body", other_names: [] },
    unchanged: { body: "Preserved body", other_names: ["変更なし"] },
  });
  assert.equal(next.entries.old_name.status, "no_wiki");
  assert.equal(next.entries.deleted.status, "no_wiki");
  assert.equal(next.entries.deleted.is_deleted, true);
  assert.equal(next.entries.new_name.page_id, 1);
  assert.equal(next.entries.unchanged.page_id, 3);
});
