import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  comfyLaunchRecordMatchesProcessChain,
  comfyProcessError,
  createComfyRuntimeController,
} from "../server/comfy-runtime.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function controllerFixture(overrides = {}) {
  const projectRoot = path.resolve("runtime-test-project");
  const comfyuiRoot = path.join(projectRoot, "Saved", "comfyui");
  const config = {
    comfyui_urls: ["http://127.0.0.1:8188"],
    comfyui_root: comfyuiRoot,
    comfy_cli: path.join(projectRoot, "tools", "comfy.exe"),
  };
  return {
    projectRoot,
    comfyuiRoot,
    config,
    controller: createComfyRuntimeController({ projectRoot, config, ...overrides }),
  };
}

test("install admission depends only on the target Comfy workspace state", async () => {
  const cliCalls = [];
  const processReader = async () => { throw comfyProcessError("listener_not_found"); };
  const workspaceInspector = async () => ({ status: "installed", markers: ["main.py", "comfy", "nodes.py", "comfy_api"] });
  let comfyuiRoot;
  const cliRunner = async (request) => {
    cliCalls.push(request.args);
    if (request.args[0] === "which") return { data: { workspace_path: comfyuiRoot } };
    return { data: { output: "installed" } };
  };
  const fixture = controllerFixture({ processReader, workspaceInspector, cliRunner });
  comfyuiRoot = fixture.comfyuiRoot;

  const result = await fixture.controller.install({ device: "cpu" });

  assert.equal(result.status, "installed");
  assert.equal(result.restored, true);
  assert.deepEqual(cliCalls[0], ["install", "--restore", "--skip-manager", "--cpu"]);
});

