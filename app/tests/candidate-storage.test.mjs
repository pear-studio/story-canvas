import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  candidateFileRelativePath,
  createCandidateStorageIdentity,
  readGenerationCandidateRecords, publishCandidateResult, readCandidateGeneration,
} from "../server/candidate-storage.mjs";
import { createRenderTask, updateRenderTask } from "../server/render-task-storage.mjs";

const pageKey = { page_id: "page-001" };
const taskId = "render-20260813T120000Z-a1b2c3d4";
const candidateId = "candidate-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("候选身份由 PageKey 与稳定 UUID 唯一确定", () => {
  const identity = createCandidateStorageIdentity(pageKey, () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.deepEqual(identity, {
    candidate_id: candidateId,
    file: `Outputs/pages/page-001/${candidateId}/image.png`,
  });
});

test("候选成果独立于任务历史且重复发布不覆盖", async (context) => {
  const projectDirectory = await mkdtemp(path.join(tmpdir(), "story-canvas-candidate-index-"));
  context.after(() => rm(projectDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const file = candidateFileRelativePath(pageKey, candidateId);
  const task = {
    version: 2,
    id: taskId,
    project: "demo",
    render_profile: "anima-base-v1",
    purpose: "candidate",
    status: "queued",
    created_at: "2026-08-13T12:00:00.000Z",
    snapshot: { prompt_dictionary: { sha256: "f".repeat(64) }, profile: { id: "test", custom_frozen_setting: "preserved" } },
    items: [{ id: "item-001", candidate_id: candidateId, page_key: pageKey, file, status: "queued" }],
  };
  await createRenderTask(projectDirectory, task, { project_title: "Demo", pages: [] });
  await updateRenderTask(projectDirectory, taskId, (current) => {
    current.status = "completed";
    current.completed_at = "2026-08-13T12:01:00.000Z";
    current.items[0].status = "available";
  });
  await writeJson(path.join(projectDirectory, "tasks", "notes", "ignored.json"), { version: 1 });

  await publishCandidateResult(projectDirectory, task, task.items[0], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64"));
  // 发布后媒体预览仍可能在后台落盘，Windows 删除临时目录时允许短暂重试。
  await rm(path.join(projectDirectory, "Saved"), { recursive: true, maxRetries: 5, retryDelay: 20 });
  await publishCandidateResult(projectDirectory, task, task.items[0], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=", "base64"));
  const detail = await readCandidateGeneration(projectDirectory, pageKey, candidateId);
  assert.equal(detail.task_id, taskId);
  assert.deepEqual(detail.evidence.task_snapshot.snapshot, task.snapshot);
  const records = await readGenerationCandidateRecords(projectDirectory);

  assert.deepEqual(records.map(({ candidate_id, page_key, file: candidateFile, task_id }) => ({
    candidate_id,
    page_key,
    file: candidateFile,
    task_id,
  })), [{ candidate_id: candidateId, page_key: pageKey, file, task_id: taskId }]);
});


test("历史生成证据原样读取，旧页面键不会经过当前页面键校验", async context => {
  const directory = await mkdtemp(path.join(tmpdir(), "candidate-history-evidence-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = { page_key: { owner_kind: "character", owner_id: "ellen", page_id: "page-001" },
    prompt: { positive: "historical prompt", negative: "" }, evidence: { task_snapshot: { snapshot: { marker: "unchanged" } } } };
  await writeJson(path.join(directory, candidateFileRelativePath(pageKey, candidateId).replace("image.png", "generation.json")), evidence);
  assert.deepEqual(await readCandidateGeneration(directory, pageKey, candidateId), evidence);
});
