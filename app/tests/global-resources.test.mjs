import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readGlobalResources } from "../server/global-resources.mjs";
import { validateLoraResource } from "../server/lora-resources.mjs";

test("LoRA 中文浏览信息经全局资源投影保留，原始名称与标签不变", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-lora-browse-"));
  context.after(() => rm(root, { recursive: true }));
  const resource = JSON.parse(await readFile(new URL("../../library/resources/loras/lora-e16e862063a6e466/resource.json", import.meta.url), "utf8"));
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
  assert.equal(model.lora_metadata.name_zh, "肌肉感调节");
  assert.equal(model.lora_metadata.summary_zh, resource.summary_zh);
  assert.equal(model.lora_metadata.purpose, "外观调节");
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
