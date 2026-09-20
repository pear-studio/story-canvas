import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { candidateFileRelativePath, publishCandidateResult, readGenerationCandidateRecords } from "../server/candidate-storage.mjs";
import { createPageMediaReader } from "../server/page-media.mjs";
import { encodePageKey } from "../server/page-key.mjs";
import { PAGES_INDEX_SCHEMA_ID } from "../server/pages-store.mjs";
import { warmMediaVariants } from "../server/media-variants.mjs";

const story = number => ({ page_id: `page-${String(number).padStart(3, "0")}` });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(context, pageCount = 2, watchDirectory) {
  const root = await mkdtemp(path.join(tmpdir(), "media-index-"));
  const directory = path.join(root, "workspace", "demo");
  await mkdir(path.join(directory, "pages"), { recursive: true });
  await writeFile(path.join(directory, "pages", "index.json"), JSON.stringify({
    $schema: PAGES_INDEX_SCHEMA_ID,
    pages: Array.from({ length: pageCount }, (_, i) => ({ ...story(i + 1), owner_kind: "story", sequence_id: "sequence-001" })),
  }));
  let event, clock = 0, intercept = null, sequence = 0;
  const scans = [];
  const reader = createPageMediaReader({ projectRoot: root, now: () => clock,
    watchDirectory: watchDirectory ?? ((_dir, _options, callback) => { event = callback; return { on() {}, close() {} }; }),
    readCandidateRecords: async (dir, options) => {
      const records = await readGenerationCandidateRecords(dir, options);
      scans.push({ page: options?.pageKey ? encodePageKey(options.pageKey) : "all", records: records.length });
      if (intercept) { const action = intercept; intercept = null; await action(); }
      return records;
    },
  });
  context.after(async () => { reader.close(); await rm(root, { recursive: true, force: true }); });
  async function add(key) {
    const id = `candidate-${String(++sequence).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const file = candidateFileRelativePath(key, id);
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "media fixture");
    await writeFile(path.join(path.dirname(target), "result.json"), JSON.stringify({
      version: 1, candidate_id: id, page_key: key, file, status: "available", task_id: "test-task", generated_at: String(sequence),
    }));
    return file;
  }
  registerFixtureProjects(root);
  return { directory, reader, scans, add, event: file => event("rename", file), advance: (ms = 60_001) => { clock += ms; },
    intercept: action => { intercept = action; }, read: key => reader.read("demo", { page_key: key }) };
}

test("监听启动失败或运行中断后恢复订阅，后续候选无需等待全量复查", async context => {
  for (const initialFailure of [true, false]) await context.test(initialFailure ? "启动失败" : "运行中断", async t => {
    let attempts = 0, event, watcher;
    const f = await fixture(t, 2, (_dir, _options, callback) => {
      attempts += 1;
      if (initialFailure && attempts === 1) throw Object.assign(new Error("暂时不可用"), { code: "EPERM" });
      event = callback;
      watcher = new EventEmitter();
      watcher.close = () => {};
      return watcher;
    });
    await f.read(story(1));
    if (!initialFailure) watcher.emit("error", Object.assign(new Error("监听中断"), { code: "EPERM" }));
    await f.add(story(1));
    f.advance(5_001);
    assert.equal((await f.read(story(1))).media.candidates.length, 1);
    const file = await f.add(story(1));
    event("rename", file);
    assert.equal((await f.read(story(1))).media.candidates.length, 2);
    assert.equal(attempts, 2);
  });
});

test("真实文件通知驱动连续三张原子发布的候选列表和数量更新", { timeout: 15_000 }, async context => {
  // 使用真实发布器与 OS 监听，时钟保持 0，排除周期复查掩盖通知问题。
  const f = await fixture(context, 2, watch);
  await f.read(story(1));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64");
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    const id = `candidate-${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`;
    ids.unshift(id);
    await publishCandidateResult(f.directory, { id: "test-task" }, {
      id: `item-${i}`, candidate_id: id, page_key: story(1), generated_at: String(i),
    }, png);
    const deadline = Date.now() + 3_000;
    let media;
    do {
      media = await f.read(story(1));
      if (media.media.candidates.length === i) break;
      await delay(20);
    } while (Date.now() < deadline);
    assert.deepEqual(media.media.candidates.map(candidate => candidate.candidate_id), ids);
    assert.deepEqual((await f.reader.counts("demo")).counts, { "v3/page-001": i });
    await warmMediaVariants(f.directory, candidateFileRelativePath(story(1), id));
  }
});

test("47页持续出图只扫描变化页，重复通知合并且列表与数量共用结果", async context => {
  const f = await fixture(context, 47);
  for (let page = 1; page <= 47; page++) for (let i = 0; i < 3; i++) await f.add(story(page));
  const before = await f.reader.counts("demo");
  assert.equal(Object.keys(before.counts).length, 47);
  const unchanged = await f.read(story(8));
  f.scans.length = 0;
  const file = await f.add(story(20));
  f.event(file); f.event(file.replaceAll("/", "\\")); f.event(file.replace("image.png", "result.json"));
  const [media, counts] = await Promise.all([f.read(story(20)), f.reader.counts("demo")]);
  assert.equal(media.media.candidates.length, 4);
  assert.deepEqual(counts.counts, { ...before.counts, "v3/page-020": 4 });
  assert.strictEqual(await f.read(story(8)), unchanged);
  assert.deepEqual(f.scans, [{ page: "v3/page-020", records: 4 }]);
  context.diagnostic("47页×3候选：新增1张后的成果记录读取由全量142条缩小为目标页4条。");
});

test("手动刷新只重读当前页并更新数量，遗漏通知由周期和无法定位的通知补偿", async context => {
  const f = await fixture(context);
  await f.add(story(1)); await f.add(story(2));
  const cached = await f.read(story(2));
  await f.add(story(1)); await f.add(story(2));
  f.scans.length = 0;
  const fresh = await f.reader.read("demo", { page_key: story(1) }, { fresh: true });
  assert.equal(fresh.media.candidates.length, 2);
  assert.strictEqual(await f.read(story(2)), cached);
  assert.deepEqual((await f.reader.counts("demo")).counts, { "v3/page-001": 2, "v3/page-002": 1 });
  assert.deepEqual(f.scans, [{ page: "v3/page-001", records: 2 }]);
  f.advance();
  assert.deepEqual((await f.reader.counts("demo")).counts, { "v3/page-001": 2, "v3/page-002": 2 });
  await f.add(story(2)); f.event("Outputs/pages");
  assert.equal((await f.read(story(2))).media.candidates.length, 3);
  assert.deepEqual(f.scans.slice(1).map(scan => scan.page), ["all", "all"]);
});

test("局部与全量扫描途中到达的通知不会丢失，下一轮继续更新", async context => {
  for (const full of [false, true]) await context.test(full ? "全量" : "局部", async t => {
    const f = await fixture(t);
    await f.add(story(1)); await f.reader.counts("demo");
    f.event(await f.add(story(1)));
    if (full) f.advance();
    const entered = deferred(), release = deferred();
    f.intercept(async () => { entered.resolve(); await release.promise; });
    const reading = f.read(story(1));
    await entered.promise;
    f.event(await f.add(story(1)));
    release.resolve();
    assert.equal((await reading).media.candidates.length, 2);
    assert.equal((await f.read(story(1))).media.candidates.length, 3);
    assert.deepEqual((await f.reader.counts("demo")).counts, { "v3/page-001": 3 });
  });
});

test("多种归属的独立页面分别失效，失败的重读保留更新需求", async context => {
  const f = await fixture(context);
  const ellen = { page_id: "page-101" };
  const maria = { page_id: "page-102" };
  await f.add(story(1)); await f.add(ellen); await f.add(maria);
  await f.reader.counts("demo"); f.scans.length = 0;
  f.event(await f.add(story(1))); f.event(await f.add(ellen));
  f.intercept(() => { throw new Error("暂时无法读取"); });
  await assert.rejects(f.reader.counts("demo"), /暂时无法读取/);
  const counts = await f.reader.counts("demo");
  assert.deepEqual(counts.counts, { "v3/page-001": 2, "v3/page-101": 2, "v3/page-102": 1 });
  assert.deepEqual(f.scans.map(scan => scan.page), ["v3/page-001", "v3/page-001", "v3/page-101"]);
});
