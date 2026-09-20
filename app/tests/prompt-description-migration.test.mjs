import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migratePromptDescriptionDocument, applyPromptDescriptionMigration } from "../server/prompt-description-migration.mjs";

test("迁移仅改文本字段和类型，保留正文、ID、顺序、权重、绑定和 LoRA", () => {
  const source = { identity: { lora: { filename: "example.safetensors", weight: 1.2 }, prompt: [
    { id: "token-123456789abc", term: "soft light", weight: 1.3, enabled: false },
    { phrase: "a girl with (blue eyes:1.3)\nby the window", character_id: "hero" },
  ] }, fragment: { prompt_type: "custom_phrase", prompt_text: "((soft light:2):1.2)" } };
  const expected = { identity: { lora: { filename: "example.safetensors", weight: 1.2 }, prompt: [
    { id: "token-123456789abc", description: "soft light", weight: 1.3, enabled: false },
    { description: "a girl with (blue eyes:1.3)\nby the window", character_id: "hero" },
  ] }, fragment: { prompt_type: "custom_description", prompt_text: "((soft light:2):1.2)" } };
  const result = migratePromptDescriptionDocument(source);
  assert.deepEqual(result, { document: expected, changed: true });
  assert.equal(source.identity.prompt[0].term, "soft light");
  assert.deepEqual(migratePromptDescriptionDocument(expected), { document: expected, changed: false });
  assert.throws(() => migratePromptDescriptionDocument({ term: "old", description: "new" }), /多个文本字段/);
});

test("仅清理结构化模式的旧空自定义占位，保留已有自定义内容", () => {
  const empty = { mode: "structured", free: { positive: "", negative: "", loras: [] } };
  assert.deepEqual(migratePromptDescriptionDocument(empty), { document: { mode: "structured" }, changed: true });
  for (const source of [{ ...empty, mode: "free" }, { ...empty, free: { ...empty.free, positive: "custom text" } }]) {
    assert.deepEqual(migratePromptDescriptionDocument(source), { document: source, changed: false });
  }
});

test("迁移预检后文件变化则整批拒绝写入", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-description-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(root, "a.json"), b = path.join(root, "b.json");
  await writeFile(a, '{"term":"a"}');
  await writeFile(b, '{"term":"changed"}');
  await assert.rejects(applyPromptDescriptionMigration({ projects: [], files: [
    { file: a, raw: '{"term":"a"}', document: { description: "a" } },
    { file: b, raw: '{"term":"b"}', document: { description: "b" } },
  ] }), /迁移基线变化/);
  assert.equal(await readFile(a, "utf8"), '{"term":"a"}');
  assert.equal(await readFile(b, "utf8"), '{"term":"changed"}');
});
