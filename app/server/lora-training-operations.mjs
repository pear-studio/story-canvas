import { datasetRoot, taskRoot, trainingRecordProjectRoot } from "./lora-training-support.mjs";
import { listRegisteredProjects } from "./project-registry.mjs";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { requireTask } from "./lora-training-facts.mjs";
import { LoraTrainingError } from "./lora-training-support.mjs";

// 训练事实独立于剧情项目。单服务内串行读写，并以事实签名拒绝旧草稿覆盖。
export function createLoraTrainingOperations(repositoryRoot) {
  let pending = Promise.resolve();
  async function signature(scope) {
    const entries = [];
    async function collect(directory) {
      for (const item of await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        if ([".git", "Saved", "Training", "Outputs", "References"].includes(item.name)) continue;
        const target = path.join(directory, item.name);
        if (item.isDirectory()) await collect(target);
        else if (item.isFile()) {
          const info = await stat(target);
          entries.push(`${path.relative(repositoryRoot, target)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
        }
      }
    }
    const dataset = /^\/api\/lora-training\/datasets\/(dataset-[a-f0-9]{12})(?:\/|$)/.exec(scope);
    const task = /^\/api\/lora-training\/tasks\/((?:lora|dataset)-[a-f0-9]{12})(?:\/|$)/.exec(scope);
    if (dataset) await collect(datasetRoot(repositoryRoot, dataset[1]));
    else if (task) {
      await collect(trainingRecordProjectRoot(repositoryRoot, task[1]));

    }
    else for (const entry of listRegisteredProjects(repositoryRoot, "training")) if (entry.available) await collect(entry.path);
    return `"${createHash("sha256").update(entries.sort().join("\n")).digest("hex")}"`;
  }
  return {
    execute(scope, expected, write, operation) {
      const result = pending.then(async () => {
        const before = await signature(scope);
        const needsRevision = write && !/^\/api\/lora-training\/(datasets|tasks)\/?$/.test(scope);
        if (needsRevision && !expected) throw new LoraTrainingError(428, "training_revision_required");
        if (needsRevision && expected !== before) throw new LoraTrainingError(409, "training_revision_conflict");
        const value = await operation({ projectDirectory: repositoryRoot });
        return { value, revision: await signature(scope) };
      });
      pending = result.catch(() => undefined);
      return result;
    },
  };
}
