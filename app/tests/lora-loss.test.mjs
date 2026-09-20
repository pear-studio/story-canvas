import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mergeLossHistory } from "../shared/lora-loss.mjs";
import { attachLogParser } from "../server/lora-training-runtime.mjs";
import { readRunLossHistory, sortTrainingRuns } from "../server/lora-training-run-index.mjs";

test("运行记录按活跃优先、结束时间倒序，不受日志更新时间影响", () => {
  const run = (id, status, created_at, extra = {}) => ({ id, manifest: { created_at }, status: { status, ...extra } });
  const runs = [run('old','interrupted','2026-01-01',{interrupted_at:'2026-01-02',updated_at:'2027-01-01'}),run('new','completed','2026-01-01',{completed_at:'2026-01-03'}),run('active','running','2025-12-31')];
  assert.deepEqual(sortTrainingRuns(runs).map(run => run.id), ['active','new','old']);
});

test("loss 按 step 去重并排除采样进度、无效值", () => {
  const result = mergeLossHistory([{ step: 1, loss: 0.3 }], "steps: 2%|x| 2/100 [00:01, avr_loss=1e-1]\rsteps: 2%|x| 2/100 [00:01, avr_loss=0.09]\n20%|x| 3/24 [00:01]\nglobal_step=4 loss=NaN\nglobal_step=5 loss=0.08\n");
  assert.deepEqual(result, [{ step: 1, loss: 0.3 }, { step: 2, loss: 0.09 }, { step: 5, loss: 0.08 }]);
});

test("UTF-8 跨 chunk 的中日文不会损坏", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lora-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stream = new PassThrough();
  const log = path.join(dir, "output.log");
  const tracker = { outputTail: "", step: 0, loss: null, finished: true };
  attachLogParser(stream, log, dir, {}, tracker);
  const bytes = Buffer.from("训练開始\n");
  stream.write(bytes.subarray(0, 2));
  stream.end(bytes.subarray(2));
  await new Promise(resolve => stream.on("end", resolve));
  assert.equal(tracker.outputTail, "\n训练開始");
  // 等待异步日志写入完成。
  for (let i = 0; i < 50; i++) {
    if (await readFile(log, "utf8").catch(() => "") === "训练開始\n") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("日志未完整写入");
});

test("完整历史不受日志尾部窗口限制，缺失日志为空", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lora-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await readRunLossHistory(dir), []);
  await mkdir(path.join(dir, "logs"));
  await writeFile(path.join(dir, "logs", "stderr.log"), "global_step=1 loss=0.2\n" + "setup\n".repeat(10000) + "global_step=800 loss=0.08\n");
  assert.deepEqual(await readRunLossHistory(dir), [{ step: 1, loss: 0.2 }, { step: 800, loss: 0.08 }]);
});
