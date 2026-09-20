import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { requireIdleProject } from "./project-management.mjs";
import { candidateFilePath, readCandidateGeneration, readCandidateResult } from "./candidate-storage.mjs";
import { listProjectRenderTaskStates } from "./render-task-storage.mjs";
import { readComparisonExperimentStorage } from "./comparison-experiment-storage.mjs";
import { resolveExistingProjectMedia } from "./render-media.mjs";

const json = async target => JSON.parse(await readFile(target, "utf8"));

async function verifyFile(projectDirectory, target, expectedHash = null) {
  const relative = path.relative(projectDirectory, target).replaceAll("\\", "/");
  const resolved = await resolveExistingProjectMedia(projectDirectory, relative);
  if (!resolved) throw new Error(`成果文件缺失：${relative}`);
  const bytes = await readFile(resolved.target);
  if (expectedHash !== null && (!/^[a-f0-9]{64}$/.test(expectedHash) || createHash("sha256").update(bytes).digest("hex") !== expectedHash)) throw new Error(`成果字节校验失败：${relative}`);
  return bytes;
}

async function verifyArchivedRun(projectDirectory, scope, relative, runtimeStatus) {
  const archive = path.join(projectDirectory, "Saved", "comparison-results", path.basename(relative));
  const result = await json(path.join(archive, "result.json"));
  if (["queued", "running", "starting", "stopping"].includes(result.status) || result.status !== runtimeStatus.status) throw new Error(`成果尚未归档：${relative}`);
  if (scope === "comparisons") {
    const record = await readComparisonExperimentStorage(projectDirectory, path.basename(archive));
    for (const cell of record.status.cells.filter(cell => cell.status === "completed")) {
      const directory = path.join(archive, "results", cell.id);
      const stored = await json(path.join(directory, "result.json"));
      if (JSON.stringify(stored) !== JSON.stringify(cell.result)) throw new Error(`比较成果记录不一致：${cell.id}`);
      await verifyFile(projectDirectory, path.join(directory, "image.png"), stored.image.sha256);
      await verifyFile(projectDirectory, path.join(directory, "generation.json"), stored.generation_sha256 ?? "");
    }
  }
}

// 仅由离线维护入口调用；不自动触发，不删除 generated 或项目外权重。
export async function cleanProjectRuntime(projectDirectory) {
  await requireIdleProject(projectDirectory);
  for (const task of await listProjectRenderTaskStates(projectDirectory, { strict: true })) {
    for (const item of task.items.filter(item => item.status === "available")) {
      const result = await readCandidateResult(projectDirectory, item.page_key, item.candidate_id);
      // 已明确删除的候选不因旧历史 available 标记被复活。
      if (!result) {
        if (await lstat(candidateFilePath(projectDirectory, item.page_key, item.candidate_id)).catch(error => error.code === "ENOENT" ? null : Promise.reject(error))) throw new Error("候选缺少成果记录，不能清理任务历史");
        continue;
      }
      await readCandidateGeneration(projectDirectory, item.page_key, item.candidate_id);
      await verifyFile(projectDirectory, path.join(projectDirectory, result.file), result.image_sha256 ?? "");
      await verifyFile(projectDirectory, path.join(projectDirectory, path.dirname(result.file), "generation.json"), result.generation_sha256 ?? "");
    }
  }
  for (const scope of ["comparisons"]) {
    const walk = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("运行目录含链接，不能清理");
        if (entry.isDirectory()) await walk(target);
        else if (entry.name === "status.json") {
          const relative = path.relative(path.join(projectDirectory, "Saved"), path.dirname(target));
          const status = await json(target);
          await verifyArchivedRun(projectDirectory, scope, relative, status);
        }
      }
    };
    await walk(path.join(projectDirectory, "Saved", scope));
  }
  const runtime = path.join(projectDirectory, "Saved");
  const info = await lstat(runtime).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return { cleaned: false };
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("运行目录无效");
  const staged = path.join(projectDirectory, `.runtime-cleanup-${randomUUID()}`);
  await rename(runtime, staged);
  for (const name of ["comparison-results", "comparison-reviews"]) {
    if (await lstat(path.join(staged, name)).catch(error => error.code === "ENOENT" ? null : Promise.reject(error))) {
      const { mkdir } = await import("node:fs/promises"); await mkdir(runtime, { recursive: true });
      await rename(path.join(staged, name), path.join(runtime, name));
    }
  }
  await rm(staged, { recursive: true, force: false });
  return { cleaned: true };
}
