import assert from "node:assert/strict";
import test from "node:test";

import { buildPromptDictionary, matchPromptDictionary, searchPromptDictionary, searchPromptDictionaryPage, validatePromptDictionaryOverlay } from "../server/prompt-dictionary.mjs";

const tags = [
  "rain,0,3000,rainy",
  "sword,0,2000,",
  "blonde_hair,0,1500,",
].join("\n");
const translations = ["rain,雨", "sword,剑", "blonde_hair,金色头发"].join("\n");

test("overlay 叠加翻译、分类与关键词，并保持未覆盖词条结构", () => {
  const overlay = {
    rain: { translation: "下雨", categories: ["setting", "camera"], keywords: ["雨", "雨天", "雨夜", "天气"] },
    sword: { translation: "剑", categories: ["subject", "equipment"], keywords: ["剑", "刀剑", "武器"] },
  };
  const entries = buildPromptDictionary(tags, translations, JSON.stringify(overlay));
  const rain = entries.find((entry) => entry.source_text === "rain");
  assert.equal(rain.display_text, "下雨");
  assert.deepEqual(rain.categories, ["setting", "camera"]);
  assert.deepEqual(rain.keywords, ["雨", "雨天", "雨夜", "天气"]);
  const sword = entries.find((entry) => entry.source_text === "sword");
  assert.deepEqual(sword.categories, ["subject", "equipment"]);
  const hair = entries.find((entry) => entry.source_text === "blonde_hair");
  assert.equal(hair.display_text, "金色头发", "未覆盖词条保持 zh.csv 翻译");
  assert.equal(hair.categories, undefined, "未覆盖词条不携带分类字段");
  assert.equal(hair.keywords, undefined, "未覆盖词条不携带关键词字段");
});

test("修订译文替换 CSV 旧译文，同时保留原标签别名和明确关键词", () => {
  const source = "print_bag,0,100,print_backpack";
  const zh = "print_bag,打印背包\nprint_backpack,打印机背包";
  const base = buildPromptDictionary(source, zh);
  const revised = buildPromptDictionary(source, zh, JSON.stringify({
    print_bag: { translation: "印花包", categories: ["equipment"], keywords: ["花纹背包"] },
  }));
  for (const query of ["打印背包", "打印机背包"]) {
    assert.equal(searchPromptDictionary(base, query, { scope: "page" })[0].source_text, "print_bag");
    assert.deepEqual(searchPromptDictionary(revised, query, { scope: "page" }), [], `${query} 不应通过已替换的旧译文命中`);
  }
  for (const query of ["印花包", "花纹背包", "print_bag", "print_backpack"]) {
    assert.equal(searchPromptDictionary(revised, query, { scope: "page" })[0].source_text, "print_bag");
  }
});

test("中文关键词可命中词库搜索", () => {
  const overlay = {
    rain: { translation: "雨", categories: ["setting"], keywords: ["雨", "雨天", "雨夜", "天气"] },
  };
  const entries = buildPromptDictionary(tags, translations, JSON.stringify(overlay));
  const results = searchPromptDictionary(entries, "雨夜", { scope: "page" });
  assert.ok(results.some((entry) => entry.source_text === "rain"), "中文关键词应命中对应标签");
});

test("overlay 校验拒绝未知分类、缺失标签、大写关键词与空分类", () => {
  const errors = validatePromptDictionaryOverlay({
    "rain": { translation: "雨", categories: ["weather"], keywords: [] },
    "missing_word": { translation: "不存在", categories: ["subject"], keywords: [] },
    "sword": { translation: "剑", categories: [], keywords: [] },
    "blonde_hair": { translation: "金色头发", categories: ["hair"], keywords: ["Golden", "金色"] },
  }, ["rain", "sword", "blonde_hair"]);
  assert.equal(errors.length, 4, `应报告全部 4 类错误：${errors.join(" | ")}`);
  assert.ok(errors.some((message) => message.includes("weather")));
  assert.ok(errors.some((message) => message.includes("missing_word")));
  assert.ok(errors.some((message) => message.includes("非空数组")));
  assert.ok(errors.some((message) => message.includes("Golden")));
});

