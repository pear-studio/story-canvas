import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, link, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const recordPath = (root, role) => path.join(root, "Saved", `workbench-${role}.json`);
let ownIdentity;

// PID 与操作系统启动身份一起比较，不能误杀复用 PID 的其他进程。
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && ownIdentity !== undefined) return ownIdentity;
  try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return null; throw error; }
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){$p.CreationDate.ToUniversalTime().Ticks.ToString()}`], { windowsHide: true, timeout: 5000 });
    const identity = stdout.trim() || null;
    if (pid === process.pid) ownIdentity = identity;
    return identity;
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const identity = fields[0] === "Z" ? null : fields[19];
    if (pid === process.pid) ownIdentity = identity;
    return identity;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

export async function readInstance(root, role) {
  try { return JSON.parse(await readFile(recordPath(root, role), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function instanceAlive(record) {
  return Boolean(record && await processIdentity(record.pid) === record.identity);
}

async function removeRecord(root, role, record) {
  if ((await readInstance(root, role))?.token === record.token) {
    await unlink(recordPath(root, role)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function claimInstance(root, role, extra = {}) {
  await mkdir(path.join(root, "Saved"), { recursive: true });
  const record = { pid: process.pid, identity: await processIdentity(process.pid), token: randomUUID(), ...extra };
  const staged = `${recordPath(root, role)}.${record.token}.tmp`;
  await writeFile(staged, JSON.stringify(record), { flag: "wx" });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await link(staged, recordPath(root, role)); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const current = await readInstance(root, role);
        if (await instanceAlive(current)) throw new Error("本仓库已有工作台实例，请通过启动脚本替换旧服务。");
        if (current) await removeRecord(root, role, current);
        continue;
      }
      return { record, release: () => removeRecord(root, role, record) };
    }
    throw new Error("工作台实例正在切换，请稍后重新启动。");
  } finally { await unlink(staged); }
}

async function descendants(record) {
  if (process.platform === "win32" || !await instanceAlive(record)) return [];
  const processes = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.push({ pid: Number(entry), parent: Number(fields[1]), identity: fields[19] });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  const result = [];
  function collect(pid) { for (const child of processes.filter(p => p.parent === pid)) { collect(child.pid); result.push(child); } }
  collect(record.pid);
  return result;
}

export async function killInstance(record, { force = false } = {}) {
  if (!await instanceAlive(record)) return;
  if (process.platform === "win32") {
    await exec("taskkill.exe", ["/PID", String(record.pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true, timeout: 5000 });
  } else {
    try { process.kill(record.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

export async function replaceWorkbench(root) {
  const launcher = await readInstance(root, "launcher");
  const server = await readInstance(root, "server");
  const children = launcher ? await descendants(launcher) : [];
  if (await instanceAlive(server)) {
    // 先让服务完成关闭钩子；无响应时才走进程终止兜底。
    await fetch(`http://127.0.0.1:${server.port}/api/workbench/shutdown`, {
      method: "POST", headers: { "x-workbench-token": server.token }, signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  }
  for (const [role, record] of [["launcher", launcher], ["server", server]]) {
    if (!record) continue;
    // Windows 控制台进程用上面的 HTTP 入口正常关闭；随后结束监听父进程。
    await killInstance(record, { force: process.platform === "win32" }).catch(() => undefined);
    const deadline = Date.now() + 5000;
    while (await instanceAlive(record) && Date.now() < deadline) await delay(100);
    if (await instanceAlive(record)) await killInstance(record, { force: true });
    if (await instanceAlive(record)) {
      const deadline = Date.now() + 3000;
      while (await instanceAlive(record) && Date.now() < deadline) await delay(100);
    }
    if (await instanceAlive(record)) throw new Error("旧工作台未退出，无法启动新实例。");
    await removeRecord(root, role, record);
  }
  // Linux 监听器使用独立进程组；即使旧启动器异常退出，也收束本轮已核实的子进程。
  for (const child of children) await killInstance(child, { force: true });
}
