import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_LORA_SCHEMA_ID,
  CHARACTER_PAGE_GOAL_SCHEMA_ID,
  CHARACTER_PAGE_PROMPT_SCHEMA_ID,
  CHARACTER_PAGES_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
  diagnoseCharacterFiles,
  validateCharacterIndexSemantics,
  validateCharacterLoraDocument,
  validateCharacterPagesIndexDocument,
  validateCharacterPromptDocument,
  validateCharacterPagesIndexSemantics,
  validateCharacterVisualDocument,
  validateCharacterVisualSemantics,
} from "../server/character-files.mjs";

const schemaFiles = {
  [CHARACTER_INDEX_SCHEMA_ID]: "character-index.schema.json",
  [CHARACTER_LORA_SCHEMA_ID]: "character-lora.schema.json",
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
  return Object.fromEntries(Object.keys(schemaFiles).map((id) => [id, ajv.getSchema(id)]));
}

function completePrompt({ schema } = {}) {
  return { ...(schema ? { $schema: schema } : {}), subject: [{ tag: "1girl" }], person: [{ description: "red eyes" }],  setting: [], camera: [], avoid: [] };
}

function emptyPrompt() {
  return Object.fromEntries(Object.keys(completePrompt()).map((category) => [category, []]));
}

test("角色 profile、visual 与 identity 加按配置拆分的 Prompt/LoRA 通过拆分契约", async () => {
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
  const identityLora = { filename: "characters/ellen.safetensors", sha256: "a".repeat(64), weight: 0.8, trigger: "ellen_joe" };
  const prompt = {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: emptyPrompt(), lora: identityLora },
    variants: {
      default: { prompt: completePrompt(), loras: [], identity_disabled: [] },
      "school-uniform": { prompt: completePrompt(), loras: [], identity_disabled: [] },
    },
  };
  const lora = {
    $schema: CHARACTER_LORA_SCHEMA_ID,
    identity: identityLora,
    variants: { default: [], "school-uniform": [] },
  };

  assert.equal(validate[CHARACTER_INDEX_SCHEMA_ID](characterIndex), true);
  assert.equal(validate[CHARACTER_PROFILE_SCHEMA_ID](profile), true);
  assert.equal(validate[CHARACTER_VISUAL_SCHEMA_ID](visual), true);
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](prompt), true);
  assert.equal(validate[CHARACTER_LORA_SCHEMA_ID](lora), true);

  prompt.variants.default.prompt.subject[0].character_id = "ellen-joe";
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](prompt), false, "角色自身 Prompt 不允许重复绑定 owner");
  delete prompt.variants.default.prompt.subject[0].character_id;
  delete prompt.variants["school-uniform"].prompt.avoid;
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](prompt), false, "variant 不能从其他造型继承缺失的 Prompt 分类");
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
  const pagePrompt = completePrompt({ schema: CHARACTER_PAGE_PROMPT_SCHEMA_ID });
  pagePrompt.subject[0].character_id = "ellen-joe";
  assert.equal(validate[CHARACTER_PAGES_INDEX_SCHEMA_ID](pagesIndex), true);
  assert.equal(validate[CHARACTER_PAGE_GOAL_SCHEMA_ID](goal), true);
  assert.equal(validate[CHARACTER_PAGE_PROMPT_SCHEMA_ID](pagePrompt), true);
});

test("角色 Prompt 契约拒绝缺失 identity、配置上的旧 lora 字段与非数组 loras", () => {
  const validPrompt = () => ({
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: emptyPrompt(), lora: null },
    variants: {
      default: { prompt: completePrompt(), loras: [], identity_disabled: [] },
      uniform: { prompt: completePrompt(), loras: [], identity_disabled: [] },
    },
  });
  assert.deepEqual(validateCharacterPromptDocument(validPrompt()), []);
  const missingIdentity = validPrompt();
  delete missingIdentity.identity;
  assert.ok(
    validateCharacterPromptDocument(missingIdentity).some((error) => error.includes("character prompt.identity 必须是对象")),
    "缺少 identity 必须报错",
  );

  const legacyBaseLora = validPrompt();
  legacyBaseLora.variants.default = { prompt: completePrompt(), lora: null };
  const baseErrors = validateCharacterPromptDocument(legacyBaseLora);
  assert.ok(baseErrors.some((error) => error.includes("character prompt.variants.default 包含未知字段：lora")), "造型配置不允许保留旧 lora 字段");
  assert.ok(baseErrors.some((error) => error.includes("character prompt.variants.default.loras 必须是数组")), "缺少 loras 等同于 loras 非数组");

  const legacyVariantLora = validPrompt();
  legacyVariantLora.variants.uniform = {
    prompt: completePrompt(),
    lora: { filename: "characters/uniform.safetensors", sha256: "b".repeat(64), weight: 0.7 },
  };
  assert.ok(
    validateCharacterPromptDocument(legacyVariantLora).some((error) => error.includes("character prompt.variants.uniform 包含未知字段：lora")),
    "variant 不允许保留旧 lora 字段",
  );

  const badLoras = validPrompt();
  badLoras.variants.default.loras = null;
  assert.ok(
    validateCharacterPromptDocument(badLoras).some((error) => error.includes("character prompt.variants.default.loras 必须是数组")),
    "loras 必须是数组",
  );

  const badIdentityPrompt = validPrompt();
  badIdentityPrompt.identity.prompt.person = "red eyes";
  assert.ok(
    validateCharacterPromptDocument(badIdentityPrompt).some((error) => error.includes("character prompt.identity.prompt.person 必须是数组")),
    "identity.prompt 的每个分类必须是数组",
  );
});

