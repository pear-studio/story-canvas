import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { readResolvedRenderProfile } from "../server/render-profile-compiler.mjs";
import { hashCanonicalJson } from "../server/workflow-definition.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryRoots = [];

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function json(pathname) {
  return JSON.parse(await readFile(pathname, "utf8"));
}

async function writeJson(pathname, value) {
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(profileId, mutate) {
  const root = await mkdtemp(path.join(tmpdir(), "story-render-profile-"));
  temporaryRoots.push(root);
  const library = path.join(root, "library");
  await mkdir(path.join(library, "render-profiles"), { recursive: true });
  await Promise.all([
    cp(path.join(repositoryRoot, "library", "prompt-policies"), path.join(library, "prompt-policies"), { recursive: true }),
    cp(path.join(repositoryRoot, "library", "render-recipes"), path.join(library, "render-recipes"), { recursive: true }),
    cp(path.join(repositoryRoot, "library", "workflows"), path.join(library, "workflows"), { recursive: true }),
    cp(path.join(repositoryRoot, "library", "render-profiles", `${profileId}.json`), path.join(library, "render-profiles", `${profileId}.json`)),
  ]);
  await mutate(root);
  return root;
}

test("Anima profile 解析稳定模型角色、候选 recipe 和 workflow 双哈希", async () => {
  const compiled = await readResolvedRenderProfile(repositoryRoot, "anima-base-v1");
  const resolved = compiled.resolved_profile;

  assert.deepEqual(Object.keys(resolved.models), ["dit", "text_encoder", "vae"]);
  assert.equal(resolved.prompt.policy, "anima-v1");
  assert.equal(resolved.prompt.fragments["quality-best"].prompt_text, "best quality");
  assert.equal(resolved.prompt.fragments["quality-score-7"].prompt_text, "score_7");
  assert.equal(resolved.operations.candidates.routes.empty_latent.recipe.steps, 32);
  assert.equal(resolved.operations.candidates.routes.empty_latent.recipe.sampler, "er_sde");
  assert.equal(resolved.operations.candidates.routes.empty_latent.recipe.scheduler, "beta");
  assert.deepEqual(resolved.operations.candidates.routes.empty_latent, {
    workflow: "anima-candidate-page",
    recipe_source_id: "anima-base-v1-candidate",
    recipe: resolved.operations.candidates.routes.empty_latent.recipe,
  });
  assert.deepEqual(Object.keys(resolved.operations), ["candidates"]);
  assert.equal(Object.hasOwn(resolved, "workflows"), false);
  assert.equal(Object.hasOwn(resolved, "provenance"), false);
  assert.equal(Object.hasOwn(resolved, "canonical_sha256"), false);
  assert.deepEqual(Object.keys(compiled.workflow_definitions), ["anima-candidate-page"]);
  assert.match(compiled.workflow_definitions["anima-candidate-page"].template_sha256, /^[0-9a-f]{64}$/);
  assert.match(compiled.workflow_definitions["anima-candidate-page"].manifest_sha256, /^[0-9a-f]{64}$/);
  assert.equal(compiled.source_identity.workflows["anima-candidate-page"].template.sha256, compiled.workflow_definitions["anima-candidate-page"].template_sha256);
  assert.match(compiled.source_identity.profile.sha256, /^[0-9a-f]{64}$/);
  assert.match(compiled.source_identity.prompt_policy.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(compiled.source_identity.recipes).sort(), ["anima-base-v1-candidate"]);
  assert.equal(compiled.resolved_profile_sha256, hashCanonicalJson(resolved));
});

test("Anima Aesthetic 解析合并 policy/profile 片段并物化候选 route", async () => {
  const compiled = await readResolvedRenderProfile(repositoryRoot, "anima-aesthetic-v1-1");
  const resolved = compiled.resolved_profile;

  assert.equal(resolved.prompt.fragments["quality-masterpiece"].prompt_text, "masterpiece");
  assert.equal(Object.hasOwn(resolved.prompt.fragments, "quality-score-7"), false);
  assert.deepEqual(compiled.source_identity.prompt_fragments["quality-masterpiece"], { source_kind: "render_profile", source_id: "anima-aesthetic-v1-1" });
  assert.deepEqual(compiled.source_identity.prompt_fragments["avoid-text"], { source_kind: "render_profile", source_id: "anima-aesthetic-v1-1" });

  const routes = Object.entries(resolved.operations).flatMap(([operation, value]) => Object.entries(value.routes).map(([input, route]) => [operation, input, route.workflow, route.recipe_source_id]));
  assert.deepEqual(routes, [
    ["candidates", "empty_latent", "anima-candidate-page", "anima-aesthetic-v1-1-candidate"],
  ]);
  assert.deepEqual(Object.keys(compiled.source_identity.recipes).sort(), ["anima-aesthetic-v1-1-candidate"]);
  assert.equal(compiled.resolved_profile_sha256, hashCanonicalJson(resolved));
});

test("Prompt 同 order 由稳定 ID 排序而不误报冲突", async () => {
  const root = await fixture("anima-aesthetic-v1-1", async (fixtureRoot) => {
    const file = path.join(fixtureRoot, "library", "render-profiles", "anima-aesthetic-v1-1.json");
    const profile = await json(file);
    profile.prompt.fragments["quality-test-a"] = { polarity: "positive", placement: "prefix", order: 100, prompt_type: "custom_description", prompt_text: "test a" };
    profile.prompt.fragments["quality-test-b"] = { polarity: "positive", placement: "prefix", order: 100, prompt_type: "custom_description", prompt_text: "test b" };
    await writeJson(file, profile);
  });
  const compiled = await readResolvedRenderProfile(root, "anima-aesthetic-v1-1");
  assert.deepEqual(Object.keys(compiled.resolved_profile.prompt.fragments).slice(0, 3), [
    "quality-masterpiece",
    "quality-test-a",
    "quality-test-b",
  ]);
});

test("缺失引用、Prompt ID 冲突、workflow 不兼容和残缺二遍参数都在解析时拒绝", async () => {
  const missingReference = await fixture("anima-base-v1", async (root) => {
    const file = path.join(root, "library", "render-profiles", "anima-base-v1.json");
    const profile = await json(file);
    profile.operations.candidates.routes.empty_latent.recipe = "missing-recipe";
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(missingReference, "anima-base-v1"), /render recipe 引用不存在：missing-recipe/);

  const fragmentConflict = await fixture("anima-base-v1", async (root) => {
    const file = path.join(root, "library", "render-profiles", "anima-base-v1.json");
    const profile = await json(file);
    profile.prompt.fragments["quality-masterpiece"] = { polarity: "positive", placement: "prefix", order: 190, prompt_type: "custom_description", prompt_text: "project masterpiece" };
    await writeJson(file, profile);
    const policyFile = path.join(root, "library", "prompt-policies", "anima-v1.json");
    const policy = await json(policyFile);
    policy.fragments["quality-masterpiece"] = { polarity: "positive", placement: "prefix", order: 100, prompt_type: "custom_description", prompt_text: "policy masterpiece" };
    await writeJson(policyFile, policy);
  });
  await assert.rejects(() => readResolvedRenderProfile(fragmentConflict, "anima-base-v1"), /Prompt 片段 ID 冲突：quality-masterpiece/);

  const incompatibleWorkflow = await fixture("anima-base-v1", async (root) => {
    const file = path.join(root, "library", "render-profiles", "anima-base-v1.json");
    const profile = await json(file);
    profile.operations.candidates.routes.empty_latent.workflow = "missing-workflow";
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(incompatibleWorkflow, "anima-base-v1"), /workflow missing-workflow 无法读取或校验/);

  const unusedTopologyParameter = await fixture("anima-base-v1", async (root) => {
    const file = path.join(root, "library", "render-recipes", "anima-base-v1-candidate.json");
    const recipe = await json(file);
    recipe.scale = 2;
    await writeJson(file, recipe);
  });
  await assert.rejects(() => readResolvedRenderProfile(unusedTopologyParameter, "anima-base-v1"), /anima-candidate-page 不消费的参数：scale/);

  const invalidSchemaField = await fixture("anima-base-v1", async (root) => {
    const file = path.join(root, "library", "render-profiles", "anima-base-v1.json");
    const profile = await json(file);
    profile.$schema = 42;
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(invalidSchemaField, "anima-base-v1"), /\$schema 必须是字符串/);
});

test("生成配置只接受 Anima 三模型角色并拒绝 SDXL 遗留形状", async () => {
  const root = await fixture("anima-base-v1", async (fixtureRoot) => {
    const file = path.join(fixtureRoot, "library", "render-profiles", "anima-base-v1.json");
    const profile = await json(file);
    profile.architecture_family = "sdxl";
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(root, "anima-base-v1"), /architecture_family 无效/);
});
