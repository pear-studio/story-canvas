import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import { PAGES_INDEX_SCHEMA_ID } from "../server/pages-store.mjs";
import { factFixture } from "./fact-fixture.mjs";
const { read: readTextSourcesDraft, save: saveTextSourcesDraft } = factFixture("story", "text-sources");
const { read: readStoryNarrativeDraft, save: saveStoryNarrativeDraft } = factFixture("story", "narrative");
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deleteStoryPage,
  duplicateStoryPage,
} from "../server/story-facts.mjs";
import { deletePageTextSource } from "../server/project-workbench.mjs";
import { readWritingCorpusContext } from "../server/writing-corpus.mjs";
import { hashCanonicalJson } from "../server/workflow-definition.mjs";
import {
  STORY_OUTLINE_SCHEMA_ID,
  STORY_PAGE_NARRATIVE_SCHEMA_ID,
  STORY_PAGE_PROMPT_SCHEMA_ID,
  STORY_PAGE_TEXT_SOURCES_SCHEMA_ID,
  validateStoryPageTextSourcesDocument,
} from "../server/story-files.mjs";
import {
  CHARACTER_INDEX_SCHEMA_ID,
  CHARACTER_PROFILE_SCHEMA_ID,
  CHARACTER_PROMPT_SCHEMA_ID,
  CHARACTER_VISUAL_SCHEMA_ID,
} from "../server/character-files.mjs";

const SPEECH_ID = "dialogue-aaaa00000001";
const HEART_ID = "dialogue-aaaa00000002";
const THOUGHT_ID = "dialogue-aaaa00000003";
const CORPUS_SOURCE = "测试源/原文/book-a.txt";
const SENTENCE_QUOTED = "原句甲：就是这里。";
const SENTENCE_PLAIN = "原句乙，没有引号的旁白句。";

const corpusLines = [
  "第一段旁白，氛围铺垫。",
  `「${SENTENCE_QUOTED}」`,
  "中间过渡的一行。",
  SENTENCE_PLAIN,
  "末尾一行收束。",
];
const corpusText = `${corpusLines.join("\n")}\n`;

function corpusOffset(sentence) {
  const charIndex = corpusText.indexOf(sentence);
  assert.notEqual(charIndex, -1, `语料中应存在：${sentence}`);
  return Buffer.byteLength(corpusText.slice(0, charIndex), "utf8");
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function exists(target) {
  try { await access(target); return true; }
  catch { return false; }
}

function pagePrompt(characterId) {
  return { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, subject: [{ tag: "1girl", character_id: characterId }], person: [],  setting: [], camera: [], avoid: [] };
}

function characterPrompt() {
  const prompt = { subject: [], person: [],  setting: [], camera: [], avoid: [] };
  return {
    $schema: CHARACTER_PROMPT_SCHEMA_ID,
    identity: { prompt: structuredClone(prompt), lora: null },
    variants: { uniform: { prompt, loras: [], identity_disabled: [] } },
  };
}

function narrative(title, dialogue = []) {
  return {
    $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID,
    title,
    scene_description: `${title}的画面目标。`,
    characters: [{ character_id: "ellen", variant_id: "uniform" }],
    dialogue,
  };
}

async function createFixture(context) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "text-sources-"));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const projectId = "demo";
  const projectDirectory = path.join(repositoryRoot, "workspace", projectId);
  const pagesDirectory = path.join(projectDirectory, "pages");
  await mkdir(pagesDirectory, { recursive: true });
  await writeJson(path.join(projectDirectory, "story", "outline.json"), {
    $schema: STORY_OUTLINE_SCHEMA_ID,
    synopsis: "原文参考机制测试。",
    chapters: [{
      id: "opening", title: "开场", summary: "建立线索。",
      sequences: [
        { id: "arrival", title: "抵达", summary: "艾莲抵达。" },
        { id: "waiting", title: "等待", summary: "路人等待。" },
      ],
    }],
  });
  await writeJson(path.join(pagesDirectory, "index.json"), {
    $schema: PAGES_INDEX_SCHEMA_ID,
    pages: [{ page_id: "page-001", owner_kind: "story", sequence_id: "arrival" }, { page_id: "page-002", owner_kind: "story", sequence_id: "waiting" }],
  });
  await writeJson(path.join(pagesDirectory, "page-001.content.json"), narrative("抵达", [
    { id: SPEECH_ID, mode: "speech", speaker: "ellen", text: "就是这里。" },
    { id: HEART_ID, mode: "heart", speaker: "ellen", text: "♡" },
    { id: THOUGHT_ID, mode: "thought", speaker: "ellen", text: "得进去了。" },
  ]));
  await writeJson(path.join(pagesDirectory, "page-001.prompt.json"), pagePrompt("ellen"));
  await writeJson(path.join(pagesDirectory, "page-002.content.json"), narrative("等待"));
  await writeJson(path.join(pagesDirectory, "page-002.prompt.json"), pagePrompt("ellen"));
  await writeJson(path.join(projectDirectory, "characters", "index.json"), {
    $schema: CHARACTER_INDEX_SCHEMA_ID,
    characters: ["ellen"],
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.profile.json"), {
    $schema: CHARACTER_PROFILE_SCHEMA_ID, name: "ellen", description: "ellen 的非视觉设定。",
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.visual.json"), {
    $schema: CHARACTER_VISUAL_SCHEMA_ID, description: "ellen 的基础外观。",
    variants: [{ id: "uniform", name: "制服", description: "穿制服。" }],
  });
  await writeJson(path.join(projectDirectory, "characters", "ellen.prompt.json"), characterPrompt());
  const corpusFile = path.join(repositoryRoot, "library", "writing-corpus", "测试源", "原文", "book-a.txt");
  await mkdir(path.dirname(corpusFile), { recursive: true });
  await writeFile(corpusFile, corpusText, "utf8");
  registerFixtureProjects(repositoryRoot); return { repositoryRoot, projectDirectory, pagesDirectory, projectId, corpusFile };
}

