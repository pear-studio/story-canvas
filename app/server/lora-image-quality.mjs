import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { configuredPath, exists, readJson, sha256File, LoraTrainingError } from "./lora-training-support.mjs";

export async function readMusiqStatus(root, config) {
  const manifest = await readJson(path.join(root, "library/lora-training/quality/musiq.json"), { optional: true });
  const python = configuredPath(root, config?.lora_training?.quality?.python);
  const modelsRoot = configuredPath(root, config?.models_root);
  const model = modelsRoot && manifest?.file?.relative_path ? path.join(modelsRoot, manifest.file.relative_path) : null;
  const available = Boolean(python && model && await exists(python) && await exists(model));
  const sha256 = available ? await sha256File(model) : null;
  const ready = available && sha256 === manifest.file.sha256;
  return { ready, python, model, sha256, message: ready ? "MUSIQ 权重与 Python 已配置" : "请配置 lora_training.quality.python 并安装 MUSIQ 权重与 pyiqa" };
}

export function createMusiqSession(root, status) {
  if (!status.ready) throw new LoraTrainingError(409, "lora_musiq_unavailable", [status.message]);
  const child = spawn(status.python, [path.join(root, "app/scripts/lora-image-quality.py"), "--model", status.model], {
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
  });
  let pending = null;
  let failure = null;
  let stderr = "";
  const lines = createInterface({ input: child.stdout });
  const fail = error => {
    failure = error;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
  };
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.on("error", error => fail(new LoraTrainingError(503, "lora_musiq_failed", [error.message])));
  child.stdin.on("error", error => fail(new LoraTrainingError(503, "lora_musiq_failed", [error.message])));
  child.on("exit", code => fail(new LoraTrainingError(503, "lora_musiq_failed", [stderr || `评分进程退出：${code}`])));
  lines.on("line", line => {
    if (!pending) return;
    try {
      const value = JSON.parse(line);
      if (value.error || !Number.isFinite(value.score)) throw new Error(value.error ?? "无效分数");
      clearTimeout(pending.timer); pending.resolve(value.score); pending = null;
    } catch (error) { fail(new LoraTrainingError(503, "lora_musiq_failed", [error.message])); }
  });
  return {
    score(buffer) {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new Error("MUSIQ 评分必须串行"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(new LoraTrainingError(504, "lora_musiq_timeout", [stderr])); child.kill(); }, 120_000);
        pending = { resolve, reject, timer };
        child.stdin.write(`${JSON.stringify({ image: buffer.toString("base64") })}\n`);
      });
    },
    close() { lines.close(); child.kill(); },
  };
}
