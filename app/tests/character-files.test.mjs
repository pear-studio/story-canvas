import {qwenDocument} from './helpers/qwen-fixture.mjs';
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { defaultSceneFacts, validateScenePromptDocument } from "../server/scene-files.mjs";

import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PAGE_GOAL_SCHEMA_ID,
  CHARACTER_PAGE_PROMPT_SCHEMA_ID,
  CHARACTER_PAGES_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
  diagnoseCharacterFiles,
  validateCharacterIndexSemantics,
  validateCharacterPagesIndexDocument,
  validateCharacterPromptDocument,
  validateCharacterPagesIndexSemantics,
  validateCharacterVisualDocument,
  validateCharacterVisualSemantics,
} from "../server/character-files.mjs";

const schemaFiles = {
  [CHARACTER_INDEX_SCHEMA_ID]: "character-index.schema.json",
  [CHARACTER_PROFILE_SCHEMA_ID]: "character-profile.schema.json",
  [CHARACTER_VISUAL_SCHEMA_ID]: "character-visual.schema.json",
  [CHARACTER_PROMPT_SCHEMA_ID]: "character-prompt.schema.json",
  [CHARACTER_PAGES_INDEX_SCHEMA_ID]: "character-pages-index.schema.json",
  [CHARACTER_PAGE_GOAL_SCHEMA_ID]: "character-page-goal.schema.json",
  [CHARACTER_PAGE_PROMPT_SCHEMA_ID]: "story-page-prompt.schema.json",
};

async function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const [id, file] of Object.entries(schemaFiles)) {
    const schema = JSON.parse(await readFile(new URL(`../../library/schemas/${file}`, import.meta.url), "utf8"));
    assert.equal(schema.$id, id);
    ajv.addSchema(schema);
  }
  return Object.fromEntries(Object.keys(schemaFiles).map((id) => [id, document => {
    // 以下用例检查 Qwen 原生字段；磁盘 Schema 通过明确的模型容器校验。
    return ajv.getSchema(id)(document);
  }]));
}

function pagePrompt({ schema } = {}) {
  return qwenDocument({ ...(schema ? { $schema: schema } : {}), text: "艾莲走向公寓，全身镜头。" });
}

function characterPrompt({ schema, promptName = "艾莲", text = "银发少女，红色眼睛。" } = {}) {
  return qwenDocument({
    ...(schema ? { $schema: schema } : {}),
    prompt_name: promptName,
    variants: { default: { text, reference_images: [] } },
  });
}

test("角色和场景参考图校验拒绝错误类型、重复 ID 和非法条目", () => {
  const entry = { id: "ref-11111111-1111-4111-8111-111111111111", file: "reference-11111111-1111-4111-8111-111111111111.png", title: "参考图" };
  for (const kind of ["character", "scene"]) {
    const prompt = defaultSceneFacts("room","房间",'qwen').prompt;
    const validate = kind === "character" ? validateCharacterPromptDocument : validateScenePromptDocument;
    if (kind === "character") prompt.$schema = CHARACTER_PROMPT_SCHEMA_ID;
    assert.deepEqual(validate(prompt), [], kind);
    prompt.models.qwen.variants.default.reference_images = [entry];
    assert.deepEqual(validate(prompt), [], kind);
    for (const invalid of ["broken", [entry, { ...entry }], [{ ...entry, file: "../outside.png" }], [{ ...entry, title: "" }]]) {
      prompt.models.qwen.variants.default.reference_images = invalid;
      assert.ok(validate(prompt).length > 0, `${kind}: ${JSON.stringify(invalid)}`);
    }
  }
});

test("角色 profile、visual 与自由文本 Prompt 通过拆分契约", async () => {
  const validate = await validators();
  const characterIndex = { $schema: CHARACTER_INDEX_SCHEMA_ID, characters: ["ellen-joe"] };
  const profile = {
    $schema: CHARACTER_PROFILE_SCHEMA_ID,
    name: "艾莲",
    description: "接受临时委托的学生，性格直接。",
  };
  const visual = {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    description: "黑红挑染短发、红色眼睛和鲨鱼尾巴。",
    variants: [{ id: "school-uniform", name: "学生制服", description: "穿白衬衫、百褶裙和黑色连裤袜。" }],
  };
  const prompt = characterPrompt({ schema: CHARACTER_PROMPT_SCHEMA_ID });
  prompt.models.qwen.variants["school-uniform"] = { text: "穿白衬衫、百褶裙和黑色连裤袜的艾莲。", reference_images: [] };

  assert.equal(validate[CHARACTER_INDEX_SCHEMA_ID](characterIndex), true);
  assert.equal(validate[CHARACTER_PROFILE_SCHEMA_ID](profile), true);
  assert.equal(validate[CHARACTER_VISUAL_SCHEMA_ID](visual), true);
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](prompt), true);

  delete prompt.models.qwen.variants["school-uniform"].text;
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](prompt), false, "子设定必须有 text");
});