function textSourceEntry(sentence, offset = corpusOffset(sentence)) {
  return { source_file: CORPUS_SOURCE, offset, original_sentence: sentence };
}

async function saveSpeechSource(fixture, dialogueId = SPEECH_ID, sentence = SENTENCE_QUOTED) {
  const draft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document[dialogueId] = textSourceEntry(sentence);
  return saveTextSourcesDraft(fixture.repositoryRoot, draft);
}

test("text-sources 文档校验：空文档与合法条目通过，坏 key/字段/偏移被拒绝", () => {
  assert.deepEqual(validateStoryPageTextSourcesDocument({}), []);
  assert.deepEqual(validateStoryPageTextSourcesDocument({ [SPEECH_ID]: textSourceEntry(SENTENCE_QUOTED, 0) }), []);
  assert.deepEqual(validateStoryPageTextSourcesDocument({ $schema: STORY_PAGE_TEXT_SOURCES_SCHEMA_ID }), []);
  assert.ok(validateStoryPageTextSourcesDocument({ $schema: "wrong" }).some(error => error.includes("$schema")));
  assert.ok(validateStoryPageTextSourcesDocument({ "not-a-dialogue": {} }).some(error => error.includes("不是有效对白 ID")));
  assert.ok(validateStoryPageTextSourcesDocument({ [SPEECH_ID]: { source_file: "a.txt", offset: 0 } }).some(error => error.includes("original_sentence")));
  assert.ok(validateStoryPageTextSourcesDocument({ [SPEECH_ID]: { ...textSourceEntry(SENTENCE_QUOTED, 0), extra: 1 } }).some(error => error.includes("extra")));
  assert.ok(validateStoryPageTextSourcesDocument({ [SPEECH_ID]: textSourceEntry(SENTENCE_QUOTED, -1) }).some(error => error.includes("offset")));
  assert.ok(validateStoryPageTextSourcesDocument({ [SPEECH_ID]: { ...textSourceEntry(SENTENCE_QUOTED, 0), source_file: " " } }).some(error => error.includes("source_file")));
  assert.deepEqual(validateStoryPageTextSourcesDocument([]), ["text-sources 必须是 JSON 对象"]);
});

test("不存在的 text-sources 按空文档读取，空文档可首存落盘", async (context) => {
  const fixture = await createFixture(context);
  const draft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-002");
  assert.deepEqual(draft.document, {});
  assert.equal(draft.expected_sha256, hashCanonicalJson({}), "空文档 baseline 是 hashCanonicalJson({})");
  const result = await saveTextSourcesDraft(fixture.repositoryRoot, draft);
  assert.deepEqual(await readJson(result.target_file), {});
  const reread = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-002");
  assert.deepEqual(reread.document, {});
});

test("按字节核验通过后可保存并读回", async (context) => {
  const fixture = await createFixture(context);
  const draft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document[SPEECH_ID] = textSourceEntry(SENTENCE_QUOTED);
  draft.document[THOUGHT_ID] = textSourceEntry(SENTENCE_PLAIN);
  const result = await saveTextSourcesDraft(fixture.repositoryRoot, draft);
  const persisted = await readJson(result.target_file);
  assert.deepEqual(persisted[SPEECH_ID], textSourceEntry(SENTENCE_QUOTED));
  assert.deepEqual(persisted[THOUGHT_ID], textSourceEntry(SENTENCE_PLAIN));
});