test("start, stop, install and update share one controller-local operation lock", async () => {
  const update = deferred();
  let comfyuiRoot;
  const cliRunner = async ({ args }) => {
    if (args[0] === "which") return { data: { workspace_path: comfyuiRoot } };
    if (args[0] === "update") return update.promise;
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const fixture = controllerFixture({
    processReader: async () => { throw comfyProcessError("listener_not_found"); },
    cliRunner,
  });
  comfyuiRoot = fixture.comfyuiRoot;

  const runningUpdate = fixture.controller.update();
  await flushPromises();
  await assert.rejects(
    fixture.controller.start(),
    (error) => error?.code === "comfyui_operation_in_progress",
  );
  update.resolve({ data: { output: "updated" } });
  assert.equal((await runningUpdate).status, "updated");
});

test("maintenance refuses a running Comfy instance even when its own queue is empty", async () => {
  let cliCalls = 0;
  const fixture = controllerFixture({
    processReader: async () => ({ pid: 42 }),
    queueReader: async () => ({ running: 0, pending: 0 }),
    cliRunner: async () => { cliCalls += 1; return { data: {} }; },
  });

  await assert.rejects(fixture.controller.update(), (error) => error?.code === "comfyui_running");
  assert.equal(cliCalls, 0, "no maintenance command may run while Comfy is alive");
});

test("stop refuses a non-empty Comfy queue before dry-run or stopper", async () => {
  const cliCalls = [];
  let stoppedPid = null;
  let comfyuiRoot;
  const fixture = controllerFixture({
    processReader: async () => ({ pid: 42 }),
    queueReader: async () => ({ running: 1, pending: 2 }),
    cliRunner: async ({ args }) => {
      cliCalls.push(args);
      return { data: { workspace_path: comfyuiRoot } };
    },
    stopper: async (pid) => { stoppedPid = pid; },
  });
  comfyuiRoot = fixture.comfyuiRoot;

  await assert.rejects(
    fixture.controller.stop(),
    (error) => error?.code === "comfyui_queue_busy" && error.details?.[0]?.includes("3"),
  );
  assert.deepEqual(cliCalls, [["which"]]);
  assert.equal(stoppedPid, null);
});

test("stop does not invoke the stopper when comfy-cli identity evidence disagrees", async () => {
  let stoppedPid = null;
  let comfyuiRoot;
  const fixture = controllerFixture({
    processReader: async () => ({ pid: 42, process_chain: [] }),
    queueReader: async () => ({ running: 0, pending: 0 }),
    cliRunner: async ({ args }) => {
      if (args[0] === "which") return { data: { workspace_path: comfyuiRoot } };
      if (args.join(" ") === "stop --dry-run") return { data: { dry_run: true, host: "127.0.0.1", port: 9999, pid: 42 } };
      return { data: { dry_run: true, verified: true, untracked: true, port: 8188, pid: 42, cwd: comfyuiRoot } };
    },
    stopper: async (pid) => { stoppedPid = pid; },
  });
  comfyuiRoot = fixture.comfyuiRoot;

  await assert.rejects(fixture.controller.stop(), (error) => error?.code === "comfyui_stop_target_mismatch");
  assert.equal(stoppedPid, null);
});

test("a recorded comfy-cli launcher is accepted only from the configured process chain and workspace", () => {
  const root = path.resolve("runtime-test-project", "Saved", "comfyui");
  const processInfo = {
    pid: 42,
    process_chain: [{
      pid: 7,
      command_line: `comfy --workspace="${root}" launch --background`,
    }],
  };

  assert.equal(comfyLaunchRecordMatchesProcessChain(processInfo, 7, root), true);
  assert.equal(comfyLaunchRecordMatchesProcessChain(processInfo, 7, path.resolve("another-workspace")), false);
});

test("start clears a reused unrelated background pid and retries launch once", async () => {
  let comfyuiRoot;
  let launched = false;
  let launchCalls = 0;
  let cleaned = null;
  const cliRunner = async ({ args }) => {
    if (args[0] === "which") return { data: { workspace_path: comfyuiRoot } };
    if (args.join(" ") === "stop --dry-run") {
      return { data: { dry_run: true, untracked: false, host: "127.0.0.1", port: 8188, pid: 30540 } };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const fixture = controllerFixture({
    processReader: async () => {
      if (launched) return { pid: 42, version: "test" };
      throw comfyProcessError("listener_not_found");
    },
    launcher: async () => {
      launchCalls += 1;
      if (launchCalls === 1) {
        throw Object.assign(new Error("already running"), { code: "comfy_cli_server_already_running" });
      }
      launched = true;
    },
    recordedProcessReader: async () => ({
      pid: 30540,
      process_chain: [{ pid: 30540, executable: "C:/Program Files/Codex/ChatGPT.exe", command_line: "ChatGPT.exe" }],
    }),
    backgroundRecordCleaner: async (request) => { cleaned = request.expected; return { cleared: true }; },
    cliRunner,
  });
  comfyuiRoot = fixture.comfyuiRoot;

  const result = await fixture.controller.start();

  assert.equal(result.status, "running");
  assert.equal(result.already_running, false);
  assert.equal(launchCalls, 2);
  assert.deepEqual(cleaned, { host: "127.0.0.1", port: 8188, pid: 30540 });
});

test("start does not clear a background record that still belongs to the configured launcher", async () => {
  let comfyuiRoot;
  let cleanerCalls = 0;
  const fixture = controllerFixture({
    processReader: async () => { throw comfyProcessError("listener_not_found"); },
    launcher: async () => {
      throw Object.assign(new Error("already running"), { code: "comfy_cli_server_already_running" });
    },
    recordedProcessReader: async () => ({
      pid: 30540,
      process_chain: [{ pid: 30540, command_line: `comfy --workspace="${comfyuiRoot}" launch --background` }],
    }),
    backgroundRecordCleaner: async () => { cleanerCalls += 1; },
    cliRunner: async ({ args }) => {
      if (args[0] === "which") return { data: { workspace_path: comfyuiRoot } };
      return { data: { dry_run: true, untracked: false, host: "127.0.0.1", port: 8188, pid: 30540 } };
    },
  });
  comfyuiRoot = fixture.comfyuiRoot;

  await assert.rejects(
    fixture.controller.start(),
    (error) => error?.code === "comfyui_start_in_progress",
  );
  assert.equal(cleanerCalls, 0);
});
