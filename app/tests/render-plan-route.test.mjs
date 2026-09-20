import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readResolvedRenderProfile } from "../server/render-profile-compiler.mjs";
import {
  freezeRenderPlanRegistries,
  freezeRenderRoutes,
  resolveRenderUnitPlan,
} from "../server/render-plan-route.mjs";
import { hashCanonicalJson } from "../server/workflow-definition.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function compiledProfile(id = "anima-base-v1") {
  return readResolvedRenderProfile(repositoryRoot, id);
}

function freezeRegistries(items, compiled, purpose = "candidate") {
  return freezeRenderPlanRegistries(items, {
    purpose,
    resolvedProfile: compiled.resolved_profile,
    workflowDefinitions: compiled.workflow_definitions,
  });
}

function expectedRoute(profile, operation, inputSource) {
  const route = profile.operations[operation].routes[inputSource];
  return {
    operation,
    input_source: inputSource,
    workflow_id: route.workflow,
    recipe_source_id: route.recipe_source_id,
    recipe_instance_id: `${route.recipe_source_id}@${hashCanonicalJson(route.recipe)}`,
  };
}

test("候选 route 只由 operation 和已解析 Anima profile 决定", async () => {
  const compiled = await compiledProfile();
  const profile = compiled.resolved_profile;
  const items = freezeRenderRoutes([
    { id: "ordinary" },
    { id: "ordinary-variant" },
  ], { purpose: "candidate", resolvedProfile: profile });

  assert.deepEqual(items.map((item) => item.render_route), [
    expectedRoute(profile, "candidates", "empty_latent"),
    expectedRoute(profile, "candidates", "empty_latent"),
  ]);
});

test("缺失 route 在任务创建前明确阻断", async () => {
  const profile = (await compiledProfile()).resolved_profile;
  assert.throws(() => freezeRenderRoutes([{ id: "unknown" }], {
    purpose: "unknown", resolvedProfile: profile,
  }), /渲染 purpose 无法映射到 operation/);
});

test("任务按 source ID 与有效参数 hash 冻结唯一 recipe instance", async () => {
  const compiled = await compiledProfile();
  const profile = compiled.resolved_profile;
  const items = freezeRenderRoutes([{ id: "ordinary" }, { id: "ordinary-variant" }], {
    purpose: "candidate", resolvedProfile: profile,
  });
  const snapshot = freezeRegistries(items, compiled);

  assert.deepEqual(Object.keys(snapshot.workflows), ["anima-candidate-page"]);
  const sharedInstanceId = items[0].render_route.recipe_instance_id;
  assert.deepEqual(Object.keys(snapshot.recipes), [sharedInstanceId]);
  assert.deepEqual(snapshot.recipes[sharedInstanceId], {
    source_id: "anima-base-v1-candidate",
    canonical_sha256: hashCanonicalJson(profile.operations.candidates.routes.empty_latent.recipe),
    parameters: profile.operations.candidates.routes.empty_latent.recipe,
  });
  assert.equal(Object.hasOwn(snapshot, "base_workflow_id"), false);
  assert.equal(Object.hasOwn(snapshot, "recipe"), false);
});

test("普通候选从 route 解析 workflow 与 recipe", async () => {
  const compiled = await compiledProfile();
  const profile = compiled.resolved_profile;
  const [item] = freezeRenderRoutes([{ id: "ordinary" }], {
    purpose: "candidate", resolvedProfile: profile,
  });
  const snapshot = freezeRegistries([item], compiled);
  const plan = resolveRenderUnitPlan([item], {
    purpose: "candidate", snapshot, resolvedProfile: profile,
  });

  assert.equal(plan.definition.id, "anima-candidate-page");
  assert.equal(plan.route.recipe_source_id, "anima-base-v1-candidate");
  assert.equal(plan.route.recipe_instance_id, `anima-base-v1-candidate@${hashCanonicalJson(plan.recipe)}`);
  assert.deepEqual(plan.recipe, profile.operations.candidates.routes.empty_latent.recipe);
});

