import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  emptyRenderProfileOverrideDocument,
  readRenderProfileOverrideDocument,
  resolveRenderProfileOverride,
  saveRenderProfileOverrideDocument,
  validateRenderProfileOverrideDocument,
} from "../server/render-profile-override.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function semanticProfile() {
  return {
    id: "studio-base-v1",
    architecture_family: "anima",
    models: {
      dit: { filename: "base.safetensors", relative_path: "diffusion_models/base.safetensors", sha256: "a".repeat(64) },
      text_encoder: { filename: "encoder.safetensors", relative_path: "text_encoders/encoder.safetensors", sha256: "b".repeat(64) },
      vae: { filename: "vae.safetensors", relative_path: "vae/vae.safetensors", sha256: "c".repeat(64) },
    },
    prompt: {
      policy: "anima-v1",
      fragments: {
        quality: { polarity: "positive", placement: "prefix", order: 100, prompt_type: "custom_description", prompt_text: "best quality" },
      },
    },
    operations: {
      candidates: {
        routes: {
          empty_latent: {
            workflow: "anima-candidate-page",
            recipe: {
              steps: 24,
              cfg: 6,
              sampler: "euler_ancestral",
              scheduler: "normal",
              clip_skip: 1,
              resolutions: { "2:3": { width: 1024, height: 1536 } },
            },
          },
        },
      },
    },
    style_loras: {
      watercolor: { filename: "watercolor.safetensors", sha256: "b".repeat(64), weight: 0.7 },
    },
  };
}

function document(changes, profileId = "studio-base-v1") {
  return { version: 1, profiles: { [profileId]: { changes } } };
}

function state(value) {
  return { exists: true, value };
}

test("项目 override 缺文件读取为空，保存以完整文档原子替换", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "story-canvas-override-"));
  context.after(() => rm(projectDirectory, { recursive: true, force: false }));
  assert.deepEqual(await readRenderProfileOverrideDocument(projectDirectory), emptyRenderProfileOverrideDocument());

  const first = {
    version: 1,
    profiles: {
      "studio-base-v1": {
        changes: [{
          target: "operations.candidates.routes.empty_latent.recipe.steps",
          original: state(24),
          project: state(30),
        }],
      },
    },
  };
  assert.deepEqual(await saveRenderProfileOverrideDocument(projectDirectory, first), first);
  assert.deepEqual(await readRenderProfileOverrideDocument(projectDirectory), first);

  const replacement = emptyRenderProfileOverrideDocument();
  await saveRenderProfileOverrideDocument(projectDirectory, replacement);
  assert.deepEqual(JSON.parse(await readFile(path.join(projectDirectory, "render-profile.override.json"), "utf8")), replacement);
  assert.deepEqual(await readRenderProfileOverrideDocument(projectDirectory), replacement);

});

test("持久化文档严格拒绝任一 profile 的损坏结构、重复 target 和白名单外目标", async (context) => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "story-canvas-override-invalid-"));
  context.after(() => rm(projectDirectory, { recursive: true, force: false }));
  const invalidDocuments = [
    { version: 1, profiles: { "inactive-profile": { changes: [{ old: "legacy" }] } } },
    document([{ target: "architecture_family", original: state("sdxl"), project: state("anima") }]),
    document([
      { target: "prompt.policy", original: state("illustrious-v1"), project: state("wai-v1") },
      { target: "prompt.policy", original: state("illustrious-v1"), project: state("pony-v1") },
    ]),
    document([{ target: "prompt.policy", original: { exists: false, value: null }, project: state("wai-v1") }]),
  ];
  for (const value of invalidDocuments) {
    assert.throws(() => validateRenderProfileOverrideDocument(value), /render_profile override 无效/);
    await assert.rejects(() => saveRenderProfileOverrideDocument(projectDirectory, value), /render_profile override 无效/);
  }

  await writeFile(path.join(projectDirectory, "render-profile.override.json"), "{not-json\n", "utf8");
  await assert.rejects(() => readRenderProfileOverrideDocument(projectDirectory), (error) => {
    assert.equal(error.code, "invalid_render_profile_override");
    assert.equal(error.status, 422);
    assert.match(error.message, /不是合法 JSON/);
    return true;
  });
});

