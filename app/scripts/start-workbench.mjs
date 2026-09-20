import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimInstance, instanceAlive, readInstance, replaceWorkbench } from "../server/workbench-instance.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.dirname(appRoot);
const mode = process.argv[2];
if (!["dev", "production"].includes(mode)) throw new Error("启动模式必须是 dev 或 production");
if (process.argv.includes("--replace")) await replaceWorkbench(root);
const existingServer = await readInstance(root, "server");
if (await instanceAlive(existingServer)) throw new Error("本仓库已有工作台服务，请通过启动脚本替换。");
const instance = await claimInstance(root, "launcher");
let child;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise(resolve => killer.once("exit", resolve));
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { } }, 5000);
      await new Promise(resolve => child.once("exit", resolve));
      clearTimeout(timer);
    }
  }
  await instance.release();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
async function run(args) {
  child = spawn(process.execPath, args, {
    cwd: appRoot, stdio: "inherit", detached: process.platform !== "win32",
    env: { ...process.env, STORYVIS_LAUNCHER_TOKEN: instance.record.token }
  });
  return await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
}
try {
  if (mode === "production" && process.argv.includes("--build")) {
    const code = await run([path.join(appRoot, "node_modules/vite/bin/vite.js"), "build"]);
    if (code !== 0) throw new Error(`前端构建失败（${code}）`);
  }
  if (!stopping) process.exitCode = await run(mode === "dev"
    // 限定监听 server/ 与 shared/：裸 --watch 在 Linux 会把仓库 runtime/ 的实例记录写入、
    // Vite 运行时导入的临时配置也纳入监听，写入实例记录会触发无限重启。
    ? ['--watch-path=' + path.join(appRoot, 'server'), '--watch-path=' + path.join(appRoot, 'shared'), path.join(appRoot, "server/index.mjs")]
    : [path.join(appRoot, "server/index.mjs"), "--production"]);
} finally { await stop(); }
