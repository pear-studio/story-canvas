import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPromptDictionary, matchPromptDictionary, searchPromptDictionary } from "../server/prompt-dictionary.mjs";
import { createDictionaryReader } from "../server/runtime-http.mjs";

const tags = "tetrapod,0,1000,concrete_jack\nguimpe,0,500,\nrain,0,200,";
const original = "A concrete [[wave_breaker]].\n\nh4. Examples\n* !post #10459522\n";
const wiki = {
  tetrapod: { body: original, other_names: ["テトラポッド", "Concrete Jack"] },
  guimpe: { body: "An article covering the neck and shoulders.", other_names: [] },
};

test("原站其他名称可找到原标签，完整说明保留但不混入搜索", () => {
  const entries = buildPromptDictionary(tags, "", "", JSON.stringify(wiki));
  const [found] = searchPromptDictionary(entries, "テトラポッド", { scope: "page" });
  assert.equal(found.source_text, "tetrapod");
  assert.equal(found.prompt_text, "tetrapod");
  assert.equal(found.description, original);
  assert.equal(found.description_language, "original");
  assert.deepEqual(found.other_names, ["テトラポッド", "Concrete Jack"]);
  assert.equal(searchPromptDictionary(entries, "CONCRETE JACK", { scope: "page" })[0].source_text, "tetrapod");
  assert.deepEqual(searchPromptDictionary(entries, "wave_breaker", { scope: "page" }), []);
  assert.deepEqual(matchPromptDictionary(entries, ["tetrapod"], { scope: "page" })[0], {
    prompt_text: "tetrapod", matched: true, allowed: true, provider_type: "0", provider_category: "general",
    display_text: "tetrapod", source_text: "tetrapod", post_count: 1000,
    description: original, description_language: "original", other_names: wiki.tetrapod.other_names,
    original_description: original, aliases: ["concrete_jack"],
  });
  assert.equal(entries.find((entry) => entry.source_text === "rain").description, undefined);
});

test("中文说明与原文同时保留，候选和已选词均提供完整详情", () => {
  const overlay = {
    tetrapod: { translation: "四脚消波块", categories: ["setting"], keywords: ["防浪块"], description: "四脚混凝土结构。\n\n用于抵抗海浪侵蚀。" },
    guimpe: { translation: "遮颈肩布领", categories: ["clothing"], keywords: [] },
  };
  const entries = buildPromptDictionary(tags, "tetrapod,旧错译", JSON.stringify(overlay), JSON.stringify(wiki));
  const [found] = searchPromptDictionary(entries, "テトラポッド", { scope: "page" });
  assert.equal(found.display_text, "四脚消波块");
  assert.equal(found.description, overlay.tetrapod.description);
  assert.equal(found.description_language, "zh");
  assert.equal(found.original_description, original);
  assert.deepEqual(found.aliases, ["concrete_jack"]);
  assert.deepEqual(found.keywords, ["防浪块"]);
  const [matched] = matchPromptDictionary(entries, ["tetrapod"], { scope: "page" });
  assert.equal(matched.description, overlay.tetrapod.description);
  assert.equal(matched.original_description, original);
  assert.deepEqual(matched.categories, ["setting"]);
  assert.deepEqual(matched.keywords, ["防浪块"]);
  assert.deepEqual(matched.aliases, ["concrete_jack"]);
  assert.equal(searchPromptDictionary(entries, "防浪块", { scope: "page" })[0].prompt_text, "tetrapod");
  assert.deepEqual(searchPromptDictionary(entries, "海浪侵蚀", { scope: "page" }), []);
  assert.deepEqual(searchPromptDictionary(entries, "旧错译", { scope: "page" }), []);
  const guimpe = entries.find((entry) => entry.source_text === "guimpe");
  assert.equal(guimpe.description, wiki.guimpe.body);
  assert.equal(guimpe.description_language, "original");
  assert.equal(guimpe.original_description, wiki.guimpe.body);
});

test("无效 Wiki 或中文说明给出可定位的数据错误", () => {
  assert.throws(() => buildPromptDictionary(tags, "", "", "[]"), /wiki.json 必须是 JSON 对象/);
  assert.throws(() => buildPromptDictionary(tags, "", "", JSON.stringify({ tetrapod: { body: "text", other_names: [42] } })), /tetrapod 必须包含/);
  assert.throws(() => buildPromptDictionary(tags, "", JSON.stringify({ tetrapod: {
    translation: "四脚消波块", categories: ["setting"], keywords: [], description: 42,
  } })), /description 必须是非空字符串/);
});

test("已有 HTTP 词库 reader 在 Wiki 新建、更新、移除后提供最新说明和名称", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "story-dictionary-wiki-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "library", "prompt-dictionaries");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "danbooru.csv"), tags),
    writeFile(path.join(directory, "zh.csv"), "tetrapod,四脚消波块"),
  ]);
  const read = createDictionaryReader(root, {});
  assert.equal((await read()).entries[0].description, undefined);

  const wikiFile = path.join(directory, "wiki.json");
  await writeFile(wikiFile, JSON.stringify(wiki));
  const initial = (await read()).entries;
  assert.equal(initial[0].description, original);
  const revisedWiki = { tetrapod: { body: "Revised definition.", other_names: ["新名称"] } };
  await writeFile(wikiFile, JSON.stringify(revisedWiki));
  await utimes(wikiFile, new Date(), new Date(Date.now() + 2000));
  const revised = (await read()).entries;
  assert.equal(revised[0].description, "Revised definition.");
  assert.equal(searchPromptDictionary(revised, "新名称", { scope: "page" })[0].source_text, "tetrapod");
  assert.deepEqual(searchPromptDictionary(revised, "テトラポッド", { scope: "page" }), []);

  await rm(wikiFile);
  assert.equal((await read()).entries[0].description, undefined);
});
