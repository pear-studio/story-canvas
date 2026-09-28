import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGES_INDEX_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
  diagnoseStoryPageFiles,
  prepareStoryPageNarrativeForPersistence,
  storyIdPattern,
  validateStoryOutlineSemantics,
  validateStoryPageNarrativeDocument,
  validateStoryPageNarrativeSemantics,
  validateStoryPagesIndexSemantics,
} from "../server/story-files.mjs";

const schemaFiles = {
  [STORY_OUTLINE_SCHEMA_ID]: "story-outline.schema.json",
  [STORY_PAGES_INDEX_SCHEMA_ID]: "story-pages-index.schema.json",
  [STORY_PAGE_NARRATIVE_SCHEMA_ID]: "story-page-narrative.schema.json",
  [STORY_PAGE_PROMPT_SCHEMA_ID]: "story-page-prompt.schema.json",
};

async function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const [id, file] of Object.entries(schemaFiles)) {
    const schema = JSON.parse(await readFile(new URL(`../../library/schemas/${file}`, import.meta.url), "utf8"));
    assert.equal(schema.$id, id);
    ajv.addSchema(schema);
  }
  return Object.fromEntries(Object.keys(schemaFiles).map((id) => [id, document => {
    if (id.endsWith('prompt.schema.json') && !document.models) {const {$schema,...qwen}=document;return ajv.getSchema(id)({$schema,models:{qwen}});}
    return ajv.getSchema(id)(document);
  }]));
}

function completePrompt() {
  return {
    $schema: STORY_PAGE_PROMPT_SCHEMA_ID,
    text: "艾莲穿着制服走向民宿，全身镜头。",
    text_overrides: { "character:ellen-joe:school-uniform": "本页覆盖的完整描述" },
    reference_overrides: { "character:ellen-joe:school-uniform": ["ref-11111111-1111-4111-8111-111111111111"] },
    reference_images: [{ id: "ref-22222222-2222-4222-8222-222222222222", file: "reference-22222222-2222-4222-8222-222222222222.png", title: "示意图", purpose: "画风参考" }],
  };
}

test("故事文件接受完整契约并拒绝旧分类形状与非法 override", async () => {
  const validate = await validators();
  const outline = {
    $schema: STORY_OUTLINE_SCHEMA_ID,
    synopsis: "艾莲在夜间前往约定地点。",
    chapters: [{
      id: "opening",
      title: "营业铺垫",
      summary: "建立关系并进入委托。",
      sequences: [{ id: "night-arrival", title: "夜路赴约", summary: "艾莲抵达民宿。" }],
    }],
  };
  const pagesIndex = { $schema: STORY_PAGES_INDEX_SCHEMA_ID, by_sequence: { "night-arrival": ["page-abcdefabcdef"] } };
  const narrative = {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "抵达",
    scene_description: "艾莲穿着制服走向民宿。",
    characters: [{ character_id: "ellen-joe", variant_id: "school-uniform" }],
    dialogue: [{ id: "dialogue-abcdefabcdef", mode: "speech", speaker: "classmate", text: "就是这里。" }],
  };
  const prompt = completePrompt();

  assert.equal(validate[STORY_OUTLINE_SCHEMA_ID](outline), true);
  assert.equal(validate[STORY_PAGES_INDEX_SCHEMA_ID](pagesIndex), true);
  assert.equal(validate[STORY_PAGE_NARRATIVE_SCHEMA_ID](narrative), true);
  assert.equal(validate[STORY_PAGE_NARRATIVE_SCHEMA_ID]({ ...narrative, scene_description: "" }), true, "文档必填不等于非空校验");
  assert.equal(validate[STORY_PAGE_NARRATIVE_SCHEMA_ID]({ ...narrative, visual_focus: "已删除的字段" }), false);
  assert.ok(validateStoryPageNarrativeDocument({ ...narrative, visual_focus: "已删除的字段" }).some(error => error.includes("visual_focus")));
  assert.equal(validate[STORY_PAGE_NARRATIVE_SCHEMA_ID]({ ...narrative, scene_description: null }), false, "仍要求字符串类型");
  assert.deepEqual(validateStoryPageNarrativeSemantics(narrative), [], "画外对白角色不需要进入画面 characters");
  const missingVariant = { ...narrative, characters: [{ character_id: "ellen-joe" }] };
  assert.equal(validate[STORY_PAGE_NARRATIVE_SCHEMA_ID](missingVariant), false, "schema 要求 variant_id 必填");
  assert.ok(
    validateStoryPageNarrativeDocument(missingVariant).some((error) => error.includes("variant_id 不是有效 variant ID")),
    "缺少 variant_id 必须报错",
  );
  assert.equal(validate[STORY_PAGE_PROMPT_SCHEMA_ID](prompt), true);
  assert.equal(storyIdPattern.test("night--arrival"), false);

  const legacy = { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, population: [{ tag: "1girl" }], person: [], setting: [], camera: [], avoid: [] };
  assert.equal(validate[STORY_PAGE_PROMPT_SCHEMA_ID](legacy), false, "旧五分类形状不再是合法页面 Prompt");
  assert.equal(validate[STORY_PAGE_PROMPT_SCHEMA_ID]({ ...prompt, text: 42 }), false, "text 必须是字符串");
  assert.equal(validate[STORY_PAGE_PROMPT_SCHEMA_ID]({ ...prompt, text_overrides: { "character:ellen-joe:school-uniform": 1 } }), false);
  assert.equal(validate[STORY_PAGE_PROMPT_SCHEMA_ID]({ ...prompt, reference_images: [{ id: "ref-22222222-2222-4222-8222-222222222222", file: "reference-22222222-2222-4222-8222-222222222222.png", title: "示意图", purpose: 1 }] }), false, "purpose 必须是字符串");
});

