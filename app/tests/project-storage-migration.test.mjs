import { registerFixtureProjects } from "./project-registry-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateProjectStorage, projectTreeFingerprint } from "../server/project-storage-migration.mjs";
import { copyProject } from "../server/project-management.mjs";
import { readCandidateGeneration, readGenerationCandidateRecords } from "../server/candidate-storage.mjs";
import { cleanProjectRuntime } from "../server/project-runtime-cleanup.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64");
const id = "candidate-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskId = "render-20260828T010203Z-1234abcd";
const key = { page_id: "page-001" };
const put = async (root, file, bytes) => { const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); };
const save = (root, file, value) => put(root, file, JSON.stringify(value));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "storage-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "workspace", "demo");
  await save(project, "project.json", { title: "故事" });
  await save(project, "source/index.json", { version: 1, items: [] });
  await put(project, "source/brief.json", "{\r\n  \"原文\": \"不改字节\"\r\n}\r\n");
  await put(project, "inputs/lora-training/datasets/dataset-aaaaaaaaaaaa/assets/a/caption.txt", "一行\r\n第二行\n");
  await put(project, "inputs/lora-training/datasets/dataset-aaaaaaaaaaaa/assets/a/original.png", png);
  await put(project, "unknown/notes.txt", "保留未知文件");
  await put(project, ".gitignore", "/inputs/\n/tasks/\n/candidates/\n");
  const item = { id: "item-1", candidate_id: id, page_key: { ...key, owner_kind: "story", owner_id: "story" }, file: `candidates/story/story/page-001/${id}.png`, status: "available", seed: 7, positive_prompt: "frozen prompt" };
  await put(project, item.file, png);
  await save(project, `tasks/render/history/${taskId}/manifest.json`, { storage_version: 1, task: { id: taskId, project: "demo", purpose: "candidate", snapshot: {}, items: [item] } });
  await save(project, `tasks/render/history/${taskId}/state.json`, { version: 1, id: taskId, project_id: "demo", status: "completed", purpose: "candidate", revision: 1, pages: [{ page_key: item.page_key }], items: [item] });
  registerFixtureProjects(root); return { root, project };
}

test("离线迁移完整保留未知文件和独立Git状态，成果清理runtime后可读", async t => {
  const { root, project } = await fixture(t);
  const git = args => execFileSync("git", ["-C", project, ...args], { windowsHide: true });
  git(["init", "--quiet"]); git(["add", "project.json", "unknown/notes.txt"]);
  await put(project, "unknown/notes.txt", "未暂存改动");
  const index = await readFile(path.join(project, ".git", "index"));
  const baseline = await projectTreeFingerprint(project);
  const report = await migrateProjectStorage(root, "demo", { renameDirectory: async (from, to) => {
    if (from === project) throw Object.assign(new Error("Windows 根目录被编辑器占用"), { code: "EPERM" });
    return rename(from, to);
  } });
  assert.deepEqual(await projectTreeFingerprint(report.backup_directory), baseline);
  assert.deepEqual(await readFile(path.join(project, ".git", "index")), index);
  assert.equal(await readFile(path.join(project, "unknown/notes.txt"), "utf8"), "未暂存改动");
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].to, `Outputs/pages/page-001/${id}/image.png`);
  const detail = await readCandidateGeneration(project, key, id);
  assert.equal(detail.prompt.positive, "frozen prompt");
  assert.equal(detail.submission.availability, "unavailable");
  assert.match(detail.evidence.original_manifest, /owner_id/);
  const generationFile = path.join(project, path.dirname(report.candidates[0].to), "generation.json");
  const generationBytes = await readFile(generationFile);
  await writeFile(generationFile, "{}\n");
  await assert.rejects(cleanProjectRuntime(project), /成果字节校验失败/);
  assert.ok(await readFile(path.join(project, "Saved", "render", "history", taskId, "state.json")));
  await writeFile(generationFile, generationBytes);
  await cleanProjectRuntime(project);
  assert.equal((await readGenerationCandidateRecords(project)).length, 1);
  assert.deepEqual(await readCandidateGeneration(project, key, id), detail);
  const copied = await copyProject(root, "demo");
  const copy = path.join(root, "workspace", copied.id);
  assert.deepEqual(await readFile(path.join(copy, "materials/brief.json")), await readFile(path.join(project, "materials/brief.json")));
  await assert.rejects(readFile(path.join(copy, "lora-training/datasets/dataset-aaaaaaaaaaaa/assets/a/original.png")), { code: "ENOENT" });
  assert.equal((await readdir(copy)).includes("Outputs"), false);
  assert.equal((await readdir(copy)).includes(".git"), false);
  // Git以真实索引、真实checkout验证Caption及材料字节，不模拟行尾转换。
  git(["-c", "core.autocrlf=true", "add", ".gitattributes", "materials", "lora-training"]);
  const checkout = path.join(root, "checkout"); await mkdir(checkout);
  git(["-c", "core.autocrlf=true", "checkout-index", "--all", `--prefix=${checkout.replaceAll("\\", "/")}/`]);
  for (const file of ["materials/brief.json"]) {
    assert.deepEqual(await readFile(path.join(checkout, file)), await readFile(path.join(project, file)));
  }
});

test("迁移副本准备后原目录被改动时拒绝替换，不丢新写入", async t => {
  const { root, project } = await fixture(t);
  await assert.rejects(migrateProjectStorage(root, "demo", { beforeSwap: () => put(project, "source/late.txt", "并发写入") }), /原项目发生变化/);
  assert.equal(await readFile(path.join(project, "source/late.txt"), "utf8"), "并发写入");
  assert.deepEqual(await readFile(path.join(project, `candidates/story/story/page-001/${id}.png`)), png);
  assert.deepEqual(await readdir(path.join(root, "workspace")), ["demo"]);
});
