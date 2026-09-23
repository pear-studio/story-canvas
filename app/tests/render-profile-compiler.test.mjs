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
    cp(path.join(repositoryRoot, "library", "render-recipes"), path.join(library, "render-recipes"), { recursive: true }),
    cp(path.join(repositoryRoot, "library", "workflows"), path.join(library, "workflows"), { recursive: true }),
    cp(path.join(repositoryRoot, "library", "render-profiles", `${profileId}.json`), path.join(library, "render-profiles", `${profileId}.json`)),
  ]);
  await mutate(root);
  return root;
}

test("Qwen profile 解析稳定模型角色、全局文字、候选 recipe 和 workflow 双哈希", async () => {
  const compiled = await readResolvedRenderProfile(repositoryRoot, "qwen-image-2-1");
  const resolved = compiled.resolved_profile;

  assert.deepEqual(Object.keys(resolved.models), ["dit", "text_encoder", "vae"]);
  assert.equal(resolved.architecture_family, "qwen-image-2-1");
  assert.equal(resolved.prompt.text, "");
  assert.equal(Object.hasOwn(resolved.prompt, "policy"), false);
  assert.equal(Object.hasOwn(resolved.prompt, "fragments"), false);
  assert.equal(resolved.operations.candidates.routes.empty_latent.recipe.steps, 25);
  assert.equal(resolved.operations.candidates.routes.empty_latent.recipe.sampler, "euler");
  assert.equal(resolved.operations.candidates.routes.empty_latent.recipe.scheduler, "simple");
  assert.deepEqual(resolved.operations.candidates.routes.empty_latent, {
    workflow: "qwen-image-2-1-text",
    recipe_source_id: "qwen-image-2-1-candidate",
    recipe: resolved.operations.candidates.routes.empty_latent.recipe,
  });
  assert.deepEqual(resolved.operations.candidates.routes.reference_image, {
    workflow: "qwen-image-2-1-reference",
    recipe_source_id: "qwen-image-2-1-candidate",
    recipe: resolved.operations.candidates.routes.reference_image.recipe,
  });
  assert.deepEqual(Object.keys(resolved.operations), ["candidates"]);
  assert.equal(Object.hasOwn(resolved, "workflows"), false);
  assert.equal(Object.hasOwn(resolved, "provenance"), false);
  assert.equal(Object.hasOwn(resolved, "canonical_sha256"), false);
  assert.deepEqual(Object.keys(compiled.workflow_definitions).sort(), ["qwen-image-2-1-reference", "qwen-image-2-1-text"]);
  for (const id of ["qwen-image-2-1-text", "qwen-image-2-1-reference"]) {
    assert.match(compiled.workflow_definitions[id].template_sha256, /^[0-9a-f]{64}$/);
    assert.match(compiled.workflow_definitions[id].manifest_sha256, /^[0-9a-f]{64}$/);
    assert.equal(compiled.source_identity.workflows[id].template.sha256, compiled.workflow_definitions[id].template_sha256);
  }
  assert.match(compiled.source_identity.profile.sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(compiled.source_identity, "prompt_policy"), false);
  assert.equal(Object.hasOwn(compiled.source_identity, "prompt_fragments"), false);
  assert.deepEqual(Object.keys(compiled.source_identity.recipes).sort(), ["qwen-image-2-1-candidate"]);
  assert.equal(compiled.resolved_profile_sha256, hashCanonicalJson(resolved));
});

test("缺失引用、workflow 不兼容和多余拓扑参数都在解析时拒绝", async () => {
  const missingReference = await fixture("qwen-image-2-1", async (root) => {
    const file = path.join(root, "library", "render-profiles", "qwen-image-2-1.json");
    const profile = await json(file);
    profile.operations.candidates.routes.empty_latent.recipe = "missing-recipe";
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(missingReference, "qwen-image-2-1"), /render recipe 引用不存在：missing-recipe/);

  const incompatibleWorkflow = await fixture("qwen-image-2-1", async (root) => {
    const file = path.join(root, "library", "render-profiles", "qwen-image-2-1.json");
    const profile = await json(file);
    profile.operations.candidates.routes.empty_latent.workflow = "missing-workflow";
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(incompatibleWorkflow, "qwen-image-2-1"), /workflow missing-workflow 无法读取或校验/);

  const unusedTopologyParameter = await fixture("qwen-image-2-1", async (root) => {
    const file = path.join(root, "library", "render-recipes", "qwen-image-2-1-candidate.json");
    const recipe = await json(file);
    recipe.scale = 2;
    await writeJson(file, recipe);
  });
  await assert.rejects(() => readResolvedRenderProfile(unusedTopologyParameter, "qwen-image-2-1"), /不消费的参数：scale/);

  const invalidSchemaField = await fixture("qwen-image-2-1", async (root) => {
    const file = path.join(root, "library", "render-profiles", "qwen-image-2-1.json");
    const profile = await json(file);
    profile.$schema = 42;
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(invalidSchemaField, "qwen-image-2-1"), /\$schema 必须是字符串/);

  const legacyPrompt = await fixture("qwen-image-2-1", async (root) => {
    const file = path.join(root, "library", "render-profiles", "qwen-image-2-1.json");
    const profile = await json(file);
    profile.prompt = { policy: "qwen-image-2-1", fragments: {} };
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(legacyPrompt, "qwen-image-2-1"), /未知字段|prompt\.text 必须是字符串/);
});

test("生成配置只接受 Qwen 结构家族并拒绝旧家族", async () => {
  const root = await fixture("qwen-image-2-1", async (fixtureRoot) => {
    const file = path.join(fixtureRoot, "library", "render-profiles", "qwen-image-2-1.json");
    const profile = await json(file);
    profile.architecture_family = "anima";
    await writeJson(file, profile);
  });
  await assert.rejects(() => readResolvedRenderProfile(root, "qwen-image-2-1"), /architecture_family 无效/);
});