test("偏移或原句不符时拒绝保存并引导 corpus:search", async (context) => {
  const fixture = await createFixture(context);
  for (const entry of [
    textSourceEntry(SENTENCE_QUOTED, corpusOffset(SENTENCE_QUOTED) + 1),
    { ...textSourceEntry(SENTENCE_PLAIN), offset: corpusOffset(SENTENCE_QUOTED) },
    textSourceEntry("语料里不存在的句子。", 0),
  ]) {
    const draft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
    draft.document[SPEECH_ID] = entry;
    await assert.rejects(
      () => saveTextSourcesDraft(fixture.repositoryRoot, draft),
      (error) => error?.code === "text_source_offset_mismatch"
        && error?.status === 422
        && error.details.some((detail) => detail.includes("corpus:search")),
    );
  }
  assert.equal(await exists(path.join(fixture.pagesDirectory, "page-001.text-sources.json")), false, "拒绝时不得落盘");
});

test("heart 条目与不存在的对白挂出处被拒绝", async (context) => {
  const fixture = await createFixture(context);
  const heartDraft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  heartDraft.document[HEART_ID] = textSourceEntry(SENTENCE_QUOTED);
  await assert.rejects(
    () => saveTextSourcesDraft(fixture.repositoryRoot, heartDraft),
    (error) => error?.code === "invalid_text_source_reference"
      && error?.status === 422
      && error.details.some((detail) => detail.includes("爱心") && detail.includes(HEART_ID)),
  );
  const danglingDraft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  danglingDraft.document["dialogue-bbbb00000009"] = textSourceEntry(SENTENCE_QUOTED);
  await assert.rejects(
    () => saveTextSourcesDraft(fixture.repositoryRoot, danglingDraft),
    (error) => error?.code === "invalid_text_source_reference"
      && error.details.some((detail) => detail.includes("不存在")),
  );
});

test("source_file 绝对路径、.. 逃逸与符号链接被拒绝", async (context) => {
  const fixture = await createFixture(context);
  const outside = path.join(fixture.repositoryRoot, "workspace", "outside.txt");
  await writeFile(outside, corpusText, "utf8");
  const linkTarget = path.join(fixture.repositoryRoot, "library", "writing-corpus", "测试源", "原文", "linked");
  await symlink(path.dirname(outside), linkTarget, process.platform === "win32" ? "junction" : "dir");
  for (const sourceFile of ["/etc/passwd", "../outside.txt", "测试源/原文/../../outside.txt", "测试源/原文/linked/outside.txt", "测试源/原文/missing.txt"]) {
    const draft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
    draft.document[SPEECH_ID] = { ...textSourceEntry(SENTENCE_QUOTED), source_file: sourceFile };
    await assert.rejects(
      () => saveTextSourcesDraft(fixture.repositoryRoot, draft),
      (error) => ["invalid_text_source_path", "text_source_file_missing"].includes(error?.code) && error?.status === 422,
      `应拒绝：${sourceFile}`,
    );
  }
});

test("narrative 变化使旧 text-sources 草稿失效", async (context) => {
  const fixture = await createFixture(context);
  const draft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document[SPEECH_ID] = textSourceEntry(SENTENCE_QUOTED);
  const narrativeDraft = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  narrativeDraft.document.title = "抵达之后";
  await saveStoryNarrativeDraft(fixture.repositoryRoot, narrativeDraft);
  await assert.rejects(
    () => saveTextSourcesDraft(fixture.repositoryRoot, draft),
    (error) => error?.code === "fact_upstream_conflict",
  );
});

test("narrative 删除被引用对白与改为 heart 时产生 warning", async (context) => {
  const fixture = await createFixture(context);
  await saveSpeechSource(fixture);
  const thoughtDraft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  thoughtDraft.document[THOUGHT_ID] = textSourceEntry(SENTENCE_PLAIN);
  await saveTextSourcesDraft(fixture.repositoryRoot, thoughtDraft);

  const removal = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  removal.document.dialogue = removal.document.dialogue.filter((dialogue) => dialogue.id !== SPEECH_ID);
  const removed = await saveStoryNarrativeDraft(fixture.repositoryRoot, removal);
  assert.ok(removed.downstream_diagnostics.some((item) => item.code === "dangling_text_source" && item.dialogue_id === SPEECH_ID));

  const toHeart = await readStoryNarrativeDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  toHeart.document.dialogue.find((dialogue) => dialogue.id === THOUGHT_ID).mode = "heart";
  const hearted = await saveStoryNarrativeDraft(fixture.repositoryRoot, toHeart);
  assert.ok(hearted.downstream_diagnostics.some((item) => item.code === "heart_text_source" && item.dialogue_id === THOUGHT_ID));
});

