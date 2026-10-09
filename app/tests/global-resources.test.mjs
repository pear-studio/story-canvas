import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openLocalModelPreview, readGlobalResources, readResourceCatalog } from "../server/global-resources.mjs";
import { validateLoraResource } from "../server/lora-resources.mjs";

test("普通模型本机清单保留身份与预览，仓库同 ID 或路径优先", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-local-models-"));
  context.after(() => rm(root, { recursive: true }));
  const repository = { id: "main-model", name: "正式模型", kind: "dit", relative_path: "diffusion_models/main.safetensors" };
  const local = { id: "experiment", name: "实验模型", kind: "dit", relative_path: "diffusion_models/experiment.safetensors", sha256: "a".repeat(64), source: "https://example.com/model", preview: { images: [{ src: "/resource-previews/experiment.jpg", alt: "实验预览" }] } };
  const localRoot = path.join(root, "app/data.local/model-resources");
  await mkdir(path.join(root, "library/resources"), { recursive: true });
  await mkdir(path.join(localRoot, "previews"), { recursive: true });
  await writeFile(path.join(root, "library/resources/catalog.json"), JSON.stringify({ version: 1, models: [repository] }));
  await writeFile(path.join(localRoot, "catalog.json"), JSON.stringify({ version: 1, models: [{ ...repository, name: "旧本机副本" }, { ...repository, id: "other-id" }, local] }));
  await writeFile(path.join(localRoot, "previews/experiment.jpg"), "image");
  const catalog = await readResourceCatalog(root);
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].name, "正式模型");
  assert.equal(catalog.models[0].storage, "repository");
  assert.equal(catalog.models[1].storage, "local");
  assert.equal(catalog.models[1].sha256, local.sha256);
  assert.equal(catalog.models[1].preview.images[0].src, "/api/local-model-previews/experiment.jpg");
  const media = await openLocalModelPreview(root, "experiment.jpg");
  assert.equal(await readFile(media.target, "utf8"), "image");
  await assert.rejects(openLocalModelPreview(root, "../catalog.json"), error => error.code === "invalid_local_model_preview");
  await assert.rejects(openLocalModelPreview(root, "missing.jpg"), error => error.code === "local_model_preview_not_found");
  registerFixtureProjects(root);
  const result = await readGlobalResources(root);
  assert.equal(result.models.find(model => model.id === "experiment").storage, "local");
});

test("LoRA 中文浏览信息经全局资源投影保留，原始名称与标签不变", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-lora-browse-"));
  context.after(() => rm(root, { recursive: true }));
  const resource = JSON.parse(await readFile(new URL("../../library/resources/loras/lora-6ecff93984c1b084/resource.json", import.meta.url), "utf8"));
  const directory = path.join(root, "library/resources/loras", resource.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "resource.json"), JSON.stringify(resource));
  for (const media of [...resource.previews, ...resource.examples]) {
    await mkdir(path.dirname(path.join(directory, media.file)), { recursive: true });
    await writeFile(path.join(directory, media.file), "preview");
  }
  assert.deepEqual(validateLoraResource(resource), []);
  assert.ok(validateLoraResource({ ...resource, purpose: "slider" }).some(error => error.includes("purpose")));
  assert.ok(validateLoraResource({ ...resource, summary_zh: " " }).some(error => error.includes("summary_zh")));
  registerFixtureProjects(root);
  const result = await readGlobalResources(root);
  const model = result.models.find(model => model.id === resource.id);
  assert.equal(model.name, resource.name);
  assert.equal(model.lora_metadata.name_zh, resource.name_zh);
  assert.equal(model.lora_metadata.summary_zh, resource.summary_zh);
  assert.equal(model.lora_metadata.purpose, resource.purpose);
  assert.deepEqual(model.lora_metadata.activation.tags, resource.activation.tags);
});

test("全局资源投影发现本机模型、关联项目使用并忽略链接目录", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-global-resources-"));
  context.after(() => rm(root, { recursive: true }));

  await Promise.all([
    mkdir(path.join(root, "models", "checkpoints"), { recursive: true }),
    mkdir(path.join(root, "models", "loras"), { recursive: true }),
    mkdir(path.join(root, "models", "vae"), { recursive: true }),
    mkdir(path.join(root, "comfy", "custom_nodes", "ComfyUI-Example"), { recursive: true }),
    mkdir(path.join(root, "comfy", "custom_nodes", ".hidden"), { recursive: true }),
    mkdir(path.join(root, "workspace", "demo", "characters"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "models", "checkpoints", "base.ckpt"), "checkpoint"),
    writeFile(path.join(root, "models", "loras", "hero.safetensors"), "lora"),
    writeFile(path.join(root, "models", "vae", "clear.bin"), "vae"),
    writeFile(path.join(root, "workspace", "demo", "project.json"), JSON.stringify({ title: "演示项目", default_render_profile: "missing" })),
    writeFile(path.join(root, "workspace", "demo", "characters", "index.json"), JSON.stringify({ characters: ["hero"] })),
    writeFile(path.join(root, "workspace", "demo", "characters", "hero.prompt.json"), JSON.stringify({ identity: { prompt: {}, lora: { filename: "hero.safetensors" } }, variants: { base: { loras: [] } } })),
  ]);

  const outside = await mkdtemp(path.join(tmpdir(), "story-canvas-outside-models-"));
  context.after(() => rm(outside, { recursive: true }));
  await writeFile(path.join(outside, "outside.ckpt"), "outside");
  let linked = false;
  try {
    await symlink(outside, path.join(root, "models", "checkpoints", "linked"), process.platform === "win32" ? "junction" : "dir");
    linked = true;
  } catch {
    // 某些 Windows 环境禁止创建链接；其余资源发现契约仍可验证。
  }

  registerFixtureProjects(root);
  const result = await readGlobalResources(root, { models_root: "models", comfyui_root: "comfy" });
  const byPath = new Map(result.models.map((model) => [model.relative_path, model]));

  assert.equal(result.models_root, path.join(root, "models"));
  assert.equal(byPath.get("checkpoints/base.ckpt").kind, "checkpoint");
  assert.equal(byPath.get("checkpoints/base.ckpt").registered, false);
  assert.equal(byPath.get("vae/clear.bin").kind, "vae");
  assert.deepEqual(byPath.get("loras/hero.safetensors").usage.projects, [{ id: "demo", title: "演示项目" }]);
  if (linked) assert.equal(byPath.has("checkpoints/linked/outside.ckpt"), false);

  assert.deepEqual(result.extensions.items.map((item) => item.name), ["ComfyUI-Example"]);
  assert.equal(result.dictionaries[0].available, false);
  assert.equal(result.dictionaries[0].reason, "bundled_tags_snapshot_missing");
  assert.deepEqual(result.render_profiles, []);
  assert.deepEqual(result.workflows, []);
  assert.deepEqual(result.visual_page_templates, { version: 1, categories: [], templates: [], errors: [] });
});
