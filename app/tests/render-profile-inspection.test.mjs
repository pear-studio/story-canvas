import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileEffectiveRenderProfile, readResolvedRenderProfile } from "../server/render-profile-compiler.mjs";
import { diagnoseRenderProfile } from "../server/render-profile-diagnostics.mjs";
import { inspectRenderProfile } from "../server/render-profile-inspection.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const profileId = "qwen-image-2-1";
const stepsTarget = "operations.candidates.routes.empty_latent.recipe.steps";

function state(value) {
  return { exists: true, value };
}

async function effectiveBundle(context, change) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "story-canvas-inspection-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, "render-profile.override.json"), `${JSON.stringify({
    version: 1,
    profiles: { [profileId]: { changes: [change] } },
  }, null, 2)}\n`);
  return compileEffectiveRenderProfile({ repositoryRoot, projectRoot, profileId });
}

function availableDiagnosis(profile) {
  return {
    available: true,
    errors: [],
    models: Object.fromEntries(Object.entries(profile.models).map(([id, model]) => [id, {
      id,
      kind: id,
      ...model,
      status: "available",
      reason: null,
      actual_sha256: model.sha256,
    }])),
    style_loras: Object.fromEntries(Object.entries(profile.style_loras).map(([id, lora]) => [id, {
      id,
      ...lora,
      status: "available",
      reason: null,
      actual_sha256: lora.sha256,
    }])),
  };
}

test("Qwen inspection 展示已解析候选资产、全局文字与真实 route", async () => {
  const bundle = await readResolvedRenderProfile(repositoryRoot, "qwen-image-2-1");
  const inspected = inspectRenderProfile({ bundle, diagnosis: availableDiagnosis(bundle.resolved_profile) });

  assert.deepEqual(inspected.current_contract, {
    profile_format: "asset_resolved",
    base_profile_compiled: true,
    project_override_supported: true,
    request_effective_render_plan_compiled: false,
  });
  assert.equal(inspected.base_profile.architecture_family, "qwen-image-2-1");
  assert.equal(inspected.base_profile.sha256, bundle.resolved_profile_sha256);
  assert.equal(inspected.project_override.status, "none");
  assert.equal(inspected.project_override.effective_sha256, bundle.resolved_profile_sha256);
  assert.equal(inspected.prompt.text, "根据以下设定和画面描述创作一幅新画面，动作、表情、视角与构图以画面描述为准。");
  assert.deepEqual(inspected.routes.map((route) => [route.operation, route.input_source, route.recipe.source_id, route.workflow.id]), [
    ["candidates", "empty_latent", "qwen-image-2-1-candidate", "qwen-image-2-1-text"],
    ["candidates", "reference_image", "qwen-image-2-1-candidate", "qwen-image-2-1-reference"],
  ]);
  assert.ok(inspected.routes.every((route) => route.available));
  assert.deepEqual(Object.keys(inspected.models), ["dit", "text_encoder", "vae"]);
});

test("缺少候选 workflow registry 身份会阻止候选 route", async () => {
  const bundle = await readResolvedRenderProfile(repositoryRoot, "qwen-image-2-1");
  const partialBundle = structuredClone(bundle);
  delete partialBundle.workflow_definitions["qwen-image-2-1-text"];
  delete partialBundle.source_identity.workflows["qwen-image-2-1-text"];
  const inspected = inspectRenderProfile({ bundle: partialBundle, diagnosis: availableDiagnosis(bundle.resolved_profile) });
  const candidate = inspected.routes.find((route) => route.operation === "candidates" && route.input_source === "empty_latent");

  assert.equal(inspected.base_profile.available, true);
  assert.equal(candidate.available, false);
  assert.deepEqual(candidate.diagnostics.map((issue) => issue.code), ["workflow_definition_missing", "workflow_identity_missing"]);
  assert.equal(inspected.routes.filter((route) => route.available).length, 1);
});

test("基础模型不可用是全局 blocker，所有 route 保留身份并统一阻止", async () => {
  const bundle = await readResolvedRenderProfile(repositoryRoot, "qwen-image-2-1");
  const diagnosis = availableDiagnosis(bundle.resolved_profile);
  diagnosis.available = false;
  diagnosis.models.dit = { ...diagnosis.models.dit, status: "hash_mismatch", reason: "sha256_mismatch", actual_sha256: "0".repeat(64) };
  const inspected = inspectRenderProfile({ bundle, diagnosis });

  assert.equal(inspected.base_profile.available, false);
  assert.deepEqual(inspected.base_profile.diagnostics.map((issue) => issue.code), ["profile_dependencies_unavailable"]);
  assert.ok(inspected.routes.every((route) => !route.available));
  assert.ok(inspected.routes.every((route) => route.diagnostics.some((issue) => issue.code === "profile_unavailable")));
  assert.equal(inspected.models.dit.status, "hash_mismatch");
});

test("applied override 展示三方值与文件身份，并从 effective profile 投影实际配方", async (context) => {
  const bundle = await effectiveBundle(context, {
    target: stepsTarget,
    original: state(25),
    project: state(30),
  });
  const baseDiagnosis = availableDiagnosis(bundle.base_bundle.resolved_profile);
  baseDiagnosis.available = false;
  const inspected = inspectRenderProfile({
    bundle,
    diagnosis: availableDiagnosis(bundle.effective_profile),
    baseDiagnosis,
  });

  assert.equal(inspected.project_override.status, "applied");
  assert.equal(inspected.project_override.blocked, false);
  assert.equal(inspected.project_override.source_file, "render-profile.override.json");
  assert.match(inspected.project_override.source_sha256, /^[0-9a-f]{64}$/);
  assert.equal(inspected.project_override.effective_sha256, bundle.effective_profile_sha256);
  assert.equal(inspected.base_profile.available, false);
  assert.deepEqual(inspected.project_override.changes, [{
    target: stepsTarget,
    label: "candidates / empty_latent · recipe.steps",
    original: state(25),
    current: state(25),
    project: state(30),
  }]);
  const candidateRoute = inspected.routes.find((route) => route.operation === "candidates" && route.input_source === "empty_latent");
  assert.equal(candidateRoute.recipe.source_id, "qwen-image-2-1-candidate");
  assert.equal(candidateRoute.recipe.parameters.steps, 30);
  assert.equal(candidateRoute.available, true);
});

test("override 冲突阻断 effective，但仍用基础配置展示关系供排查", async (context) => {
  const bundle = await effectiveBundle(context, {
    target: stepsTarget,
    original: state(20),
    project: state(30),
  });
  const base = bundle.base_bundle;
  const inspected = inspectRenderProfile({ bundle, diagnosis: availableDiagnosis(base.resolved_profile) });

  assert.equal(bundle.blocked, true);
  assert.equal(inspected.project_override.status, "conflict");
  assert.equal(inspected.project_override.blocked, true);
  assert.equal(inspected.project_override.effective_sha256, null);
  assert.deepEqual(inspected.project_override.conflicts[0], {
    target: stepsTarget,
    label: "candidates / empty_latent · recipe.steps",
    original: state(20),
    current: state(25),
    project: state(30),
  });
  assert.equal(inspected.base_profile.sha256, base.resolved_profile_sha256);
  const candidateRoute = inspected.routes.find((route) => route.operation === "candidates" && route.input_source === "empty_latent");
  assert.equal(candidateRoute.recipe.parameters.steps, 25);
  assert.ok(inspected.routes.every((route) => route.available));
});

test("旧 aggregate profile 不能进入诊断或 inspection", async () => {
  const aggregate = { id: "legacy", models: [], loras: [], legacy_targets: {}, capabilities: {} };
  await assert.rejects(
    diagnoseRenderProfile(aggregate, repositoryRoot, {}),
    /只接受 compiler resolved_profile/,
  );
  assert.throws(
    () => inspectRenderProfile({ bundle: aggregate, diagnosis: { available: true } }),
    /只接受 compiler bundle/,
  );
});
