import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RenderProfileCompilerError,
  compileEffectiveRenderProfile,
  validateProjectRenderProfileOverride,
} from "../server/render-profile-compiler.mjs";
import { hashCanonicalJson } from "../server/workflow-definition.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const profileId = "qwen-image-2-1";
const stepsTarget = "operations.candidates.routes.empty_latent.recipe.steps";

function state(value) {
  return { exists: true, value };
}

function override(changes) {
  return { version: 1, profiles: { [profileId]: { changes } } };
}

async function withProject(context) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "story-canvas-effective-profile-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

async function writeOverride(projectRoot, value) {
  await writeFile(path.join(projectRoot, "render-profile.override.json"), `${JSON.stringify(value, null, 2)}\n`);
}

test("effective compiler 区分 applied、redundant、conflict 且冲突不返回 partial effective", async (context) => {
  const projectRoot = await withProject(context);
  const inherited = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId });
  assert.equal(inherited.override_resolution.configured, false);
  assert.equal(inherited.effective_profile_sha256, inherited.base_bundle.resolved_profile_sha256);
  assert.deepEqual(Object.keys(inherited.workflow_definitions).sort(), Object.keys(inherited.base_bundle.workflow_definitions).sort());

  await writeOverride(projectRoot, override([{
    target: stepsTarget, original: state(25), project: state(30),
  }]));
  const applied = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId });
  assert.equal(applied.blocked, false);
  assert.deepEqual(applied.override_resolution.changes.map((change) => change.target), [stepsTarget]);
  assert.equal(applied.effective_profile.operations.candidates.routes.empty_latent.recipe.steps, 30);
  assert.equal(applied.effective_profile_sha256, hashCanonicalJson(applied.effective_profile));
  assert.match(applied.source_identity.project_override.sha256, /^[0-9a-f]{64}$/);

  await writeOverride(projectRoot, override([{
    target: stepsTarget, original: state(20), project: state(25),
  }]));
  const redundant = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId });
  assert.equal(redundant.blocked, false);
  assert.deepEqual(redundant.override_resolution.redundant.map((change) => change.target), [stepsTarget]);
  assert.equal(redundant.effective_profile.operations.candidates.routes.empty_latent.recipe.steps, 25);

  await writeOverride(projectRoot, override([{
    target: stepsTarget, original: state(20), project: state(30),
  }]));
  const conflict = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId });
  assert.equal(conflict.blocked, true);
  assert.deepEqual(conflict.override_resolution.conflicts.map((change) => change.target), [stepsTarget]);
  assert.equal(conflict.effective_profile, null);
  assert.equal(conflict.effective_profile_sha256, null);
  assert.equal(conflict.workflow_definitions, null);
  assert.equal(conflict.source_identity, null);
});

test("workflow override 不存在或 definition 非法时不保留基础 registry 静默继续", async (context) => {
  const projectRoot = await withProject(context);
  await writeOverride(projectRoot, override([{
    target: "operations.candidates.routes.empty_latent.workflow",
    original: state("qwen-image-2-1-text"),
    project: state("missing-project-workflow"),
  }]));
  await assert.rejects(
    compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId }),
    /effective workflow missing-project-workflow 无法读取或校验/,
  );
});

test("prompt.text override 进入 effective profile 且来源身份不含片段映射", async (context) => {
  const projectRoot = await withProject(context);
  const inherited = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId });
  const baseText = inherited.base_bundle.resolved_profile.prompt.text;
  await writeOverride(projectRoot, override([{
    target: "prompt.text",
    original: state(baseText),
    project: state("项目替换的全局文字。"),
  }]));

  const result = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId });
  assert.equal(result.effective_profile.prompt.text, "项目替换的全局文字。");
  assert.equal(Object.hasOwn(result.source_identity, "prompt_fragments"), false);
  assert.equal(Object.hasOwn(result.source_identity, "prompt_policy"), false);
});

test("inactive 组的三方冲突不参与当前编译，但损坏的完整项目事实仍被拒绝", async (context) => {
  const projectRoot = await withProject(context);
  await writeOverride(projectRoot, {
    version: 1,
    profiles: {
      "other-profile": { changes: [{
        target: stepsTarget,
        original: state(20),
        project: state(30),
      }] },
    },
  });
  const current = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId });
  assert.equal(current.blocked, false);
  assert.equal(current.override_resolution.configured, false);

  await writeOverride(projectRoot, { version: 1, profiles: { "other-profile": { changes: [{ old: "legacy" }] } } });
  await assert.rejects(
    compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId }),
    /render_profile override 无效/,
  );
});

test("显式候选 override 是 compiler 的单一输入，不读取磁盘旧文档", async (context) => {
  const projectRoot = await withProject(context);
  await writeFile(path.join(projectRoot, "render-profile.override.json"), "{broken-json\n", "utf8");
  const candidate = override([{
    target: stepsTarget,
    original: state(25),
    project: state(31),
  }]);

  const result = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId, overrideDocument: candidate });
  assert.equal(result.effective_profile.operations.candidates.routes.empty_latent.recipe.steps, 31);
  assert.equal(result.override_source_identity.sha256, hashCanonicalJson(candidate));

  await assert.rejects(
    compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId }),
    (error) => {
      assert.ok(error instanceof RenderProfileCompilerError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "render_profile_compilation_failed");
      assert.match(error.message, /不是合法 JSON/);
      return true;
    },
  );
});

test("候选文档验证允许三方冲突，但拒绝无法形成合法 effective profile 的项目值", async (context) => {
  const projectRoot = await withProject(context);
  const conflict = override([{
    target: stepsTarget,
    original: state(20),
    project: state(30),
  }]);
  assert.deepEqual(await validateProjectRenderProfileOverride({
    repositoryRoot,
    projectRoot,
    overrideDocument: conflict,
  }), conflict);

  const invalidCases = [
    {
      name: "不存在的 profile ID",
      document: { version: 1, profiles: { "missing-profile": { changes: [] } } },
      message: /render profile 引用不存在：missing-profile/,
    },
    {
      name: "target 值类型错误",
      document: override([{ target: stepsTarget, original: state(24), project: state("thirty") }]),
      message: /recipe\.steps\.project 类型无效/,
    },
    {
      name: "冲突项目值引用不存在的 workflow",
      document: override([{
        target: "operations.candidates.routes.empty_latent.workflow",
        original: state("legacy-workflow"),
        project: state("missing-project-workflow"),
      }]),
      message: /effective workflow missing-project-workflow 无法读取或校验/,
    },
  ];

  for (const invalid of invalidCases) {
    await assert.rejects(
      validateProjectRenderProfileOverride({ repositoryRoot, projectRoot, overrideDocument: invalid.document }),
      (error) => {
        assert.ok(error instanceof RenderProfileCompilerError, invalid.name);
        assert.equal(error.status, 422, invalid.name);
        assert.equal(error.code, "render_profile_compilation_failed", invalid.name);
        assert.match(error.message, invalid.message, invalid.name);
        return true;
      },
    );
  }
});
