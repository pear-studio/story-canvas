import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { diagnoseRenderProfile } from "../server/render-profile-diagnostics.mjs";

// 缓存文件路径通过环境变量隔离，避免测试写入仓库真实的 runtime/state。
const cacheDir = await mkdtemp(path.join(tmpdir(), "story-canvas-hash-cache-"));
process.env.STORYVISUALIZER_HASH_CACHE_FILE = path.join(cacheDir, "model-hash-cache.json");

function resolvedProfile(content) {
  return {
    id: "hash-test",
    name: "哈希测试",
    architecture_family: "anima",
    models: {
      dit: {
        filename: "model.safetensors",
        relative_path: "diffusion_models/model.safetensors",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
      text_encoder: {
        filename: "model.safetensors",
        relative_path: "diffusion_models/model.safetensors",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
      vae: {
        filename: "model.safetensors",
        relative_path: "diffusion_models/model.safetensors",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    },
    prompt: { family: "anima" },
    operations: {
      candidates: {
        routes: {
          empty_latent: { workflow: "anima-candidate-page", recipe_source_id: "hash-test-candidate" },
        },
      },
    },
    style_loras: {},
  };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-model-hash-"));
  context.after(() => rm(root, { recursive: true }));
  await mkdir(path.join(root, "models", "diffusion_models"), { recursive: true });
  const content = Buffer.from("deterministic checkpoint fixture");
  const modelFile = path.join(root, "models", "diffusion_models", "model.safetensors");
  await writeFile(modelFile, content);
  registerFixtureProjects(root); return { root, modelFile, content, profile: resolvedProfile(content) };
}

async function readCache() {
  return JSON.parse(await readFile(process.env.STORYVISUALIZER_HASH_CACHE_FILE, "utf8"));
}

test("并发诊断等待持久哈希缓存加载完成", async (context) => {
  const { root, modelFile, profile } = await fixture(context);
  const info = await stat(modelFile);
  await writeFile(process.env.STORYVISUALIZER_HASH_CACHE_FILE, JSON.stringify({
    version: 1,
    entries: {
      [modelFile]: {
        size: info.size,
        mtime_ms: Math.round(info.mtimeMs),
        ctime_ms: Math.round(info.ctimeMs),
        sha256: "0".repeat(64),
      },
    },
  }), "utf8");

  const diagnoses = await Promise.all([
    diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" }),
    diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" }),
  ]);
  for (const diagnosis of diagnoses) {
    assert.equal(diagnosis.available, false);
    assert.equal(diagnosis.models.dit.status, "hash_mismatch");
    assert.equal(diagnosis.models.dit.actual_sha256, "0".repeat(64));
  }
});

test("并发首次诊断共享哈希缓存加载与计算，后续诊断命中持久缓存", async (context) => {
  const { root, modelFile, content, profile } = await fixture(context);

  const [first, concurrent] = await Promise.all([
    diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" }),
    diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" }),
  ]);
  assert.equal(first.available, true);
  assert.equal(concurrent.available, true);
  assert.equal(concurrent.models.dit.actual_sha256, first.models.dit.actual_sha256);
  assert.deepEqual(first.route_capabilities.routes, [{
    operation: "candidates",
    input_source: "empty_latent",
    workflow_id: "anima-candidate-page",
    recipe_source_id: "hash-test-candidate",
  }]);
  const cached = await readCache();
  const entry = cached.entries[modelFile];
  assert.ok(entry, "缓存应包含模型文件条目");
  assert.equal(entry.sha256, profile.models.dit.sha256);
  assert.equal(entry.size, content.length);
  assert.ok(Number.isInteger(entry.mtime_ms));

  const cacheMtime = (await stat(process.env.STORYVISUALIZER_HASH_CACHE_FILE)).mtimeMs;
  const second = await diagnoseRenderProfile(profile, root, { models_root: "models" });
  assert.equal(second.available, true);
  assert.equal((await stat(process.env.STORYVISUALIZER_HASH_CACHE_FILE)).mtimeMs, cacheMtime);
});

test("文件内容变化后缓存失效并重新计算", async (context) => {
  const { root, modelFile, content, profile } = await fixture(context);
  await diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" });
  assert.equal((await readCache()).entries[modelFile].sha256, profile.models.dit.sha256);

  const changed = Buffer.concat([content, Buffer.from("!")]);
  await writeFile(modelFile, changed);
  const after = await diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "advisory" });
  assert.equal(after.available, true, "模型文件存在时 SHA 不匹配不应阻断普通诊断/生成");
  assert.equal(after.models.dit.status, "available");
  assert.equal(after.models.dit.integrity_status, "unverified");
  assert.equal(after.models.dit.reason, null);
  assert.equal(after.models.dit.actual_sha256, null);

  const strict = await diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" });
  assert.equal(strict.available, false, "安装/迁移的严格校验仍应暴露 SHA 不匹配");
  assert.equal(strict.models.dit.status, "hash_mismatch");
  assert.equal(strict.models.dit.actual_sha256, createHash("sha256").update(changed).digest("hex"));
  assert.equal((await readCache()).entries[modelFile].sha256, strict.models.dit.actual_sha256);
});

test("模型被同大小替换且恢复修改时间后仍重新校验精确身份", async (context) => {
  const { root, modelFile, content, profile } = await fixture(context);
  await diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" });
  const original = await stat(modelFile);
  const replacement = Buffer.alloc(content.length, 0x78);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(modelFile, replacement);
  await utimes(modelFile, original.atime, original.mtime);

  const after = await diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "advisory" });
  assert.equal(after.available, true);
  assert.equal(after.models.dit.status, "available");
  assert.equal(after.models.dit.integrity_status, "unverified");
  assert.equal(after.models.dit.actual_sha256, null);

  const strict = await diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" });
  assert.equal(strict.models.dit.status, "hash_mismatch");
  assert.equal(strict.models.dit.actual_sha256, createHash("sha256").update(replacement).digest("hex"));
});

test("缓存文件损坏时自动忽略并重新计算", async (context) => {
  const { root, profile } = await fixture(context);
  await writeFile(process.env.STORYVISUALIZER_HASH_CACHE_FILE, "{not valid json!!", "utf8");

  const diagnosis = await diagnoseRenderProfile(profile, root, { models_root: "models" }, null, { modelShaPolicy: "strict" });
  assert.equal(diagnosis.available, true);
  const entry = (await readCache()).entries[path.join(root, "models", "diffusion_models", "model.safetensors")];
  assert.equal(entry.sha256, profile.models.dit.sha256);
});

test("模型文件缺失仍阻断普通诊断", async (context) => {
  const { root, modelFile, profile } = await fixture(context);
  await rm(modelFile);

  const diagnosis = await diagnoseRenderProfile(profile, root, { models_root: "models" });

  assert.equal(diagnosis.available, false);
  assert.equal(diagnosis.models.dit.status, "missing");
  assert.equal(diagnosis.models.dit.reason, "file_missing");
});

test("远程 ComfyUI 即使配置了本机模型目录也把登记资源交给远端验证", async (context) => {
  const { root, profile } = await fixture(context);

  const diagnosis = await diagnoseRenderProfile(profile, root, {
    comfyui_urls: ["http://windows-gpu:8188"],
    models_root: "models",
  });

  assert.equal(diagnosis.available, true);
  assert.equal(diagnosis.models_root, null);
  for (const model of Object.values(diagnosis.models)) {
    assert.equal(model.status, "available");
    assert.equal(model.reason, "remote_unverified");
    assert.equal(model.actual_sha256, null);
    assert.equal(model.integrity_status, "unverified");
  }
});
