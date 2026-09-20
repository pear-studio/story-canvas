import { listWorkspaceRenderTasks } from "../server/render-task-workspace.mjs";
import Ajv2020 from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, access, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerProject, registeredProjectPath, readProjectRegistry } from "../server/project-registry.mjs";
import { openProjectDirectory, manageRegisteredProject, projectLibrary } from "../server/project-library.mjs";
import { readWorkspaceProjects } from "../server/project-http.mjs";
import { createLoraTrainingDataset, readLoraTrainingTask, updateLoraTrainingDataset, updateLoraTrainingTask } from "../server/lora-training-facts.mjs";
import { createLoraTrainingOperations } from "../server/lora-training-operations.mjs";

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "story-canvas-library-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "tool"), story = path.join(base, "external", "story");
  await mkdir(root, { recursive: true }); await mkdir(story, { recursive: true });
  await writeFile(path.join(story, "project.json"), JSON.stringify({ title: "外部故事", canvas: "3:4" }));
  return { base, root, story };
}

test("只读取明确登记的外部项目，移除登记不删除文件，缺失路径仍可重新定位", async t => {
  const { root, story, base } = await fixture(t);
  assert.equal((await readWorkspaceProjects(root)).projects.length, 0);
  const entry = await openProjectDirectory(root, story);
  assert.equal(registeredProjectPath(root, entry.id), story);
  assert.equal((await readWorkspaceProjects(root)).projects[0].title, "外部故事");
  await manageRegisteredProject(root, entry.id, "forget");
  await access(path.join(story, "project.json"));
  assert.equal(readProjectRegistry(root).length, 0);
  await openProjectDirectory(root, story);
  const { rename } = await import("node:fs/promises");
  const moved = path.join(base, "moved"); await rename(story, moved);
  assert.equal(projectLibrary(root).projects[0].available, false);
  await manageRegisteredProject(root, entry.id, "relocate", { path: moved });
  assert.equal((await readWorkspaceProjects(root)).projects[0].available, true);
});

test("临时副本独立复制素材，不带 Git 和输出；提升后保留成果并更新路径", async t => {
  const { root, story, base } = await fixture(t);
  await mkdir(path.join(story, "materials")); await writeFile(path.join(story, "materials", "reference.txt"), "原文");
  await mkdir(path.join(story, "Outputs")); await writeFile(path.join(story, "Outputs", "old.png"), "old output");
  await mkdir(path.join(story, ".git")); await writeFile(path.join(story, ".git", "old"), "old history");
  const entry = await openProjectDirectory(root, story);
  const copy = await manageRegisteredProject(root, entry.id, "copy");
  const directory = registeredProjectPath(root, copy.id);
  assert.equal(readProjectRegistry(root).find(item => item.id === copy.id).temporary, true);
  await assert.rejects(access(path.join(directory, ".git")), { code: "ENOENT" });
  await assert.rejects(access(path.join(directory, "Outputs")), { code: "ENOENT" });
  await writeFile(path.join(directory, "materials", "reference.txt"), "副本");
  assert.equal(await readFile(path.join(story, "materials", "reference.txt"), "utf8"), "原文");
  await mkdir(path.join(directory, "Outputs")); await writeFile(path.join(directory, "Outputs", "new.png"), "new output");
  const destination = path.join(base, "formal", "copy");
  await manageRegisteredProject(root, copy.id, "promote", { path: destination });
  assert.equal(registeredProjectPath(root, copy.id), destination);
  await access(path.join(destination, "Outputs", "new.png")); await access(path.join(destination, ".git"));
  await assert.rejects(manageRegisteredProject(root, copy.id, "delete"), { code: "temporary_project_required" });
});

test("训练项目只有一份当前设置，素材和设置共享版本，Saved 清理不影响项目", async t => {
  const { root, base } = await fixture(t);
  await cp(new URL("../../library/lora-training", import.meta.url), path.join(root, "library/lora-training"), { recursive: true });
  const created = await createLoraTrainingDataset(root, { name: "角色项目", path: path.join(base, "training") });
  const task = await readLoraTrainingTask(root, created.id);
  assert.equal(task.id, created.id); assert.equal(task.task.name, "角色项目");
  const operations = createLoraTrainingOperations(root);
  const datasetScope = `/api/lora-training/datasets/${created.id}`, settingsScope = `/api/lora-training/tasks/${created.id}`;
  const before = await operations.execute(datasetScope, null, false, () => null);
  const settings = await operations.execute(settingsScope, null, false, () => null);
  assert.equal(before.revision, settings.revision);
  await operations.execute(datasetScope, before.revision, true, () => updateLoraTrainingDataset(root, created.id, { ...created.dataset, name: "新项目名" }));
  await assert.rejects(operations.execute(settingsScope, settings.revision, true, () => updateLoraTrainingTask(root, root, created.id, task.task)), { code: "training_revision_conflict" });
  const file = registeredProjectPath(root, created.id, "training");
  const schema = JSON.parse(await readFile(new URL("../../library/schemas/lora-training-settings.schema.json", import.meta.url)));
  const validate = new Ajv2020().compile(schema);
  assert.equal(validate(JSON.parse(await readFile(path.join(file, "settings.json")))), true, JSON.stringify(validate.errors));
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path.join(file, "settings.json"))), "dataset_id"), false);
  await mkdir(path.join(file, "Saved")); await rm(path.join(file, "Saved"), { recursive: true });
  assert.equal((await readLoraTrainingTask(root, created.id)).task.name, "新项目名");
});

test("临时复制避开外部已登记 ID，不能提升到自己的子目录", async t => {
  const { root, story, base } = await fixture(t);
  const entry = await openProjectDirectory(root, story);
  const external = path.join(base, "story_1"); await mkdir(external);
  registerProject(root, { id: "story_1", type: "story", path: external });
  const copy = await manageRegisteredProject(root, entry.id, "copy");
  assert.equal(copy.id, "story_2");
  assert.equal(registeredProjectPath(root, "story_1"), external);
  await assert.rejects(manageRegisteredProject(root, copy.id, "promote", { path: path.join(copy.path, "nested") }), { code: "destination_inside_project" });
  assert.equal(registeredProjectPath(root, copy.id), copy.path);
});

test("Saved 中保留已完成对比实验时，任务状态接口仍可读取", async t => {
  const { root } = await fixture(t);
  const directory = path.join(root, "Saved", "comparisons", "past-experiment");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "status.json"), JSON.stringify({ id: "past-experiment", status: "completed" }));
  const result = await listWorkspaceRenderTasks(root);
  assert.deepEqual(result.tasks, []);
});