test("overlay 非法 JSON 与校验失败给出明确错误", () => {
  assert.throws(() => buildPromptDictionary(tags, translations, "{not json"), /不是合法 JSON/);
  assert.throws(() => buildPromptDictionary(tags, translations, JSON.stringify({ rain: { translation: "雨", categories: ["nope"], keywords: [] } })), /overlay.json 校验失败/);
});

test("匹配档优先于语义分类，同档内再让命中分类置顶", () => {
  const overlay = {
    rain: { translation: "雨", categories: ["setting"], keywords: ["雨"] },
    sword: { translation: "剑", categories: ["subject"], keywords: ["剑", "rainy"] },
  };
  const entries = buildPromptDictionary(tags, translations, JSON.stringify(overlay));
  const exactFirst = searchPromptDictionary(entries, "rain", { scope: "page", limit: 10, category: "subject" }).map((entry) => entry.source_text);
  assert.deepEqual(exactFirst.slice(0, 2), ["rain", "sword"], "主标签精确命中不能被语义分类加权压过");

  const sameRank = searchPromptDictionary(entries, "ai", { scope: "page", limit: 10, category: "setting" }).map((entry) => entry.source_text);
  assert.equal(sameRank[0], "rain", "相同包含匹配档内，命中 setting 分类的词置顶");
  assert.ok(sameRank.includes("blonde_hair"), "未标注词仍保持可见");
});

test("当前展示翻译精确命中优先于别名和关键词精确命中", () => {
  const entries = buildPromptDictionary(
    [
      "moon,0,90000,",
      "moonlight,0,1000,",
      "cat,0,80000,",
      "cat_ears,0,900,",
    ].join("\n"),
    ["moon,月亮", "moonlight,月光", "cat,猫", "cat_ears,猫耳"].join("\n"),
    JSON.stringify({
      moon: { translation: "月亮", categories: ["setting"], keywords: ["月光"] },
      moonlight: { translation: "月光", categories: ["setting"], keywords: [] },
      cat: { translation: "猫", categories: ["subject"], keywords: ["猫耳"] },
      cat_ears: { translation: "猫耳", categories: ["appearance"], keywords: [] },
    }),
  );

  assert.equal(searchPromptDictionary(entries, "月光", { scope: "page", category: "setting" })[0].source_text, "moonlight");
  assert.equal(searchPromptDictionary(entries, "猫耳", { scope: "page", category: "appearance" })[0].source_text, "cat_ears");
});

test("多词中的完整词命中优先于普通前缀", () => {
  const entries = buildPromptDictionary(
    [
      "shota,0,90000,",
      "shotgun,0,80000,",
      "pantyshot,0,70000,panty_shot",
      "selfie,0,60000,self_shot",
      "cowboy_shot,0,1200,",
      "wide_shot,0,1000,",
    ].join("\n"),
    "",
    JSON.stringify({
      shota: { translation: "正太", categories: ["subject"], keywords: [] },
      shotgun: { translation: "霰弹枪", categories: ["equipment"], keywords: [] },
      pantyshot: { translation: "内裤走光", categories: ["camera"], keywords: [] },
      selfie: { translation: "自拍", categories: ["camera"], keywords: [] },
      cowboy_shot: { translation: "牛仔镜头", categories: ["camera"], keywords: [] },
      wide_shot: { translation: "远景", categories: ["camera"], keywords: [] },
    }),
  );

  assert.deepEqual(
    searchPromptDictionary(entries, "shot", { scope: "page", category: "camera" }).map((entry) => entry.source_text),
    ["cowboy_shot", "wide_shot", "pantyshot", "selfie", "shota", "shotgun"],
  );
});

