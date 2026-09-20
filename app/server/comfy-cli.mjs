import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const COMFY_CLI_DEFAULT_TIMEOUT_MS = 120_000;
export const COMFY_CLI_MAINTENANCE_TIMEOUT_MS = 30 * 60 * 1000;
export const COMFY_CLI_INSTALL_TIMEOUT_MS = 90 * 60 * 1000;

export class ComfyCliError extends Error {
  constructor(code, message, { details = null, status = 409, envelope = null } = {}) {
    super(message || code);
    this.name = "ComfyCliError";
    this.code = code;
    this.details = details;
    this.status = status;
    this.envelope = envelope;
  }
}

function cliEnvironment(executable) {
  const cliDirectory = path.dirname(path.resolve(executable));
  const currentPath = process.env.PATH ?? process.env.Path ?? "";
  const pathKey = process.platform === "win32" && process.env.Path && !process.env.PATH ? "Path" : "PATH";
  return {
    ...process.env,
    [pathKey]: [cliDirectory, currentPath].filter(Boolean).join(path.delimiter),
  };
}

function parseEnvelope(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && value.schema === "envelope/1" && typeof value.ok === "boolean") return value;
    } catch {
      // Side messages are allowed in stdout by older CLI builds; keep looking for the envelope.
    }
  }
  return null;
}

function normalizedHost(value) {
  return String(value ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function parseBackgroundLine(line) {
  const match = /^\s*background\s*=\s*\(\s*(['"])(.*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*$/i.exec(line);
  if (!match) return null;
  return { host: match[2], port: Number(match[3]), pid: Number(match[4]) };
}

function sameBackgroundRecord(left, right) {
  return normalizedHost(left?.host) === normalizedHost(right?.host)
    && Number(left?.port) === Number(right?.port)
    && Number(left?.pid) === Number(right?.pid);
}

/**
 * Remove one exact stale comfy-cli background record without stopping any PID.
 * The CLI has no public "forget" command, so discover its config through
 * `comfy env`, verify the record twice, preserve the logfile pointer, and
 * replace the small INI file atomically.
 */
export async function clearStaleComfyCliBackground({
  executable,
  workspace,
  expected,
  cliRunner = runComfyCli,
  uniqueId = randomUUID,
} = {}) {
  const inspect = () => cliRunner({ executable, workspace, args: ["env"] });
  const before = await inspect();
  const config = before?.data?.config;
  if (!config?.background) return { cleared: false, reason: "absent" };
  if (!sameBackgroundRecord(config.background, expected)) {
    throw new ComfyCliError("comfy_cli_background_changed", "comfy-cli 后台记录已变化，未执行清理", {
      details: { expected, actual: config.background },
    });
  }
  if (typeof config.path !== "string" || !path.isAbsolute(config.path)) {
    throw new ComfyCliError("comfy_cli_config_unverified", "comfy-cli 未返回可信的配置文件路径");
  }

  const configPath = path.resolve(config.path);
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ComfyCliError("comfy_cli_config_unverified", "comfy-cli 配置不是普通文件，未执行清理");
  }
  const original = await readFile(configPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const matches = lines
    .map((line, index) => ({ index, record: parseBackgroundLine(line) }))
    .filter((item) => item.record);
  if (matches.length !== 1 || !sameBackgroundRecord(matches[0].record, expected)) {
    throw new ComfyCliError("comfy_cli_config_unverified", "comfy-cli 配置中的后台记录与已验证状态不一致，未执行清理");
  }
  lines.splice(matches[0].index, 1);
  const updated = lines.join(newline);
  const temporary = `${configPath}.${process.pid}.${uniqueId()}.tmp`;
  try {
    await writeFile(temporary, updated, { encoding: "utf8", flag: "wx" });
    if (await readFile(configPath, "utf8") !== original) {
      throw new ComfyCliError("comfy_cli_background_changed", "comfy-cli 配置在清理前发生变化，未执行覆盖");
    }
    await rename(temporary, configPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }

  const after = await inspect();
  if (after?.data?.config?.background) {
    throw new ComfyCliError("comfy_cli_background_cleanup_failed", "comfy-cli 陈旧后台记录清理后仍然存在");
  }
  return { cleared: true, config_path: configPath };
}

export function runComfyCli({ executable, workspace, args = [], cwd = workspace, timeoutMs = COMFY_CLI_DEFAULT_TIMEOUT_MS, allowMissingEnvelope = false, spawnImpl = spawn } = {}) {
  if (typeof executable !== "string" || !executable.trim()) {
    throw new ComfyCliError("comfy_cli_not_configured", "请先在本机配置 comfy_cli", { status: 422 });
  }
  if (typeof workspace !== "string" || !workspace.trim()) {
    throw new ComfyCliError("comfyui_root_not_configured", "请先在本机配置 comfyui_root（comfy-cli workspace）", { status: 422 });
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;
    let child;
    try {
      child = spawnImpl(executable, ["--json", "--workspace", workspace, ...args], {
        cwd,
        env: cliEnvironment(executable),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new ComfyCliError("comfy_cli_spawn_failed", error?.message ?? "comfy-cli 启动失败", { details: null }));
      return;
    }
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(() => reject(new ComfyCliError(
      error?.code === "ENOENT" ? "comfy_cli_not_found" : "comfy_cli_spawn_failed",
      error?.message ?? "comfy-cli 启动失败",
      { details: { stderr: stderr.trim() }, status: error?.code === "ENOENT" ? 422 : 409 },
    ))));
    child.once("close", (code, signal) => finish(() => {
      const envelope = parseEnvelope(stdout);
      if (envelope) {
        if (envelope.ok) {
          resolve(envelope);
          return;
        }
        const cliError = envelope.error ?? {};
        reject(new ComfyCliError(
          `comfy_cli_${String(cliError.code ?? "command_failed")}`,
          String(cliError.message ?? "comfy-cli 命令失败"),
          { details: { ...cliError, stdout: stdout.trim() || null, stderr: stderr.trim() || null }, envelope },
        ));
        return;
      }
      const output = { stdout: stdout.trim() || null, stderr: stderr.trim() || null };
      if (code === 0 && allowMissingEnvelope) {
        resolve({
          schema: "envelope/1",
          type: "envelope",
          ok: true,
          command: args[0] ?? null,
          version: null,
          where: null,
          data: { output, envelope: false },
          error: null,
        });
        return;
      }
      reject(new ComfyCliError("comfy_cli_invalid_output", "comfy-cli 未返回有效 JSON envelope", {
        details: { exit_code: code, signal, ...output },
      }));
    }));
    timeout = setTimeout(() => finish(() => {
      let terminationError = null;
      let terminationRequested = false;
      try {
        child.kill();
        terminationRequested = true;
      } catch (error) {
        terminationError = error?.message ?? String(error);
      }
      reject(new ComfyCliError("comfy_cli_timeout", "comfy-cli 命令超时，后置状态未知", {
        details: {
          timeout_ms: timeoutMs,
          process_termination_requested: terminationRequested,
          post_state: "unknown",
          termination_error: terminationError,
          stdout: stdout.trim() || null,
          stderr: stderr.trim() || null,
        },
      }));
    }), timeoutMs);
  });
}
