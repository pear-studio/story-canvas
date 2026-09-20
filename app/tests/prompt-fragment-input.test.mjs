import assert from "node:assert/strict";
import test from "node:test";

import { activePromptDictionarySuggestion, canSearchPromptDictionary, inferUserPromptType, mergePromptDictionarySuggestions, shouldOpenPromptDictionarySearch } from "../src/prompt-fragment-input.ts";

test("用户 Prompt 精确匹配词库时使用标签类型", () => {
  assert.equal(inferUserPromptType("from side", { dictionaryMatched: true, dictionaryAllowed: true, scope: "page", category: "camera" }), "danbooru");
  assert.equal(inferUserPromptType("running", { dictionaryMatched: true, dictionaryAllowed: true, scope: "page", category: "action" }), "danbooru", "简单动作只要词库精确匹配就仍使用标签");
  assert.equal(inferUserPromptType("some artist", { dictionaryMatched: true, dictionaryAllowed: false, scope: "page", category: "setting" }), null, "已知但当前范围禁用的标签不能伪装成描述");
});

test("未匹配词库的自由输入统一成为描述，不限制作用域或分类", () => {
  assert.equal(inferUserPromptType("quiet night hallway", { dictionaryMatched: false, dictionaryAllowed: false, scope: "page", category: "setting" }), "custom_description");
  assert.equal(inferUserPromptType("quiet hallway under dim lights", { dictionaryMatched: false, dictionaryAllowed: false, scope: "page", category: "layout" }), "custom_description");
  assert.equal(inferUserPromptType("quiet hallway under dim lights", { dictionaryMatched: false, dictionaryAllowed: false, scope: "page", category: "subject" }), "custom_description");
  assert.equal(inferUserPromptType("quiet hallway under dim lights", { dictionaryMatched: false, dictionaryAllowed: false, scope: "character", category: "identity" }), "custom_description");
  assert.equal(inferUserPromptType("quiet hallway under dim lights", { dictionaryMatched: false, dictionaryAllowed: false, scope: "render_profile", category: "positive_prefix" }), "custom_description");
});

test("描述允许长文本、换行和常见标点", () => {
  for (const text of ["quiet ".repeat(40), "灯光柔和，人物靠窗。\nA quiet evening—soft light.", "---"]) {
    assert.equal(inferUserPromptType(text, { dictionaryMatched: false, dictionaryAllowed: false, scope: "page", category: "setting" }), "custom_description");
  }
  assert.equal(inferUserPromptType("  ", { dictionaryMatched: false, dictionaryAllowed: false, scope: "page", category: "setting" }), null);
});

test("词库搜索允许单个中日韩表意文字", () => {
  assert.equal(canSearchPromptDictionary("猫"), true);
  assert.equal(canSearchPromptDictionary("ね"), true);
  assert.equal(canSearchPromptDictionary("한"), true);
});

test("词库搜索要求至少两个拉丁字母或数字", () => {
  assert.equal(canSearchPromptDictionary("c"), false);
  assert.equal(canSearchPromptDictionary("ca"), true);
  assert.equal(canSearchPromptDictionary("1"), false);
  assert.equal(canSearchPromptDictionary("12"), true);
  assert.equal(canSearchPromptDictionary("c1"), true);
});

test("词库搜索忽略空白和纯标点", () => {
  assert.equal(canSearchPromptDictionary(""), false);
  assert.equal(canSearchPromptDictionary("  "), false);
  assert.equal(canSearchPromptDictionary("？！"), false);
  assert.equal(canSearchPromptDictionary("_-"), false);
});

test("候选搜索必须由用户显式输入开启", () => {
  assert.equal(shouldOpenPromptDictionarySearch({ focused: true, enabled: false, composing: false, query: "tower" }), false, "只聚焦已有 Prompt 不应弹候选");
  assert.equal(shouldOpenPromptDictionarySearch({ focused: true, enabled: true, composing: false, query: "tower" }), true);
  assert.equal(shouldOpenPromptDictionarySearch({ focused: true, enabled: true, composing: true, query: "tower" }), false);
});

test("未主动移动到候选时不应隐式选择第一项", () => {
  const suggestions = [{ prompt_text: "tower" }, { prompt_text: "clock tower" }];
  assert.equal(activePromptDictionarySuggestion(suggestions, -1), undefined);
  assert.deepEqual(activePromptDictionarySuggestion(suggestions, 1), suggestions[1]);
});

test("分页候选按来源词和 Prompt 去重并保持顺序", () => {
  const firstPage = [
    { source_text: "cat", prompt_text: "cat", display_text: "猫" },
    { source_text: "cat_ears", prompt_text: "cat ears", display_text: "猫耳" },
  ];
  const secondPage = [
    { source_text: "cat_ears", prompt_text: "cat ears", display_text: "重复猫耳" },
    { source_text: "cat_tail", prompt_text: "cat tail", display_text: "猫尾" },
  ];
  assert.deepEqual(mergePromptDictionarySuggestions(firstPage, secondPage), [
    firstPage[0],
    firstPage[1],
    secondPage[1],
  ]);
});
