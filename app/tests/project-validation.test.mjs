import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateProject } from "../scripts/validate-project.mjs";
import {
  createProject,
  readProjectCreationTemplate,
} from "../server/project-creation.mjs";
import { defaultSceneFacts } from "../server/scene-files.mjs";

async function createCurrentProject(context) {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-validation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const session = await readProjectCreationTemplate(root, "validation-story");
  const creation = structuredClone(session.document);
  creation.metadata.title = "校验故事";
  creation.outline = {
    synopsis: "一次简短相遇。",
    chapters: [{
      id: "meeting",
      title: "相遇",
      summary: "两人相遇。",
      sequences: [{ id: "doorstep", title: "门口", summary: "在门口碰面。" }],
    }],
  };
  creation.characters = [{
    id: "ellen",
    name: "艾莲",
    description: "冷静。",
    visual_description: "黑红短发。",
    variants: [{ id: "default", name: "默认", description: "基础形象。" }],
  }];
  session.document = structuredClone(creation);
  await createProject(root, session);
  return path.join(root, "workspace", "validation-story");
}

test("当前项目创建结果满足项目事实契约", async (context) => {
  const projectDirectory = await createCurrentProject(context);

  const result = await validateProject(projectDirectory);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.counts, { storyPages: 0, characterPages: 0, scenePages: 0, characters: 1, promptIssues: 0 });
});

test("项目校验报告页面索引指向的缺失事实文件", async (context) => {
  const projectDirectory = await createCurrentProject(context);
  const indexPath = path.join(projectDirectory, "pages", "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.pages.push({ page_id: "page-001", owner_kind: "story", sequence_id: "doorstep" });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const result = await validateProject(projectDirectory);

  assert.ok(result.errors.includes("页面文件：missing_content_file（page_id=page-001）"));
  assert.ok(result.errors.includes("页面文件：missing_prompt_file（page_id=page-001）"));
});

test("场景子设定校验读取模型容器，并仍报告缺失的子设定", async (context) => {
  const projectDirectory = await createCurrentProject(context);
  const scene = defaultSceneFacts("room", "房间", "anima");
  const sceneDirectory = path.join(projectDirectory, "scenes");
  await writeFile(path.join(sceneDirectory, "index.json"), JSON.stringify({ $schema: "https://storyvisualizer.local/schemas/scene-index.schema.json", scenes: ["room"] }));
  for (const kind of ["profile", "visual", "prompt"]) await writeFile(path.join(sceneDirectory, `room.${kind}.json`), JSON.stringify(scene[kind]));

  assert.deepEqual((await validateProject(projectDirectory)).errors, []);

  scene.visual.variants.push({ ...scene.visual.variants[0], id: "missing" });
  await writeFile(path.join(sceneDirectory, "room.visual.json"), JSON.stringify(scene.visual));
  const result = await validateProject(projectDirectory);
  assert.ok(result.errors.includes("场景子设定 Prompt 缺失：room/missing"));
  assert.ok(!result.errors.includes("场景子设定 Prompt 缺失：room/default"));
});
