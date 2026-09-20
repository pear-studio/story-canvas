import assert from "node:assert/strict";
import test from "node:test";
import { auditPromptContext } from "../server/prompt-audit.mjs";
import { promptIssueLocations, promptIssueSummary } from "../src/prompt-audit-display.ts";

function record(text, index, extra = {}) {
  return {
    fragment: { prompt_type: "danbooru", prompt_text: text },
    path: `story/pages/page-001.prompt.json.subject[${index}]`,
    category: "subject", scope: "page:page-001", source_kind: "page", source_id: "page-001", ...extra,
  };
}

test("流程预览和生成禁用短说明包含具体词；关联位置完整且不合并不同来源", () => {
  const audit = auditPromptContext({ positive: [record("bad_first", 0), record("bad_second", 1)] }, { dictionaryEntries: [] });
  assert.deepEqual(audit.errors.map(promptIssueSummary), ["“bad_first”：Danbooru 标签不在固定词库中", "“bad_second”：Danbooru 标签不在固定词库中"]);
  assert.match(promptIssueLocations(audit.errors[1])[0], /subject\[1\]/);
  const conflict = auditPromptContext({ positive: [record("smile", 0)], negative: [record("smile", 1)] }).errors[0];
  assert.match(promptIssueSummary(conflict), /“smile”/);
  assert.equal(promptIssueLocations(conflict).length, 2);
});

test("solo 冲突保留所有相关人数词及位置", () => {
  const audit = auditPromptContext({ positive: [record("solo", 0), record("1girl", 1), record("1boy", 2)] });
  const issue = audit.errors.find((item) => item.code === "prompt.population.solo_conflict");
  assert.deepEqual(issue.related.map((item) => item.prompt_text), ["1girl", "1boy"]);
  assert.match(promptIssueSummary(issue), /“solo” \/ “1girl” \/ “1boy”/);
  assert.equal(promptIssueLocations(issue).length, 3);
});

test("页面、角色和生成配置不限制描述或加权片段数量", () => {
  const positive = ["page", "character", "render_profile"].flatMap(source_kind => Array.from({ length: 40 }, (_, index) => record(source_kind + index, index, {
    source_kind, source_id: source_kind, scope: source_kind,
    fragment: { prompt_type: "custom_description", prompt_text: source_kind + index + " 长描述。\n" + "soft light ".repeat(25), weight: 1.1 },
  })));
  const negative = positive.map(item => ({...item, category: "avoid", fragment: {...item.fragment, prompt_text: "avoid " + item.fragment.prompt_text}}));
  const audit = auditPromptContext({ positive, negative });
  assert.deepEqual(audit.errors, []);
  assert.deepEqual(audit.warnings, []);
  assert.equal(audit.stats.total, 240);
  assert.equal(audit.stats.weighted, 240);
  assert.equal(audit.stats.custom_description, 240);
});