test("最终语义 target 按原值应用且不修改已解析基础配置", () => {
  const base = semanticProfile();
  const original = structuredClone(base);
  const replacementModel = { ...base.models.dit, filename: "project.safetensors", sha256: "d".repeat(64) };
  const result = resolveRenderProfileOverride({
    resolvedProfile: base,
    overrideDocument: document([
      { target: "models.dit", original: state(base.models.dit), project: state(replacementModel) },
      { target: "prompt.policy", original: state("anima-v1"), project: state("anima-project-v1") },
      { target: "prompt.fragments.atmosphere", original: { exists: false }, project: state({ polarity: "positive", placement: "prefix", order: 300, prompt_type: "custom_description", prompt_text: "misty atmosphere" }) },
      { target: "prompt.fragments.quality", original: state(base.prompt.fragments.quality), project: { exists: false } },
      { target: "operations.candidates.routes.empty_latent.workflow", original: state("anima-candidate-page"), project: state("project-anima-candidate-page") },
      { target: "operations.candidates.routes.empty_latent.recipe.steps", original: state(24), project: state(30) },
      { target: "operations.candidates.routes.empty_latent.recipe.resolutions.2:3", original: state({ width: 1024, height: 1536 }), project: state({ width: 960, height: 1440 }) },
      { target: "style_loras.watercolor.weight", original: state(0.7), project: state(0.55) },
    ]),
  });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.changes.map((change) => change.target), [
    "models.dit",
    "prompt.policy",
    "prompt.fragments.atmosphere",
    "prompt.fragments.quality",
    "operations.candidates.routes.empty_latent.workflow",
    "operations.candidates.routes.empty_latent.recipe.steps",
    "operations.candidates.routes.empty_latent.recipe.resolutions.2:3",
    "style_loras.watercolor.weight",
  ]);
  assert.equal(result.effective_profile.models.dit.filename, "project.safetensors");
  assert.equal(result.effective_profile.prompt.policy, "anima-project-v1");
  assert.equal(result.effective_profile.prompt.fragments.atmosphere.prompt_text, "misty atmosphere");
  assert.equal(Object.hasOwn(result.effective_profile.prompt.fragments, "quality"), false);
  assert.equal(result.effective_profile.prompt.policy, "anima-project-v1");
  assert.equal(result.effective_profile.operations.candidates.routes.empty_latent.workflow, "project-anima-candidate-page");
  assert.equal(result.effective_profile.operations.candidates.routes.empty_latent.recipe.steps, 30);
  assert.deepEqual(result.effective_profile.operations.candidates.routes.empty_latent.recipe.resolutions["2:3"], { width: 960, height: 1440 });
  assert.equal(result.effective_profile.style_loras.watercolor.weight, 0.55);
  assert.deepEqual(base, original);
});

test("结构化目标按深值而非引用完成 applied、redundant、conflict 三态", () => {
  const target = "operations.candidates.routes.empty_latent.recipe.resolutions.2:3";
  const original = { width: 1024, height: 1536 };
  const project = { width: 960, height: 1440 };
  const resolve = (current) => {
    const base = semanticProfile();
    base.operations.candidates.routes.empty_latent.recipe.resolutions["2:3"] = structuredClone(current);
    return resolveRenderProfileOverride({
      resolvedProfile: base,
      overrideDocument: document([{ target, original: state(structuredClone(original)), project: state(structuredClone(project)) }]),
    });
  };

  const applied = resolve(original);
  assert.equal(applied.blocked, false);
  assert.deepEqual(applied.effective_profile.operations.candidates.routes.empty_latent.recipe.resolutions["2:3"], project);
  assert.deepEqual(applied.changes.map((change) => change.target), [target]);

  const redundant = resolve(project);
  assert.equal(redundant.blocked, false);
  assert.deepEqual(redundant.redundant.map((change) => change.target), [target]);

  const conflict = resolve({ width: 832, height: 1216 });
  assert.equal(conflict.blocked, true);
  assert.deepEqual(conflict.conflicts[0], {
    target,
    original: state(original),
    project: state(project),
    current: state({ width: 832, height: 1216 }),
  });
});

