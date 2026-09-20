import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  VARIANT_MIGRATION_PLAN,
  migrateCharacterPagesIndexVariants,
  migrateCharacterPromptVariants,
  migrateCharacterVisualVariants,
  migrateProjectCharacterVariants,
  migrateStoryNarrativeVariants,
} from "../server/character-variant-explicit-migration.mjs";
import {
  CHARACTER_PAGES_INDEX_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
  validateCharacterPagesIndexDocument,
  validateCharacterPromptDocument,
  validateCharacterVisualDocument,
} from "../server/character-files.mjs";
import { STORY_PAGE_NARRATIVE_SCHEMA_ID, validateStoryPageNarrativeDocument } from "../server/story-files.mjs";

const emptyPrompt = () => ({ subject: [], person: [],  setting: [], camera: [], avoid: [] });

const configuration = (person = []) => ({
  prompt: { ...emptyPrompt(), person },
  loras: [],
  identity_disabled: [],
});

function sigridPrompt() {
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: { ...emptyPrompt(), person: [{ tag: "blonde_hair", id: "token-000000000001" }] }, lora: null },
    variants: {
      base: configuration([{ tag: "white_bodysuit", id: "token-000000000003" }]),
      wavechaser: configuration(),
    },
  };
}

function pyroisPrompt() {
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: { ...emptyPrompt(), person: [{ description: "dark purple obsidian skin", id: "token-000000000010" }] }, lora: null },
    variants: {
      base: configuration(),
      variant: configuration([{ description: "futanari", id: "token-000000000011" }]),
    },
  };
}

function sigridVisual() {
  return {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    description: "角色整体描述。",
    base_description: "白灰色铠甲搭配白色连体衣（空巡局制服装束）。",
    variants: [{ id: "wavechaser", name: "逐浪之仪", description: "泳装造型。" }],
  };
}

function pyroisVisual() {
  return {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    description: "黑曜石质感深色皮肤的类人形态。",
    variants: [{ id: "variant", name: "扶她", description: "待补充子设定视觉说明。" }],
  };
}

function wiseVisual() {
  return {
    $schema: CHARACTER_VISUAL_SCHEMA_ID,
    description: "日常装扮的年轻男性。",
    base_description: "蓝色夹克、黑色衬衫与黑色长裤。",
    variants: [],
  };
}

function wisePrompt() {
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: { ...emptyPrompt(), person: [{ tag: "grey_hair", id: "token-000000000020" }] }, lora: null },
    variants: { base: configuration() },
  };
}

test("sigrid prompt：base 改名 uniform，键顺序与配置内容不变", () => {
  const source = sigridPrompt();
  const { document, changed } = migrateCharacterPromptVariants(source, VARIANT_MIGRATION_PLAN.sigrid);
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(document.variants), ["uniform", "wavechaser"]);
  assert.deepEqual(document.variants.uniform, source.variants.base);
  assert.deepEqual(document.variants.wavechaser, source.variants.wavechaser);
  assert.deepEqual(validateCharacterPromptDocument(document), []);
  assert.deepEqual(Object.keys(source.variants), ["base", "wavechaser"]);
});

test("pyrois prompt：base 与 variant 同时改名", () => {
  const { document, changed } = migrateCharacterPromptVariants(pyroisPrompt(), VARIANT_MIGRATION_PLAN.pyrois);
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(document.variants), ["nude-armor", "futanari"]);
  assert.deepEqual(validateCharacterPromptDocument(document), []);
});

test("prompt：目标 id 已存在时报错中止，源 id 缺失时报错", () => {
  const conflicted = sigridPrompt();
  conflicted.variants.uniform = configuration();
  assert.throws(() => migrateCharacterPromptVariants(conflicted, VARIANT_MIGRATION_PLAN.sigrid), /同时包含 base 与 uniform/);
  const orphaned = sigridPrompt();
  delete orphaned.variants.base;
  assert.throws(() => migrateCharacterPromptVariants(orphaned, VARIANT_MIGRATION_PLAN.sigrid), /缺少 base/);
});

test("prompt：已完成迁移的文件幂等跳过", () => {
  const { document } = migrateCharacterPromptVariants(sigridPrompt(), VARIANT_MIGRATION_PLAN.sigrid);
  const result = migrateCharacterPromptVariants(document, VARIANT_MIGRATION_PLAN.sigrid);
  assert.equal(result.changed, false);
  assert.deepEqual(result.document, document);
});

test("sigrid visual：base_description 并入新条目排最前并删除字段", () => {
  const source = sigridVisual();
  const { document, changed } = migrateCharacterVisualVariants(source, VARIANT_MIGRATION_PLAN.sigrid);
  assert.equal(changed, true);
  assert.equal(Object.hasOwn(document, "base_description"), false);
  assert.deepEqual(document.variants.map(variant => variant.id), ["uniform", "wavechaser"]);
  assert.deepEqual(document.variants[0], { id: "uniform", name: "制服", description: source.base_description });
  assert.deepEqual(document.variants[1], source.variants[0]);
  assert.deepEqual(validateCharacterVisualDocument(document), []);
});

test("pyrois visual：无 base_description 时补占位默认条目，variant 条目改名保留 name", () => {
  const { document, changed } = migrateCharacterVisualVariants(pyroisVisual(), VARIANT_MIGRATION_PLAN.pyrois);
  assert.equal(changed, true);
  assert.deepEqual(document.variants.map(variant => variant.id), ["nude-armor", "futanari"]);
  assert.equal(document.variants[0].name, "裸身甲");
  assert.deepEqual(document.variants[1], { id: "futanari", name: "扶她", description: "待补充子设定视觉说明。" });
  assert.deepEqual(validateCharacterVisualDocument(document), []);
});

