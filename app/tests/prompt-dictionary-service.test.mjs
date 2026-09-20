import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getRenderPromptDictionary, getSearchPromptDictionary } from "../server/prompt-dictionary-service.mjs";

const tags = "tetrapod,0,1000,concrete_jack\nguimpe,0,500,\nrain,0,200,";
const translations = "tetrapod,四脚消波块";
const overlay = {
  tetrapod: { translation: "四脚消波块", categories: ["setting"], keywords: ["防浪块"] },
};

async function makeDictionaryRoot(context, { withOverlay = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "story-dictionary-service-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "library", "prompt-dictionaries");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "danbooru.csv"), tags),
    writeFile(path.join(directory, "zh.csv"), translations),
    withOverlay ? writeFile(path.join(directory, "overlay.json"), JSON.stringify(overlay)) : Promise.resolve(),
  ]);
  registerFixtureProjects(root); return { root, directory };
}

async function bump(target, offsetMs = 2000) {
  const time = new Date(Date.now() + offsetMs);
  await utimes(target, time, time);
}

test("render 词典重复调用复用缓存，源文件变化后重建", async (context) => {
  const { root, directory } = await makeDictionaryRoot(context);
  const first = await getRenderPromptDictionary({}, root);
  const second = await getRenderPromptDictionary({}, root);
  assert.equal(second.entries, first.entries);
  assert.equal(typeof first.identity.tags_sha256, "string");

  const tagsFile = path.join(directory, "danbooru.csv");
  await writeFile(tagsFile, `${tags}\nocean,0,50,`);
  await bump(tagsFile);
  const rebuilt = await getRenderPromptDictionary({}, root);
  assert.notEqual(rebuilt.entries, first.entries);
  assert.ok(rebuilt.entries.some((entry) => entry.source_text === "ocean"));
});

test("并发调用共享同一次构建", async (context) => {
  const { root } = await makeDictionaryRoot(context);
  const [first, second, third] = await Promise.all([
    getRenderPromptDictionary({}, root),
    getRenderPromptDictionary({}, root),
    getRenderPromptDictionary({}, root),
  ]);
  assert.equal(second.entries, first.entries);
  assert.equal(third.entries, first.entries);
});

test("render 与 full 变体各自缓存且语义互不影响", async (context) => {
  const { root } = await makeDictionaryRoot(context, { withOverlay: true });
  const render = await getRenderPromptDictionary({}, root);
  const full = await getSearchPromptDictionary(root, {});
  const renderTetrapod = render.entries.find((entry) => entry.source_text === "tetrapod");
  const fullTetrapod = full.entries.find((entry) => entry.source_text === "tetrapod");
  assert.equal(renderTetrapod.categories, undefined);
  assert.deepEqual(fullTetrapod.categories, ["setting"]);
  assert.equal((await getSearchPromptDictionary(root, {})).entries, full.entries);
});

test("缺失词库文件报可定位错误且失败不会被缓存", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "story-dictionary-service-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "library", "prompt-dictionaries");
  await mkdir(directory, { recursive: true });
  await assert.rejects(() => getRenderPromptDictionary({}, root), /Prompt 审计词库缺失/);

  await Promise.all([
    writeFile(path.join(directory, "danbooru.csv"), tags),
    writeFile(path.join(directory, "zh.csv"), translations),
  ]);
  const loaded = await getRenderPromptDictionary({}, root);
  assert.ok(loaded.entries.length > 0);
});

test("full 词典坏文件报错不缓存，修复后恢复", async (context) => {
  const { root, directory } = await makeDictionaryRoot(context);
  const wikiFile = path.join(directory, "wiki.json");
  await writeFile(wikiFile, "not json");
  await assert.rejects(() => getSearchPromptDictionary(root, {}), /wiki.json 不是合法 JSON/);

  await writeFile(wikiFile, JSON.stringify({ tetrapod: { body: "Revised.", other_names: [] } }));
  await bump(wikiFile);
  const loaded = await getSearchPromptDictionary(root, {});
  assert.equal(loaded.entries.find((entry) => entry.source_text === "tetrapod").description, "Revised.");
});