test("分辨率删除只在实际应用时校验，已吸收与漂移仍保留三态", () => {
  const target = "operations.candidates.routes.empty_latent.recipe.resolutions.3:4";
  const removed = { exists: false };
  const original = { width: 960, height: 1280 };
  const resolve = (current) => {
    const base = semanticProfile();
    if (current !== undefined) base.operations.candidates.routes.empty_latent.recipe.resolutions["3:4"] = structuredClone(current);
    return resolveRenderProfileOverride({
      resolvedProfile: base,
      overrideDocument: document([{ target, original: state(original), project: removed }]),
    });
  };

  const applied = resolve(original);
  assert.equal(applied.blocked, false);
  assert.equal(Object.hasOwn(applied.effective_profile.operations.candidates.routes.empty_latent.recipe.resolutions, "3:4"), false);

  const redundant = resolve(undefined);
  assert.equal(redundant.blocked, false);
  assert.deepEqual(redundant.redundant.map((change) => change.target), [target]);

  const conflict = resolve({ width: 896, height: 1152 });
  assert.equal(conflict.blocked, true);
  assert.deepEqual(conflict.conflicts[0].current, state({ width: 896, height: 1152 }));
});

test("project 已被基础吸收时记录冗余，其余 override 正常应用", () => {
  const result = resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([
      { target: "operations.candidates.routes.empty_latent.recipe.steps", original: state(20), project: state(24) },
      { target: "style_loras.watercolor.weight", original: state(0.7), project: state(0.6) },
    ]),
  });

  assert.equal(result.blocked, false);
  assert.ok(result.effective_profile);
  assert.deepEqual(result.redundant.map((change) => [change.target, change.current]), [[
    "operations.candidates.routes.empty_latent.recipe.steps",
    state(24),
  ]]);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.changes.map((change) => change.target), ["style_loras.watercolor.weight"]);
});

test("operation/input 固定矩阵且权重 target 不能凭空新增 style LoRA", () => {
  for (const [operation, input] of [
    ["candidates", "current_base"],
    ["render", "empty_latent"],
    ["render", "unsupported"],
  ]) {
    const target = `operations.${operation}.routes.${input}.workflow`;
    assert.throws(() => resolveRenderProfileOverride({
      resolvedProfile: semanticProfile(),
      overrideDocument: document([{
        target,
        original: { exists: false },
        project: state("invalid-page"),
      }]),
    }), (error) => {
      assert.equal(error.code, "invalid_render_profile_override");
      assert.ok(error.message.includes(`${operation}/${input}`) || error.message.includes(target));
      return true;
    });
  }

  assert.throws(() => resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([{
      target: "operations.render.routes.empty_latent.workflow",
      original: { exists: false },
      project: state("render-page"),
    }]),
  }), /target 不在允许列表中/);

  assert.throws(() => resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([{
      target: "legacy_targets.depth.defaults.strength",
      original: { exists: false },
      project: state(0.5),
    }]),
  }), /target 不在允许列表中/);

  assert.throws(() => resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([{
      target: "style_loras.ink.weight",
      original: { exists: false },
      project: state(0.5),
    }]),
  }), /不能新增不存在的 style LoRA/);
});

test("项目可以用完整语义 target 新增、替换和移除风格 LoRA", () => {
  const ink = { filename: "story-canvas/ink.safetensors", sha256: "c".repeat(64), weight: 0.85, trigger: "ink style" };
  const added = resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([{
      target: "style_loras.ink-style",
      original: { exists: false },
      project: state(ink),
    }]),
  });
  assert.equal(added.blocked, false);
  assert.deepEqual(added.effective_profile.style_loras["ink-style"], ink);

  const removed = resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([{
      target: "style_loras.watercolor",
      original: state(semanticProfile().style_loras.watercolor),
      project: { exists: false },
    }]),
  });
  assert.equal(removed.blocked, false);
  assert.equal(Object.hasOwn(removed.effective_profile.style_loras, "watercolor"), false);

  assert.throws(() => validateRenderProfileOverrideDocument(document([
    { target: "style_loras.watercolor", original: state(semanticProfile().style_loras.watercolor), project: state(ink) },
    { target: "style_loras.watercolor.weight", original: state(0.7), project: state(0.5) },
  ])), /target 重叠/);
});

