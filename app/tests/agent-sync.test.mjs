import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentSyncError,
  applyAgentConfig,
  inspectAgentConfig,
} from "../../docs/agent/sync.mjs";

test("Agent 同步器建立共享技能链接，并拒绝覆盖手工目录", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-agent-sync-"));
  const sourceSkill = path.join(root, ".agents", "skills", "sample-skill");
  const targetSkill = path.join(root, ".claude", "skills", "sample-skill");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "# 项目规则\n\n- 使用中文文档。\n", "utf8");
  await writeFile(
    path.join(sourceSkill, "SKILL.md"),
    "---\nname: sample-skill\ndescription: 用于验证项目技能链接。\n---\n\n# 示例技能\n",
    "utf8",
  );

  context.after(() => rm(root, { recursive: true, force: true }));

  const actions = await applyAgentConfig({ root });
  assert.deepEqual(actions, ["更新 CLAUDE.md", "建立 Claude 技能链接：sample-skill"]);
  assert.equal(await realpath(targetSkill), await realpath(sourceSkill));
  assert.match(await readFile(path.join(root, "CLAUDE.md"), "utf8"), /# 项目规则/);

  const diagnosis = await inspectAgentConfig({ root });
  assert.deepEqual(diagnosis.errors, []);

  await rm(sourceSkill, { recursive: true });
  assert.deepEqual(await applyAgentConfig({ root }), ["移除过期 Claude 技能链接：sample-skill"]);
  await assert.rejects(lstat(targetSkill), { code: "ENOENT" });

  await mkdir(sourceSkill, { recursive: true });
  await writeFile(
    path.join(sourceSkill, "SKILL.md"),
    "---\nname: sample-skill\ndescription: 用于验证冲突保护。\n---\n\n# 示例技能\n",
    "utf8",
  );
  await mkdir(targetSkill);
  await writeFile(path.join(targetSkill, "manual.txt"), "保留我", "utf8");

  await assert.rejects(
    applyAgentConfig({ root }),
    (error) => error instanceof AgentSyncError && /拒绝覆盖/.test(error.message),
  );
  assert.equal(await readFile(path.join(targetSkill, "manual.txt"), "utf8"), "保留我");
});

test("Agent 同步器可以接管仅换行符不同的既有规则投影", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-agent-sync-crlf-"));
  const sourceSkill = path.join(root, ".agents", "skills", "sample-skill");
  await mkdir(sourceSkill, { recursive: true });
  const agents = "# 项目规则\n\n- 使用中文文档。\n";
  await writeFile(path.join(root, "AGENTS.md"), agents, "utf8");
  await writeFile(path.join(root, "CLAUDE.md"), `<!-- 由 docs/agent/sync.mjs 根据 AGENTS.md 生成，请勿直接修改。 -->\r\n\r\n${agents.replaceAll("\n", "\r\n")}`, "utf8");
  await writeFile(path.join(sourceSkill, "SKILL.md"), "---\nname: sample-skill\ndescription: 用于验证换行兼容。\n---\n", "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await applyAgentConfig({ root }), ["更新 CLAUDE.md", "建立 Claude 技能链接：sample-skill"]);
  assert.deepEqual((await inspectAgentConfig({ root })).errors, []);
});
