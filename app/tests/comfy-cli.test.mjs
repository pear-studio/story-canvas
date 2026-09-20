import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { clearStaleComfyCliBackground, runComfyCli } from "../server/comfy-cli.mjs";

function fakeSpawn(envelope, capture) {
  return (executable, args, options) => {
    capture.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    queueMicrotask(() => {
      child.stdout.end(`${JSON.stringify(envelope)}\n`);
      child.emit("close", envelope.ok ? 0 : 1, null);
    });
    return child;
  };
}

function fakeOutputSpawn({ stdout = "", stderr = "", code = 0, signal = null }, capture) {
  return (executable, args, options) => {
    capture.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", code, signal);
    });
    return child;
  };
}

test("comfy-cli runner 固定 JSON、workspace 和 shell 安全边界，并临时扩展 PATH", async () => {
  const calls = [];
  const envelope = { schema: "envelope/1", type: "envelope", ok: true, data: { workspace_path: "D:\\ComfyUI-cli" }, error: null };
  const result = await runComfyCli({
    executable: "D:/ComfyCLI/.venv/Scripts/comfy.exe",
    workspace: "D:/ComfyUI-cli",
    args: ["which"],
    spawnImpl: fakeSpawn(envelope, calls),
  });
  assert.deepEqual(result, envelope);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--json", "--workspace", "D:/ComfyUI-cli", "which"]);
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].options.env.PATH ?? calls[0].options.env.Path, /ComfyCLI[\\/]\.venv[\\/]Scripts/);
});

test("comfy-cli runner 将 JSON envelope 错误转换为可识别错误", async () => {
  const envelope = { schema: "envelope/1", type: "envelope", ok: false, data: null, error: { code: "project_not_found", message: "workspace missing" } };
  await assert.rejects(
    runComfyCli({ executable: "comfy.exe", workspace: "D:/missing", args: ["which"], spawnImpl: fakeSpawn(envelope, []) }),
    (error) => error?.code === "comfy_cli_project_not_found" && error?.envelope?.error?.code === envelope.error.code,
  );
});

test("显式维护命令允许无 envelope 成功，并合成可验证的结果", async () => {
  const calls = [];
  const result = await runComfyCli({
    executable: "comfy.exe",
    workspace: "D:/NewComfyUI",
    cwd: "D:/StoryCanvas",
    args: ["install", "--skip-manager", "--nvidia"],
    allowMissingEnvelope: true,
    spawnImpl: fakeOutputSpawn({ stdout: "ComfyUI installed successfully\n" }, calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.command, "install");
  assert.equal(result.data.envelope, false);
  assert.equal(result.data.output.stdout, "ComfyUI installed successfully");
  assert.equal(calls[0].options.cwd, "D:/StoryCanvas");
});

test("无 envelope 非零维护失败保留 stdout/stderr，并返回安全错误", async () => {
  const calls = [];
  await assert.rejects(
    runComfyCli({
      executable: "comfy.exe",
      workspace: "D:/ComfyUI",
      args: ["update"],
      allowMissingEnvelope: true,
      spawnImpl: fakeOutputSpawn({ stdout: "partial update output", stderr: "pip failed", code: 1 }, calls),
    }),
    (error) => error?.code === "comfy_cli_invalid_output"
      && error.details?.exit_code === 1
      && error.details?.stdout === "partial update output"
      && error.details?.stderr === "pip failed",
  );
});

test("comfy-cli 超时只报告终止请求，明确后置状态未知", async () => {
  let killed = false;
  const hangingSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed = true; };
    return child;
  };
  await assert.rejects(
    runComfyCli({ executable: "comfy.exe", workspace: "D:/ComfyUI", args: ["update"], timeoutMs: 5, spawnImpl: hangingSpawn }),
    (error) => error?.code === "comfy_cli_timeout"
      && error.details?.timeout_ms === 5
      && error.details?.process_termination_requested === true
      && error.details?.post_state === "unknown",
  );
  assert.equal(killed, true);
});

test("陈旧后台记录清理只移除已验证记录并保留日志指针", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "story-canvas-comfy-cli-"));
  const configPath = path.join(directory, "config.ini");
  const expected = { host: "127.0.0.1", port: 8188, pid: 30540 };
  const original = [
    "[DEFAULT]",
    "enable_tracking = False",
    "background_log = D:\\ComfyUI\\user\\comfyui_8188.log",
    "background = ('127.0.0.1', 8188, 30540)",
    "",
  ].join("\r\n");
  await writeFile(configPath, original, "utf8");
  let inspections = 0;
  const cliRunner = async ({ args }) => {
    assert.deepEqual(args, ["env"]);
    inspections += 1;
    return {
      data: {
        config: {
          path: configPath,
          background: inspections === 1 ? expected : null,
        },
      },
    };
  };

  try {
    const result = await clearStaleComfyCliBackground({
      executable: "comfy.exe",
      workspace: "D:/ComfyUI",
      expected,
      cliRunner,
      uniqueId: () => "test",
    });
    const updated = await readFile(configPath, "utf8");
    assert.equal(result.cleared, true);
    assert.equal(inspections, 2);
    assert.match(updated, /^background_log = /m);
    assert.doesNotMatch(updated, /^background\s*=/m);
    assert.match(updated, /^enable_tracking = False$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
