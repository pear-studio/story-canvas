import test from "node:test";
import assert from "node:assert/strict";
import { migratePromptPerson } from "../server/prompt-person-migration.mjs";
import { compileCurrentPagePrompt } from "../server/current-page-prompt.mjs";

test("人物迁移保留片段、覆盖和作者顺序，编译按身份再子设定，重跑不变", () => {
  const empty = { subject: [], appearance: [], action: [], setting: [], camera: [], avoid: [] };
  const source = {
    identity: { prompt: { ...empty, appearance: [{ description: "silver hair", weight: 1.2 }], action: [{ description: "calm gaze" }] } },
    prompt: { ...empty, appearance: [{ description: "blue coat" }], action: [{ description: "standing" }, { description: "sitting", enabled: false }] },
    identity_overrides: { "silver hair": { weight: 0.8 } },
  };
  const result = migratePromptPerson(source);
  assert.deepEqual(result.prompt.person, [{ description: "blue coat" }, { description: "standing" }, { description: "sitting", enabled: false }]);
  assert.deepEqual(result.identity_overrides, source.identity_overrides);
  assert.deepEqual(migratePromptPerson(result), result);
  assert.equal(Object.hasOwn(source.prompt, "person"), false);
  const compiled = compileCurrentPagePrompt({ pageId: "page-001", pageKey: { page_id: "page-001" },
    pagePrompt: migratePromptPerson(empty), participantIds: ["alice"], characters: [{ ...result, id: "alice", configuration_id: "coat", loras: [] }],
    profile: { id: "example", prompt: { family: "anima", category_order: ["subject", "person", "setting", "camera"], avoidance_strategy: "negative_prompt", fragments: {} } },
  });
  assert.deepEqual(compiled.prompt_parts.positive.map(part => part.text), ["(silver hair:0.8)", "calm gaze", "blue coat", "standing"]);
});

test("人物迁移拒绝混合新旧分类，避免静默覆盖", () => {
  assert.throws(() => migratePromptPerson({ appearance: [], action: [], person: [{ description: "keep" }] }), /同时存在 person/);
});