test("角色 Prompt/visual 至少一个造型，variant_id 必填，identity_disabled 只允许关闭 identity 中存在的键", async () => {
  const validate = await validators();
  const emptyAppearancePrompt = emptyPrompt;
  const validPrompt = () => ({
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: { ...emptyPrompt(), person: [{ description: "shark tail" }, { description: "amber eyes" }, { description: "upright posture" }],  }, lora: null },
    variants: { default: { prompt: completePrompt(), loras: [], identity_disabled: [] } },
  });
  assert.deepEqual(validateCharacterPromptDocument(validPrompt()), []);
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](validPrompt()), true);

  const emptyVariants = validPrompt();
  emptyVariants.variants = {};
  assert.ok(
    validateCharacterPromptDocument(emptyVariants).some((error) => error.includes("character prompt.variants 至少需要一个造型")),
    "空 variants 必须报错",
  );
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](emptyVariants), false, "schema 同样要求至少一个造型");

  const emptyVisual = {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    description: "银发少女。",
    variants: [],
  };
  assert.ok(
    validateCharacterVisualDocument(emptyVisual).some((error) => error.includes("character visual.variants 至少需要一个子设定")),
    "visual 空 variants 必须报错",
  );
  assert.equal(validate[CHARACTER_VISUAL_SCHEMA_ID](emptyVisual), false, "schema 同样要求至少一个子设定");

  const missingVariantId = {
    $schema: CHARACTER_PAGES_INDEX_SCHEMA_ID,
    pages: [{ page_id: "page-001", character_id: "ellen-joe" }],
  };
  assert.ok(
    validateCharacterPagesIndexDocument(missingVariantId).some((error) => error.includes("variant_id 不是有效 variant ID")),
    "角色视觉页缺少 variant_id 必须报错",
  );
  assert.equal(validate[CHARACTER_PAGES_INDEX_SCHEMA_ID](missingVariantId), false, "schema 同样要求 variant_id");

  const missingDisabled = validPrompt();
  delete missingDisabled.variants.default.identity_disabled;
  assert.ok(
    validateCharacterPromptDocument(missingDisabled).some((error) => error.includes("character prompt.variants.default.identity_disabled 必须是数组")),
    "identity_disabled 必需",
  );
  assert.equal(validate[CHARACTER_PROMPT_SCHEMA_ID](missingDisabled), false, "schema 同样要求 identity_disabled");

  const disabling = validPrompt();
  disabling.variants.uniform = { prompt: emptyAppearancePrompt(), loras: [], identity_disabled: [" Amber Eyes "] };
  assert.deepEqual(validateCharacterPromptDocument(disabling), [], "trim+小写后命中 identity 的关闭合法");

  const dangling = validPrompt();
  dangling.variants.uniform = { prompt: emptyAppearancePrompt(), loras: [], identity_disabled: ["missing key"] };
  assert.ok(
    validateCharacterPromptDocument(dangling).some((error) => error.includes("character prompt.variants.uniform.identity_disabled[0] 关闭了 identity.prompt 中不存在的片段：missing key")),
    "identity_disabled 空挂必须报错",
  );

  const duplicated = validPrompt();
  duplicated.variants.uniform = { prompt: emptyAppearancePrompt(), loras: [], identity_disabled: ["amber eyes", " Amber Eyes "] };
  assert.ok(
    validateCharacterPromptDocument(duplicated).some((error) => error.includes("identity_disabled[1] 重复")),
    "identity_disabled 规范化后的重复键报错",
  );

  const ownDisabledFragment = validPrompt();
  ownDisabledFragment.variants.uniform = { prompt: emptyAppearancePrompt(), loras: [], identity_disabled: [] };
  ownDisabledFragment.variants.uniform.prompt.person = [{ description: "any draft", enabled: false }, { description: "amber eyes", enabled: false }];
  assert.deepEqual(validateCharacterPromptDocument(ownDisabledFragment), [], "enabled:false 的自有片段是合法草稿，不做任何校验");
});

test("角色 LoRA 投影契约要求 identity 单值与每配置 loras 数组", () => {
  const valid = {
    $schema: CHARACTER_LORA_SCHEMA_ID,
    identity: { filename: "characters/ellen.safetensors", sha256: "a".repeat(64), weight: 0.8 },
    variants: { default: [], uniform: [{ filename: "characters/ellen-uniform.safetensors", sha256: "b".repeat(64), weight: 0.7 }] },
  };
  assert.deepEqual(validateCharacterLoraDocument(valid), []);
  assert.deepEqual(validateCharacterLoraDocument({ ...valid, identity: null }), [], "identity.lora 允许为 null");

  const emptyVariants = { ...valid, variants: {} };
  assert.ok(
    validateCharacterLoraDocument(emptyVariants).some((error) => error.includes("character LoRA.variants 至少需要一个造型")),
    "空 variants 必须报错",
  );
  const legacyVariant = { ...valid, variants: { default: [], uniform: null } };
  assert.ok(
    validateCharacterLoraDocument(legacyVariant).some((error) => error.includes("character LoRA.variants.uniform 必须是数组")),
    "variants.* 不允许旧 lora 单值",
  );
  const badIdentity = { ...valid, identity: [valid.identity] };
  assert.ok(
    validateCharacterLoraDocument(badIdentity).some((error) => error.includes("character LoRA.identity 必须是 null 或对象")),
    "identity 必须是单个 lora 或 null",
  );
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
    promptByCharacter: { ellen: { variants: { obsolete: {} } } },
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