test("删除单条映射后其余条目保留", async (context) => {
  const fixture = await createFixture(context);
  const draft = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  draft.document[SPEECH_ID] = textSourceEntry(SENTENCE_QUOTED);
  draft.document[THOUGHT_ID] = textSourceEntry(SENTENCE_PLAIN);
  await saveTextSourcesDraft(fixture.repositoryRoot, draft);

  const fresh = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  const result = await deletePageTextSource(fixture.repositoryRoot, fixture.projectId, {
    page_id: "page-001",
    dialogue_id: SPEECH_ID,
    expected_sha256: fresh.expected_sha256,
    expected_context_sha256: fresh.expected_context_sha256,
  });
  assert.deepEqual(Object.keys(result.text_sources), [THOUGHT_ID]);
  const persisted = await readJson(path.join(fixture.pagesDirectory, "page-001.text-sources.json"));
  assert.deepEqual(Object.keys(persisted), [THOUGHT_ID]);

  const again = await readTextSourcesDraft(fixture.repositoryRoot, fixture.projectId, "page-001");
  await assert.rejects(
    () => deletePageTextSource(fixture.repositoryRoot, fixture.projectId, {
      page_id: "page-001",
      dialogue_id: SPEECH_ID,
      expected_sha256: again.expected_sha256,
      expected_context_sha256: again.expected_context_sha256,
    }),
    (error) => error?.code === "text_source_not_found" && error?.status === 404,
  );
});

test("页面删除时 text-sources 一并归档", async (context) => {
  const fixture = await createFixture(context);
  await saveSpeechSource(fixture);
  const result = await deleteStoryPage(fixture.repositoryRoot, fixture.projectId, "page-001");
  assert.ok(result.archived_paths.includes("pages/page-001.text-sources.json"));
  assert.equal(await exists(path.join(fixture.pagesDirectory, "page-001.text-sources.json")), false);
  const archived = await readJson(path.join(result.archive_directory, "pages", "page-001.text-sources.json"));
  assert.deepEqual(archived[SPEECH_ID], textSourceEntry(SENTENCE_QUOTED));
});

test("页面复制逐字节复制 text-sources，源页面无映射时容忍", async (context) => {
  const fixture = await createFixture(context);
  await saveSpeechSource(fixture);
  const duplicated = await duplicateStoryPage(fixture.repositoryRoot, fixture.projectId, "page-001");
  const sourceBytes = await readFile(path.join(fixture.pagesDirectory, "page-001.text-sources.json"));
  const copiedBytes = await readFile(path.join(fixture.pagesDirectory, `${duplicated.page_id}.text-sources.json`));
  assert.deepEqual(copiedBytes, sourceBytes, "text-sources 必须逐字节一致");

  const plain = await duplicateStoryPage(fixture.repositoryRoot, fixture.projectId, "page-002");
  assert.equal(plain.text_sources_file, undefined);
  assert.equal(await exists(path.join(fixture.pagesDirectory, `${plain.page_id}.text-sources.json`)), false);
});

test("语料上下文按行返回命中行 ±2 行", async (context) => {
  const fixture = await createFixture(context);
  const context2 = await readWritingCorpusContext(fixture.repositoryRoot, CORPUS_SOURCE, corpusOffset(SENTENCE_PLAIN));
  assert.equal(context2.hit_line, 4);
  assert.deepEqual(context2.lines.map((line) => line.number), [2, 3, 4, 5, 6], "语料末尾的换行产生空行 6");
  assert.equal(context2.lines.find((line) => line.hit).text, SENTENCE_PLAIN);
  const first = await readWritingCorpusContext(fixture.repositoryRoot, CORPUS_SOURCE, corpusOffset(corpusLines[0]));
  assert.deepEqual(first.lines.map((line) => line.number), [1, 2, 3], "文件头不足 -2 行时截断");
  await assert.rejects(
    () => readWritingCorpusContext(fixture.repositoryRoot, CORPUS_SOURCE, Buffer.byteLength(corpusText, "utf8") + 1),
    (error) => error?.code === "text_source_offset_mismatch",
  );
});