test("倒序多词 AND 可以召回同一证据中的完整词，并优先于任意子串", () => {
  const entries = buildPromptDictionary([
    "xhair_blondette,0,90000,",
    "blonde_hair,0,1000,",
    "hair_ribbon,0,800,blonde_ribbon",
  ].join("\n"));

  assert.deepEqual(
    searchPromptDictionary(entries, "hair blonde", { scope: "page", category: "appearance" }).map((entry) => entry.source_text),
    ["blonde_hair", "xhair_blondette"],
    "两个查询词必须在同一证据中以完整词出现，不能跨主标签与别名拼接",
  );
});

test("分页在完整排序后按 offset 切片并明确返回 has_more", () => {
  const entries = buildPromptDictionary([
    "tired_eyes,0,9000,",
    "red_eyes,0,200,",
    "red_hair,0,500,",
    "red,0,10,",
  ].join("\n"));
  const options = { scope: "page", category: "appearance", limit: 2 };

  const first = searchPromptDictionaryPage(entries, "red", options);
  const second = searchPromptDictionaryPage(entries, "red", { ...options, offset: 2 });
  assert.deepEqual(first.suggestions.map((entry) => entry.prompt_text), ["red", "red hair"]);
  assert.equal(first.has_more, true);
  assert.deepEqual(second.suggestions.map((entry) => entry.prompt_text), ["red eyes", "tired eyes"]);
  assert.equal(second.has_more, false);
  assert.deepEqual(
    [...first.suggestions, ...second.suggestions],
    searchPromptDictionary(entries, "red", { ...options, limit: 4 }),
    "分页结果拼接后必须等于未分页的完整排序",
  );
  assert.deepEqual(searchPromptDictionaryPage(entries, "red", { ...options, offset: 20 }), { suggestions: [], has_more: false });
});

test("scope 按 Provider 类别硬过滤，并始终排除 artist 与 unknown", () => {
  const entries = buildPromptDictionary([
    "moon_general,0,500,moon",
    "moon_artist,1,9000,moon_artist_alias",
    "moon_copyright,3,8000,moon_copyright_alias",
    "moon_character,4,7000,moon_character_alias",
    "moon_meta,5,6000,moon_meta_alias",
    "moon_unknown,9,10000,moon_unknown_alias",
  ].join("\n"));

  assert.deepEqual(
    searchPromptDictionary(entries, "moon", { scope: "page", limit: 20 }).map((entry) => entry.provider_type),
    ["0"],
  );
  assert.deepEqual(
    searchPromptDictionary(entries, "moon", { scope: "character", limit: 20 }).map((entry) => entry.provider_type),
    ["0", "3", "4"],
  );
  assert.deepEqual(
    searchPromptDictionary(entries, "moon", { scope: "render_profile", limit: 20 }).map((entry) => entry.provider_type),
    ["0", "5"],
  );
});

test("精确匹配同时返回词库命中与当前 scope 是否允许", () => {
  const entries = buildPromptDictionary([
    "wide_shot,0,1000,",
    "sample_artist,1,900,",
    "sample_character,4,800,",
  ].join("\n"));

  assert.deepEqual(matchPromptDictionary(entries, ["wide shot", "sample_artist", "sample character", "missing"], { scope: "page" }), [
    { prompt_text: "wide shot", matched: true, allowed: true, provider_type: "0", provider_category: "general", display_text: "wide shot", source_text: "wide_shot", post_count: 1000 },
    { prompt_text: "sample_artist", matched: true, allowed: false, provider_type: "1", provider_category: "artist", display_text: "sample artist", source_text: "sample_artist", post_count: 900 },
    { prompt_text: "sample character", matched: true, allowed: false, provider_type: "4", provider_category: "character", display_text: "sample character", source_text: "sample_character", post_count: 800 },
    { prompt_text: "missing", matched: false, allowed: false, provider_type: null, provider_category: null, display_text: null, source_text: null, post_count: null },
  ]);
});

test("搜索和匹配必须显式提供合法 scope", () => {
  const entries = buildPromptDictionary(tags, translations);
  assert.throws(() => searchPromptDictionary(entries, "rain"), /未知 Prompt 词库作用域/);
  assert.throws(() => matchPromptDictionary(entries, ["rain"], { scope: "project" }), /未知 Prompt 词库作用域/);
});