test("拒绝 aggregate target、重复 target 和 original/value 旧格式", () => {
  for (const target of ["id", "architecture_family", "capabilities", "workflow", "recipes.candidate.steps", "legacy_targets.pose.strength", "operations.candidates.routes.empty_latent.recipe.strategy"]) {
    assert.throws(() => resolveRenderProfileOverride({
      resolvedProfile: semanticProfile(),
      overrideDocument: document([{ target, original: { exists: false }, project: state(1) }]),
    }), /target 不在允许列表中/);
  }

  assert.throws(() => resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([
      { target: "prompt.policy", original: state("illustrious-v1"), project: state("first") },
      { target: "prompt.policy", original: state("illustrious-v1"), project: state("second") },
    ]),
  }), /target 重复：prompt.policy/);

  assert.throws(() => resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([{
      target: "prompt.policy",
      original: state("illustrious-v1"),
      value: state("old-shape"),
    }]),
  }), /未知字段：value/);
});

test("每类语义 target 校验项目值类型、范围和删除合法性", () => {
  const cases = [
    ["operations.candidates.routes.empty_latent.workflow", state("anima-candidate-page"), state(42)],
    ["operations.candidates.routes.empty_latent.workflow", state("anima-candidate-page"), { exists: false }],
    ["prompt.policy", state("anima-v1"), state("Not Stable")],
    ["operations.candidates.routes.empty_latent.recipe.steps", state(24), state(-1)],
    ["operations.candidates.routes.empty_latent.recipe.cfg", state(6), state(0)],
    ["operations.candidates.routes.empty_latent.recipe.resolutions.2:3", state({ width: 1024, height: 1536 }), state({ width: 1025, height: 1536 })],
    ["style_loras.watercolor.weight", state(0.7), state(3)],
    ["style_loras.ink-style", { exists: false }, state({ filename: "../unsafe.safetensors", sha256: "c".repeat(64), weight: 0.8 })],
    ["models.dit", state(semanticProfile().models.dit), state({ filename: "bad.safetensors", relative_path: "diffusion_models/bad.safetensors", sha256: "bad" })],
    ["models.dit", state(semanticProfile().models.dit), { exists: false }],
    ["prompt.fragments.quality", state(semanticProfile().prompt.fragments.quality), state({ polarity: "positive", placement: "prefix", order: 100, prompt_type: "unknown", prompt_text: "bad" })],
  ];
  for (const [target, original, project] of cases) {
    assert.throws(() => resolveRenderProfileOverride({
      resolvedProfile: semanticProfile(),
      overrideDocument: document([{ target, original, project }]),
    }), /render_profile override 无效/);
  }

  assert.throws(() => resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: document([{
      target: "models.new-role",
      original: { exists: false },
      project: state({ filename: "new.safetensors", relative_path: "checkpoints/new.safetensors", sha256: "d".repeat(64) }),
    }]),
  }), /不能新增不存在的 model role/);

  const anima = semanticProfile();
  anima.models.text_encoder = { filename: "encoder.safetensors", relative_path: "text_encoders/encoder.safetensors", sha256: "e".repeat(64) };
  const replacedEncoder = { ...anima.models.text_encoder, filename: "project-encoder.safetensors", sha256: "f".repeat(64) };
  const encoderResult = resolveRenderProfileOverride({
    resolvedProfile: anima,
    overrideDocument: document([{
      target: "models.text_encoder",
      original: state(anima.models.text_encoder),
      project: state(replacedEncoder),
    }]),
  });
  assert.equal(encoderResult.effective_profile.models.text_encoder.filename, "project-encoder.safetensors");

  assert.throws(() => resolveRenderProfileOverride({
    resolvedProfile: semanticProfile(),
    overrideDocument: { $schema: 1, version: 1, profiles: {} },
  }), /\$schema 必须是字符串/);
});

