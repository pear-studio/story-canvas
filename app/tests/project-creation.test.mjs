import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProject,
  readProjectCreationTemplate,
} from "../server/project-creation.mjs";
import { readProjectWorkbenchView } from "../server/project-workbench.mjs";

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

test("模板直接创建完整项目，重复创建拒绝覆盖", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "story-canvas-create-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const session = await readProjectCreationTemplate(root, "clean-story");
  const creation = structuredClone(session.document);
  creation.metadata.title = "干净故事";
  creation.outline = {
    synopsis: "两人在门口意外相认，重新划清边界后决定继续。",
    chapters: [{
      id: "meeting",
      title: "相认",
      summary: "完成相认与继续的动机建立。",
      sequences: [{ id: "doorstep", title: "门口相认", summary: "相认后重新确认边界。" }],
    }],
  };
  creation.characters = [{
    id: "ellen",
    name: "艾莲",
    description: "起初冷静掌控局面。",
    visual_description: "黑红挑染短发与红眼。",
    variants: [{ id: "uniform", name: "制服", description: "白衬衫与百褶裙。" }],
  }];
  session.document = structuredClone(creation);

  const result = await createProject(root, session, { now: () => "2026-08-27T00:00:00.000Z" });
  const directory = path.join(root, "workspace", "clean-story");
  assert.equal(result.absolute_directory, directory);
  assert.deepEqual(await readJson(path.join(directory, "pages", "index.json")), {
    $schema: "https://storyvisualizer.local/schemas/pages-index.schema.json", pages: [],
  });
  assert.deepEqual(await readJson(path.join(directory, "scenes", "index.json")), {
    $schema: "https://storyvisualizer.local/schemas/scene-index.schema.json", scenes: [],
  });
  assert.deepEqual(await readJson(path.join(directory, "lettering", "dialogue-layouts.json")), {
    $schema: "https://storyvisualizer.local/schemas/lettering.schema.json",
    version: 2,
    pages: [],
  });
  const characterPrompt = await readJson(path.join(directory, "characters", "ellen.prompt.json"));
  assert.deepEqual(characterPrompt.models.anima.identity.prompt, {population:[],person:[],setting:[],camera:[],avoid:[]});
  assert.deepEqual(characterPrompt.models.anima.variants.uniform.loras, []);
  const projectManifest = await readJson(path.join(directory, "project.json"));
  assert.equal(projectManifest.format, "story-models-v1");
  assert.equal(projectManifest.default_render_profile, "anima-base-v1");
  for (const forbidden of ["story/storyboard.json", "characters/characters.json", "characters/pages.json", "collaboration", "assessment", "candidates", "tasks", "materials/adaptation.md"]) {
    assert.equal(await readFile(path.join(directory, ...forbidden.split("/")), "utf8").then(() => true, () => false), false, forbidden);
  }
  const view = await readProjectWorkbenchView(root, "clean-story");
  assert.equal(view.project.title, "干净故事");
  assert.equal(view.project.lettering_settings.font_size, 28);
  assert.deepEqual(view.project.lettering_settings.character_colors, {});
  assert.equal(view.outline.chapters[0].sequences[0].pages.length, 0);
  assert.deepEqual(view.diagnostics, []);
  await assert.rejects(() => readProjectCreationTemplate(root, "clean-story"), (error) => error.code === "project_already_exists");
});
