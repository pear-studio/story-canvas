import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readResolvedRenderProfile } from "../server/render-profile-compiler.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("应用保持本地轻依赖边界", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const allPackages = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  for (const unwanted of ["express", "next", "vinext", "wrangler", "tailwindcss", "drizzle-orm"]) {
    assert.equal(allPackages[unwanted], undefined, `${unwanted} should not be a project dependency`);
  }
});

test("资源目录为生成配置模型登记结构家族并保持同一精确身份", async () => {
  const catalog = JSON.parse(await readFile(path.join(repositoryRoot, "library", "resources", "catalog.json"), "utf8"));
  assert.equal(catalog.version, 1);
  assert.equal(new Set(catalog.models.map((model) => model.id)).size, catalog.models.length);
  for (const model of catalog.models) {
    assert.ok(["anima", "qwen-image-2-1", "other"].includes(model.architecture_family));
    assert.match(model.sha256, /^[a-f0-9]{64}$/);
  }
  const profileFiles = (await readdir(path.join(repositoryRoot, "library", "render-profiles"))).filter((file) => file.endsWith(".json"));
  for (const file of profileFiles) {
    const profile = JSON.parse(await readFile(path.join(repositoryRoot, "library", "render-profiles", file), "utf8"));
    const declared = Object.values(profile.models ?? {});
    for (const model of declared) {
      const registered = catalog.models.find((item) => item.relative_path === model.relative_path);
      assert.ok(registered, `${profile.id} 的 ${model.relative_path} 尚未登记`);
      assert.equal(registered.sha256, model.sha256, `${profile.id} 的 ${model.relative_path} 身份不一致`);
    }
  }
});

test("生成配置复用模型资源示例图", async () => {
  const profilesRoot = path.join(repositoryRoot, "library", "render-profiles");
  const catalog = JSON.parse(await readFile(path.join(repositoryRoot, "library", "resources", "catalog.json"), "utf8"));
  const profileFiles = (await readdir(profilesRoot)).filter((name) => name.endsWith(".json"));
  const profiles = await Promise.all(profileFiles.map(async (name) => (
    await readResolvedRenderProfile(repositoryRoot, name.slice(0, -".json".length))
  ).resolved_profile));
  for (const profile of profiles) {
    assert.equal(Object.hasOwn(profile, "preview"), false, `${profile.id} 不应拥有模型示例图`);
    const checkpoint = profile.models.checkpoint ?? profile.models.dit;
    const resource = catalog.models.find((model) => model.relative_path === checkpoint.relative_path && model.sha256 === checkpoint.sha256);
    assert.ok(resource, `${profile.id} 缺少对应模型资源`);
    const images = resource.preview?.images ?? [];
    assert.ok(images.length >= 1, `${resource.id} 缺少示例图`);
    for (const image of images) {
      assert.match(image.src, /^\/resource-previews\//, `${resource.id} 的示例图路径无效`);
      const previewFile = path.join(repositoryRoot, "app", "public", image.src.replace(/^\//, ""));
      assert.ok((await readFile(previewFile)).length > 0, `${resource.id} 的示例图为空`);
    }
  }
});

test("项目与本机边界正确区分事实和派生文件", async () => {
  async function isIgnored(relativePath) {
    try {
      await execFileAsync("git", ["check-ignore", "--no-index", "--quiet", relativePath], {
        cwd: repositoryRoot,
      });
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  }

  assert.equal(await isIgnored("workspace/private-story/project.json"), true);
  for (const ignored of [
    "Saved/logs/story-canvas.log",
    "Config/local.json",
    "app/data.local/resource.json",
    "app/node_modules/example/package.json",
    "app/dist/assets/index.js",
    "models/checkpoint.safetensors",
  ]) {
    assert.equal(await isIgnored(ignored), true, ignored);
  }
});

test("说明性文档以中文为正文语言", async () => {
  const roots = [".agents/skills", "docs", "library"];
  const markdownFiles = new Set(
    // CLAUDE.md 是被忽略的本机投影，干净 checkout / worktree 不要求存在。
    ["README.md", "AGENTS.md"].map((file) => path.join(repositoryRoot, file)),
  );
  for (const root of roots) {
    const entries = await readdir(path.join(repositoryRoot, root), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const parent = entry.parentPath ?? entry.path;
      const file = path.join(parent, entry.name);
      if (file.includes(`${path.sep}node_modules${path.sep}`) || file.includes(`${path.sep}dist${path.sep}`)) continue;
      markdownFiles.add(file);
    }
  }
  for (const file of markdownFiles) {
    const source = await readFile(file, "utf8");
    assert.match(source, /\p{Script=Han}/u, `${path.relative(repositoryRoot, file)} 缺少中文正文`);
  }

  for (const relativePath of ["library/prompt-dictionaries/a1111-tagcomplete.json"]) {
    const value = JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
    const notes = value.notes ?? value.custom_nodes?.map((item) => item.notes).join("\n") ?? "";
    assert.match(notes, /\p{Script=Han}/u, `${relativePath} 的说明字段必须使用中文`);
  }
});