test("角色视觉页索引、goal 与共享页面 Prompt 保持独立文件形状", async () => {
  const validate = await validators();
  const pagesIndex = {
    $schema: CHARACTER_PAGES_INDEX_SCHEMA_ID,
    pages: [
      { page_id: "page-abcdefabcdef", character_id: "ellen-joe", variant_id: "school-uniform" },
      { page_id: "page-001", character_id: "ellen-joe", variant_id: "school-uniform" },
    ],
  };
  const goal = {
    $schema: CHARACTER_PAGE_GOAL_SCHEMA_ID,
    title: "制服全身",
    visual_goal: "自然站立的全身设定图，清楚展示制服轮廓。",
  };
  const prompt = pagePrompt({ schema: CHARACTER_PAGE_PROMPT_SCHEMA_ID });
  assert.equal(validate[CHARACTER_PAGES_INDEX_SCHEMA_ID](pagesIndex), true);
  assert.equal(validate[CHARACTER_PAGE_GOAL_SCHEMA_ID](goal), true);
  assert.equal(validate[CHARACTER_PAGE_PROMPT_SCHEMA_ID](prompt), true);
});

test("角色 Prompt 契约要求 prompt_name 与自包含子设定，拒绝旧 identity/lora/分类形状", async () => {
  const validate = await validators();
  const validPrompt = () => qwenDocument({
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    prompt_name: "艾莲",
    variants: {
      default: { text: "银发少女。", reference_images: [] },
      uniform: { text: "穿制服的银发少女。", reference_images: [] },
    },
  });
  assert.deepEqual(validateCharacterPromptDocument(validPrompt()), []);
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](validPrompt()), true);

  const missingName = validPrompt();
  delete missingName.models.qwen.prompt_name;
  assert.ok(validateCharacterPromptDocument(missingName).some((error) => error.includes("prompt_name")), "缺少 prompt_name 必须报错");
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](missingName), false);

  const legacy = validPrompt();
  legacy.models.qwen.identity = { prompt: {}, lora: null };
  legacy.models.qwen.variants.default = { prompt: { population: [] }, loras: [], identity_disabled: [] };
  const legacyErrors = validateCharacterPromptDocument(legacy);
  assert.ok(legacyErrors.some((error) => error.includes("未知字段：identity")), "旧 identity 层被拒绝");
  assert.ok(legacyErrors.some((error) => error.includes("未知字段")), "旧分类/loras 字段被拒绝");

  const badText = validPrompt();
  badText.models.qwen.variants.default.text = ["结构化词条"];
  assert.ok(validateCharacterPromptDocument(badText).some((error) => error.includes("text 必须是字符串")));

  const emptyVariants = validPrompt();
  emptyVariants.models.qwen.variants = {};
  assert.ok(validateCharacterPromptDocument(emptyVariants).some((error) => error.includes("至少需要一个造型")));
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](emptyVariants), false);

  const emptyVisual = { $schema: CHARACTER_VISUAL_SCHEMA_ID, variants: [] };
  assert.ok(validateCharacterVisualDocument(emptyVisual).some((error) => error.includes("至少需要一个子设定")));
  assert.equal(validate[CHARACTER_VISUAL_SCHEMA_ID](emptyVisual), false);

  const missingVariantId = {
    $schema: CHARACTER_PAGES_INDEX_SCHEMA_ID,
    pages: [{ page_id: "page-001", character_id: "ellen-joe" }],
  };
  assert.ok(validateCharacterPagesIndexDocument(missingVariantId).some((error) => error.includes("variant_id 不是有效 variant ID")));
  assert.equal(validate[CHARACTER_PAGES_INDEX_SCHEMA_ID](missingVariantId), false);
});

test("角色、variant 与角色视觉页索引分别拒绝重复身份", () => {
  assert.match(validateCharacterIndexSemantics({ characters: ["ellen", "ellen"] }).join("；"), /重复/);
  assert.match(validateCharacterVisualSemantics({ variants: [{ id: "uniform" }, { id: "uniform" }] }).join("；"), /重复/);
  assert.match(validateCharacterPagesIndexSemantics({ pages: [{ page_id: "page-001" }, { page_id: "page-001" }] }).join("；"), /重复/);
});

test("跨文件诊断报告角色与 variant 悬空、视觉页缺失配对和未索引文件", () => {
  const diagnostics = diagnoseCharacterFiles({
    characterIndex: { characters: ["ellen"] },
    profileCharacterIds: ["ellen"],
    visualByCharacter: { ellen: { variants: [{ id: "uniform" }] } },
    promptByCharacter: { ellen: qwenDocument({ variants: { obsolete: {} } }) },
    characterPagesIndex: { pages: [
      { page_id: "page-001", character_id: "ellen", variant_id: "missing" },
      { page_id: "page-002", character_id: "ghost", variant_id: "uniform" },
    ] },
    goalPageIds: ["page-001", "page-002", "page-003"],
    promptPageIds: ["page-001"],
    characterStyles: { characters: { ghost: { display_color: "#112233" } } },
    storyNarrativesByPage: {
      "page-story": {
        characters: [{ character_id: "ellen", variant_id: "missing" }],
        dialogue: [{ mode: "speech", speaker: "ghost" }],
      },
    },
  });

  assert.deepEqual(diagnostics.map(({ code }) => code), [
    "missing_variant_prompt",
    "dangling_prompt_variant_reference",
    "dangling_character_page_variant",
    "dangling_character_page_owner",
    "missing_character_page_prompt",
    "missing_character_page_prompt",
    "unindexed_character_page_file",
    "dangling_character_style_reference",
    "dangling_story_variant_reference",
    "dangling_story_dialogue_speaker",
  ]);
});
