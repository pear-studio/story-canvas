import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildPromptDictionary, searchPromptDictionary } from "../server/prompt-dictionary.mjs";

test("正式词库中文搜索保留图像标签含义，不再召回已修正的错对象与错动作", async () => {
  const directory = new URL("../../library/prompt-dictionaries/", import.meta.url);
  const [tags, translations, overlay] = await Promise.all(
    ["danbooru.csv", "zh.csv", "overlay.json"].map((name) => readFile(new URL(name, directory), "utf8")),
  );
  const entries = buildPromptDictionary(tags, translations, overlay);
  const suggestions = (query) => searchPromptDictionary(entries, query, { scope: "page", limit: 12 });
  const cases = [
    ["翻页", "turning_page", "turning page"],
    ["额外舌头", "extra_tongue", "extra tongue"],
    ["扶腰", "hand_on_another's_waist", "hand on another's waist"],
    ["马蹄形饰物", "horseshoe_ornament", "horseshoe ornament"],
    ["静电", "static_electricity", "static electricity"],
    ["心形眼睛", "heart-shaped_eyes", "heart-shaped eyes"],
  ];
  for (const [query, source, prompt] of cases) {
    const match = suggestions(query).find((entry) => entry.source_text === source);
    assert.ok(match, `搜索“${query}”的首屏应包含 ${source}`);
    assert.equal(match.prompt_text, prompt, "中文修订不能改变选入 Prompt 的英文标签");
  }
  for (const [query, wrongTags] of [
    ["回头", ["turning_page"]],
    ["额外耳朵", ["extra_tongue"]],
    ["衍生角色", ["extra_legs", "extra_tails", "extra_teeth"]],
  ]) {
    const matches = suggestions(query).map((entry) => entry.source_text);
    for (const wrong of wrongTags) assert.ok(!matches.includes(wrong), `“${query}”不应再被错误译文或关键词关联到 ${wrong}`);
  }
});