test("visual：默认条目与 base_description 冲突时报错，已迁移文件幂等", () => {
  const conflicted = sigridVisual();
  conflicted.variants.unshift({ id: "uniform", name: "制服", description: "已有条目。" });
  assert.throws(() => migrateCharacterVisualVariants(conflicted, VARIANT_MIGRATION_PLAN.sigrid), /与 base_description 冲突/);
  const { document } = migrateCharacterVisualVariants(sigridVisual(), VARIANT_MIGRATION_PLAN.sigrid);
  const result = migrateCharacterVisualVariants(document, VARIANT_MIGRATION_PLAN.sigrid);
  assert.equal(result.changed, false);
});

test("角色视觉页 index：缺 variant_id 补默认造型，旧 id 改名", () => {
  const source = {
    $schema: CHARACTER_PAGES_INDEX_SCHEMA_ID,
    pages: [
      { page_id: "page-a5421a2fd842", character_id: "sigrid" },
      { page_id: "page-76210a0f5abb", character_id: "sigrid", variant_id: "wavechaser" },
      { page_id: "page-cd6177132b9f", character_id: "pyrois", variant_id: "variant" },
      { page_id: "page-b2dfa28feb0d", character_id: "pyrois" },
      { page_id: "page-000000000001", character_id: "npc-free" },
    ],
  };
  const { document, changed } = migrateCharacterPagesIndexVariants(source);
  assert.equal(changed, true);
  assert.deepEqual(document.pages.map(page => page.variant_id), ["uniform", "wavechaser", "futanari", "nude-armor", undefined]);
  assert.deepEqual(validateCharacterPagesIndexDocument({
    ...document,
    pages: document.pages.filter(page => page.character_id !== "npc-free"),
  }), []);
  const again = migrateCharacterPagesIndexVariants(document);
  assert.equal(again.changed, false);
});

test("剧情 narrative：缺 variant_id 补默认造型，旧 id 改名，未映射角色不动", () => {
  const source = {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "开场",
    scene_description: "描述",
    characters: [
      { character_id: "sigrid" },
      { character_id: "pyrois", variant_id: "variant" },
      { character_id: "wise", variant_id: "base" },
      { character_id: "other" },
    ],
    dialogue: [],
  };
  const { document, changed } = migrateStoryNarrativeVariants(source);
  assert.equal(changed, true);
  assert.deepEqual(
    document.characters.map(reference => [reference.character_id, reference.variant_id]),
    [["sigrid", "uniform"], ["pyrois", "futanari"], ["wise", "default"], ["other", undefined]],
  );
  const again = migrateStoryNarrativeVariants(document);
  assert.equal(again.changed, false);
  // 修正后的合法 narrative 通过校验。
  const valid = { ...document, characters: document.characters.filter(reference => reference.character_id !== "other") };
  assert.deepEqual(validateStoryPageNarrativeDocument(valid), []);
});

async function projectFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "character-variant-explicit-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "workspace", "demo");
  const save = async (relative, value) => {
    const target = path.join(project, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value, null, 2) + "\n");
  };
  await save("characters/sigrid.prompt.json", sigridPrompt());
  await save("characters/sigrid.visual.json", sigridVisual());
  await save("characters/pyrois.prompt.json", pyroisPrompt());
  await save("characters/pyrois.visual.json", pyroisVisual());
  await save("characters/wise.prompt.json", wisePrompt());
  await save("characters/wise.visual.json", wiseVisual());
  await save("characters/pages/index.json", {
    $schema: CHARACTER_PAGES_INDEX_SCHEMA_ID,
    pages: [
      { page_id: "page-a5421a2fd842", character_id: "sigrid" },
      { page_id: "page-cd6177132b9f", character_id: "pyrois", variant_id: "variant" },
      { page_id: "page-b2dfa28feb0d", character_id: "pyrois" },
    ],
  });
  await save("story/pages/page-000000000002.narrative.json", {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title: "开场",
    scene_description: "描述",
    characters: [{ character_id: "sigrid" }, { character_id: "pyrois", variant_id: "variant" }],
    dialogue: [],
  });
  return project;
}

test("项目级迁移覆盖 prompt/visual/pages/narrative，重跑幂等", async t => {
  const project = await projectFixture(t);
  const result = await migrateProjectCharacterVariants(project);
  const byFile = Object.fromEntries(result.files.map(report => [report.file, report.status]));
  const expected = [
    "characters/sigrid.prompt.json", "characters/sigrid.visual.json",
    "characters/pyrois.prompt.json", "characters/pyrois.visual.json",
    "characters/wise.prompt.json", "characters/wise.visual.json",
    "characters/pages/index.json", "story/pages/page-000000000002.narrative.json",
  ];
  for (const file of expected) assert.equal(byFile[file], "migrated", file);
  const json = async (relative) => JSON.parse(await readFile(path.join(project, relative), "utf8"));
  for (const characterId of ["sigrid", "pyrois", "wise"]) {
    assert.deepEqual(validateCharacterPromptDocument(await json(`characters/${characterId}.prompt.json`)), [], characterId);
    const visual = await json(`characters/${characterId}.visual.json`);
    assert.deepEqual(validateCharacterVisualDocument(visual), [], characterId);
    assert.equal(Object.hasOwn(visual, "base_description"), false);
  }
  assert.deepEqual(validateCharacterPagesIndexDocument(await json("characters/pages/index.json")), []);
  assert.deepEqual(validateStoryPageNarrativeDocument(await json("story/pages/page-000000000002.narrative.json")), []);
  const second = await migrateProjectCharacterVariants(project);
  assert.ok(second.files.every(report => report.status === "skipped"));
});