test("语义校验拒绝跨章节重复 sequence、跨 sequence 重复页面和页面内重复身份", () => {
  const outline = {
    chapters: [
      { id: "opening", sequences: [{ id: "arrival" }] },
      { id: "ending", sequences: [{ id: "arrival" }] },
    ],
  };
  const pagesIndex = { by_sequence: { arrival: ["page-001"], ending: ["page-001"] } };
  const narrative = {
    characters: [{ character_id: "ellen", variant_id: "default" }, { character_id: "ellen", variant_id: "uniform" }],
    dialogue: [
      { id: "dialogue-aaaaaaaaaaaa", mode: "speech", speaker: "ellen" },
      { id: "dialogue-aaaaaaaaaaaa", mode: "narration" },
    ],
  };

  assert.match(validateStoryOutlineSemantics(outline).join("；"), /sequence.*重复/);
  assert.match(validateStoryPagesIndexSemantics(pagesIndex).join("；"), /同时属于/);
  assert.match(validateStoryPageNarrativeSemantics(narrative).join("；"), /character_id 重复.*dialogue\[1\]\.id 重复/);
  assert.doesNotMatch(validateStoryPageNarrativeSemantics(narrative).join("；"), /speaker 未出现在/);
});

test("旁白每页至多一条且不超过字数上限", () => {
  const narrative = {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "抵达",
    scene_description: "艾莲走向民宿。",
    characters: [],
    dialogue: [{ id: "dialogue-abcdefabcdef", mode: "narration", text: "夜幕降临。" }],
  };
  assert.deepEqual(validateStoryPageNarrativeDocument(narrative), []);
  const duplicated = { ...narrative, dialogue: [...narrative.dialogue, { id: "dialogue-aaaaaaaaaaaa", mode: "narration", text: "街灯亮起。" }] };
  assert.ok(validateStoryPageNarrativeDocument(duplicated).some((error) => error.includes("每页至多一条旁白")));
  const tooLong = { ...narrative, dialogue: [{ ...narrative.dialogue[0], text: "夜".repeat(201) }] };
  assert.ok(validateStoryPageNarrativeDocument(tooLong).some((error) => error.includes("旁白不能超过 200 字")));
  const atLimit = { ...narrative, dialogue: [{ ...narrative.dialogue[0], text: "夜".repeat(200) }] };
  assert.deepEqual(validateStoryPageNarrativeDocument(atLimit), []);
});

