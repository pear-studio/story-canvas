import { registerFixtureProjects } from "../project-registry-fixture.mjs";
import { PAGES_INDEX_SCHEMA_ID } from "../../server/pages-store.mjs";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { defaultLetteringSettings } from "../../server/lettering-settings.mjs";
import { STORY_OUTLINE_SCHEMA_ID, STORY_PAGE_NARRATIVE_SCHEMA_ID, STORY_PAGE_PROMPT_SCHEMA_ID } from "../../server/story-files.mjs";
import { CHARACTER_INDEX_SCHEMA_ID } from "../../server/character-files.mjs";
import { candidateFileRelativePath } from "../../server/candidate-storage.mjs";
import { prepareFinishedPage, runFinishedPage } from "../../server/finished-pages.mjs";
import { createProjectOperations } from "../../server/project-operations.mjs";
export const key = { page_id: "page-001" };
export const candidateId = "candidate-11111111-1111-4111-8111-111111111111";
export async function json(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); }
export async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "finished-pages-"));
  await symlink(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "library"), path.join(root, "library"), process.platform === "win32" ? "junction" : "dir");
  const directory = path.join(root, "workspace", "demo");
  const operations = createProjectOperations({ projectRoot: root });
  t.after(async () => { operations.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await json(path.join(directory, "project.json"), { $schema: "https://storyvisualizer.local/schemas/project.schema.json", format: "story-free-text-v1", title: "成品测试", canvas: "2:3", default_render_profile: "qwen-image-2-1" });
  await json(path.join(directory, "story/outline.json"), { $schema: STORY_OUTLINE_SCHEMA_ID, synopsis: "测试", chapters: [{ id: "chapter", title: "第一章", summary: "测试", sequences: [{ id: "sequence", title: "片段", summary: "测试" }] }] });
  await json(path.join(directory, "pages/index.json"), { $schema: PAGES_INDEX_SCHEMA_ID, pages: [{ page_id: key.page_id, owner_kind: "story", sequence_id: "sequence" }] });
  await json(path.join(directory, `pages/${key.page_id}.content.json`), { $schema: STORY_PAGE_NARRATIVE_SCHEMA_ID, title: "测试页", scene_description: "阳光照在窗台", characters: [], dialogue: [] });
  await json(path.join(directory, `pages/${key.page_id}.prompt.json`), { $schema: STORY_PAGE_PROMPT_SCHEMA_ID, text: "" });
  await json(path.join(directory, "characters/index.json"), { $schema: CHARACTER_INDEX_SCHEMA_ID, characters: [] });
  await json(path.join(directory, "lettering/settings.json"), defaultLetteringSettings());
  const file = path.join(directory, candidateFileRelativePath(key, candidateId));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await sharp({ create: { width: 128, height: 192, channels: 3, background: "#80b0a0" } }).png().toBuffer());
  await json(file.replace("image.png", "generation.json"), { seed: 1234, prompt: { positive: "sunlight", negative: "" }, models: [], loras: [], recipe: { steps: 20 } });
  await json(file.replace("image.png", "result.json"), { version: 1, status: "available", page_key: key, candidate_id: candidateId, file: candidateFileRelativePath(key, candidateId), seed: 1234, task_id: "render-20260826T010203Z" });
  const prepare = () => operations.mutateDerived("demo", () => prepareFinishedPage(root, "demo", directory, { page_key: key, candidate_id: candidateId })).then(result => result.value);
  const run = (prepared, options = {}) => runFinishedPage({ repositoryRoot: root, projectId: "demo", directory, prepared, config: {}, origin: "", mutateTargetFacts: operations.mutateTargetFacts,
    upscale: source => sharp(source).resize(256, 384).png().toBuffer(), render: async clean => clean, ...options });
  registerFixtureProjects(root); return { root, directory, operations, prepare, run, file };
}