test("不存在当前 profile 组时其他组不参与解析", () => {
  const base = semanticProfile();
  const result = resolveRenderProfileOverride({
    resolvedProfile: base,
    overrideDocument: document([{ old: "inactive legacy shape" }], "another-profile"),
  });

  assert.equal(result.configured, false);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.effective_profile, base);
  assert.notEqual(result.effective_profile, base);
});

test("基础删除既有 route 或 model 身份后统一形成 current 不存在的三方冲突", () => {
  const originalDit = semanticProfile().models.dit;
  const projectDit = {
    filename: "project.safetensors",
    relative_path: "diffusion_models/project.safetensors",
    sha256: "d".repeat(64),
  };
  const cases = [
    {
      target: "models.dit",
      original: state(originalDit),
      project: state(projectDit),
      removeIdentity(profile) {
        delete profile.models.dit;
      },
    },
  ];

  for (const fixture of cases) {
    const base = semanticProfile();
    fixture.removeIdentity(base);
    const result = resolveRenderProfileOverride({
      resolvedProfile: base,
      overrideDocument: document([{
        target: fixture.target,
        original: fixture.original,
        project: fixture.project,
      }]),
    });

    assert.equal(result.blocked, true, fixture.target);
    assert.deepEqual(result.changes, [], fixture.target);
    assert.deepEqual(result.redundant, [], fixture.target);
    assert.deepEqual(result.conflicts, [{
      target: fixture.target,
      original: fixture.original,
      current: { exists: false },
      project: fixture.project,
    }], fixture.target);
    assert.equal(result.effective_profile, null, fixture.target);
  }
});

test("Schema 与运行时 target grammar 对所有语义族保持一致", async () => {
  const schema = JSON.parse(await readFile(path.join(repositoryRoot, "library", "schemas", "render-profile-override.schema.json"), "utf8"));
  const targetRules = schema.$defs.change.properties.target.anyOf;
  const schemaAccepts = (target) => targetRules.some((rule) => rule.const === target || (rule.pattern && new RegExp(rule.pattern).test(target)));
  const routeSuffixes = [
    "workflow", "recipe.steps", "recipe.cfg", "recipe.sampler", "recipe.scheduler", "recipe.clip_skip",
    "recipe.scale", "recipe.denoise", "recipe.second_pass_steps", "recipe.second_pass_cfg",
    "recipe.second_pass_sampler", "recipe.second_pass_scheduler", "recipe.resolutions.2:3",
    "recipe.resolutions.3:4", "recipe.resolutions.9:16", "recipe.resolutions.4:3",
  ];
  const validTargets = [
    "models.dit", "models.text_encoder", "prompt.policy", "prompt.fragments.quality-masterpiece",
    "style_loras.ink-style", "style_loras.ink-style.weight",
    ...[["candidates", "empty_latent"]]
      .flatMap(([operation, input]) => routeSuffixes.map((suffix) => `operations.${operation}.routes.${input}.${suffix}`)),
  ];
  const invalidTargets = [
    "workflow", "recipes.candidate.steps", "models.Checkpoint", "prompt.fragments.quality_masterpiece",
    "legacy_targets.pose.workflow", "legacy_targets.normal.defaults.strength", "operations.candidates.routes.current_base.workflow",
    "operations.candidates.routes.empty_latent.recipe.strategy",
    "operations.render.routes.empty_latent.recipe.strategy",
    "operations.render.routes.empty_latent.recipe.resolutions.1:1",
  ];

  for (const [target, expected] of [...validTargets.map((value) => [value, true]), ...invalidTargets.map((value) => [value, false])]) {
    let runtimeAccepted = true;
    try {
      validateRenderProfileOverrideDocument({
        version: 1,
        profiles: { "studio-base-v1": { changes: [{ target, original: { exists: false }, project: { exists: false } }] } },
      });
    } catch {
      runtimeAccepted = false;
    }
    assert.equal(schemaAccepts(target), expected, `Schema target grammar 漂移：${target}`);
    assert.equal(runtimeAccepted, expected, `运行时 target grammar 漂移：${target}`);
  }
});