test("恢复按 route、双 registry 身份和 manifest modifier 解析完整执行计划", async () => {
  const compiled = await compiledProfile();
  const profile = compiled.resolved_profile;
  const [ordinary] = freezeRenderRoutes([{ id: "ordinary" }], {
    purpose: "candidate", resolvedProfile: profile,
  });
  const snapshot = freezeRegistries([ordinary], compiled);
  const plan = resolveRenderUnitPlan([ordinary], {
    purpose: "candidate", snapshot, resolvedProfile: profile,
  });

  assert.deepEqual(plan.route, ordinary.render_route);
  assert.equal(plan.definition.id, "anima-candidate-page");
  assert.deepEqual(plan.recipe, profile.operations.candidates.routes.empty_latent.recipe);
});

test("旧 route、旧 snapshot、route 篡改和 recipe registry 篡改统一要求拒绝", async () => {
  const compiled = await compiledProfile();
  const profile = compiled.resolved_profile;
  const [item] = freezeRenderRoutes([{ id: "ordinary" }], { purpose: "candidate", resolvedProfile: profile });
  const snapshot = freezeRegistries([item], compiled);

  const oldRoute = structuredClone(item);
  delete oldRoute.render_route.recipe_instance_id;
  assert.throws(() => resolveRenderUnitPlan([oldRoute], {
    purpose: "candidate", snapshot, resolvedProfile: profile,
  }), /缺少 recipe_instance_id，请重新创建任务/);
  assert.throws(() => resolveRenderUnitPlan([item], {
    purpose: "candidate", snapshot: { ...snapshot, base_workflow_id: "anima-candidate-page" }, resolvedProfile: profile,
  }), /旧工作流或全局 recipe 字段，请重新创建任务/);

  const tamperedRoute = structuredClone(item);
  tamperedRoute.render_route.workflow_id = "different-workflow";
  assert.throws(() => resolveRenderUnitPlan([tamperedRoute], {
    purpose: "candidate", snapshot, resolvedProfile: profile,
  }), /render_route 与条目输入或 render profile 不一致：workflow_id/);

  const missing = structuredClone(snapshot);
  delete missing.recipes[item.render_route.recipe_instance_id];
  assert.throws(() => resolveRenderUnitPlan([item], {
    purpose: "candidate", snapshot: missing, resolvedProfile: profile,
  }), /recipe .*不在任务 registry/);

  const missingWorkflow = structuredClone(snapshot);
  delete missingWorkflow.workflows[item.render_route.workflow_id];
  assert.throws(() => resolveRenderUnitPlan([item], {
    purpose: "candidate", snapshot: missingWorkflow, resolvedProfile: profile,
  }), /工作流 .*不在任务 registry/);

  const tamperedWorkflow = structuredClone(snapshot);
  tamperedWorkflow.workflows[item.render_route.workflow_id].template["7"].inputs.steps += 1;
  assert.throws(() => resolveRenderUnitPlan([item], {
    purpose: "candidate", snapshot: tamperedWorkflow, resolvedProfile: profile,
  }), /工作流定义快照校验失败/);

  const tamperedHash = structuredClone(snapshot);
  tamperedHash.recipes[item.render_route.recipe_instance_id].canonical_sha256 = "b".repeat(64);
  assert.throws(() => resolveRenderUnitPlan([item], {
    purpose: "candidate", snapshot: tamperedHash, resolvedProfile: profile,
  }), /recipe .*快照校验失败/);

  const tamperedParameters = structuredClone(snapshot);
  tamperedParameters.recipes[item.render_route.recipe_instance_id].parameters.steps += 1;
  assert.throws(() => resolveRenderUnitPlan([item], {
    purpose: "candidate", snapshot: tamperedParameters, resolvedProfile: profile,
  }), /recipe .*快照校验失败/);
});

test("同一 batch 的五字段 route 必须完全一致", async () => {
  const compiled = await compiledProfile();
  const profile = compiled.resolved_profile;
  const items = freezeRenderRoutes([{ id: "ordinary" }, { id: "ordinary-variant" }], {
    purpose: "candidate", resolvedProfile: profile,
  });
  const altered = structuredClone(items[1]);
  altered.render_route.recipe_instance_id = `${altered.render_route.recipe_source_id}@${"b".repeat(64)}`;
  assert.throws(() => resolveRenderUnitPlan([items[0], altered], {
    purpose: "candidate",
    snapshot: freezeRegistries(items, compiled),
    resolvedProfile: profile,
  }), /render_route 与条目输入或 render profile 不一致：recipe_instance_id/);
});