test("旁白可按页选择字幕条位置，其他文案类型不允许 position", () => {
  const narrative = {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "抵达",
    scene_description: "艾莲走向民宿。",
    characters: [],
    dialogue: [{ id: "dialogue-abcdefabcdef", mode: "narration", text: "夜幕降临。" }],
  };
  for (const position of ["top", "bottom"]) {
    const placed = { ...narrative, dialogue: [{ ...narrative.dialogue[0], position }] };
    assert.deepEqual(validateStoryPageNarrativeDocument(placed), []);
  }
  const invalid = { ...narrative, dialogue: [{ ...narrative.dialogue[0], position: "left" }] };
  assert.ok(validateStoryPageNarrativeDocument(invalid).some((error) => error.includes("position 必须是 top 或 bottom")));
  const onSpeech = { ...narrative, dialogue: [{ id: "dialogue-abcdefabcdef", mode: "speech", speaker: "npc", text: "到了。", position: "top" }] };
  assert.ok(validateStoryPageNarrativeDocument(onSpeech).some((error) => error.includes("position 仅旁白可以设置")));
});

test("文字页允许 page_kind/body 且要求角色与文案为空", () => {
  const narrative = {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "后记",
    scene_description: "",
    characters: [],
    dialogue: [],
    page_kind: "text",
    body: "作者的话。",
  };
  assert.deepEqual(validateStoryPageNarrativeDocument(narrative), []);
  const withoutBody = { ...narrative };
  delete withoutBody.body;
  assert.deepEqual(validateStoryPageNarrativeDocument(withoutBody), []);
  const badKind = { ...narrative, page_kind: "cover" };
  assert.ok(validateStoryPageNarrativeDocument(badKind).some((error) => error.includes("page_kind 目前只支持 text")));
  const bodyOnNormal = { ...narrative, body: "作者的话。" };
  delete bodyOnNormal.page_kind;
  assert.ok(validateStoryPageNarrativeDocument(bodyOnNormal).some((error) => error.includes("body 仅文字页使用")));
  const withCharacters = { ...narrative, characters: [{ character_id: "ellen", variant_id: "default" }] };
  assert.ok(validateStoryPageNarrativeDocument(withCharacters).some((error) => error.includes("characters 必须为空")));
  const withDialogue = { ...narrative, dialogue: [{ id: "dialogue-abcdefabcdef", mode: "narration", text: "夜。" }] };
  assert.ok(validateStoryPageNarrativeDocument(withDialogue).some((error) => error.includes("dialogue 必须为空")));
});

test("临时 narrative 只为未指定 ID 的新增对白生成持久 ID", () => {
  const baselineNarrative = { dialogue: [{ id: "dialogue-aaaaaaaaaaaa", mode: "narration", text: "夜幕降临。" }] };
  const edited = {
    dialogue: [
      { ...baselineNarrative.dialogue[0], text: "夜幕已经降临。" },
      { mode: "speech", speaker: "ellen", text: "到了。" },
    ],
  };
  const prepared = prepareStoryPageNarrativeForPersistence(edited, {
    baselineNarrative,
    createDialogueId: () => "dialogue-bbbbbbbbbbbb",
  });
  assert.deepEqual(prepared.dialogue.map(({ id }) => id), ["dialogue-aaaaaaaaaaaa", "dialogue-bbbbbbbbbbbb"]);
  assert.throws(
    () => prepareStoryPageNarrativeForPersistence({ dialogue: [{ ...edited.dialogue[1], id: "dialogue-cccccccccccc" }] }, { baselineNarrative }),
    /新增对白不允许指定 id/,
  );
});

test("跨文件诊断报告悬空 sequence、缺失配对文件和未索引页面", () => {
  const diagnostics = diagnoseStoryPageFiles({
    outline: { chapters: [{ sequences: [{ id: "arrival" }] }] },
    pagesIndex: { by_sequence: { removed: ["page-001"], arrival: ["page-002"] } },
    narrativePageIds: ["page-001", "page-002", "page-003"],
    promptPageIds: ["page-001", "page-003"],
  });

  assert.deepEqual(diagnostics, [
    { code: "dangling_sequence_reference", sequence_id: "removed" },
    { code: "missing_prompt_file", page_id: "page-002" },
    { code: "unindexed_page_file", page_id: "page-003" },
  ]);
});
