import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readProjectRegistry } from "./project-registry.mjs";
import { ProjectContractError } from "./project-contracts.mjs";

const exec = promisify(execFile);

function remoteAddress(value) {
  // 不向页面或 Agent 回传 URL 中可能内嵌的凭据。
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return { url: url.href, web_url: ["https:", "http:"].includes(url.protocol) ? url.href.replace(/\.git$/, "") : null };
  } catch {
    const ssh = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
    return { url: value, web_url: ssh && !path.isAbsolute(value) ? `https://${ssh[1]}/${ssh[2].replace(/\.git$/, "")}` : null };
  }
}

export async function readProjectGit(repositoryRoot, id) {
  const entry = readProjectRegistry(repositoryRoot).find(item => item.id === id);
  if (!entry) throw new ProjectContractError(404, "project_not_registered");
  const base = { project_id: id, path: entry.path };
  try {
    await lstat(entry.path);
  } catch { return { ...base, status: "unavailable", message: "项目路径不可用" }; }
  try {
    // 不向上发现仓库；支持独立仓库与 .git 文件形式的 worktree。
    await lstat(path.join(entry.path, ".git"));
  } catch (error) {
    return { ...base, status: error.code === "ENOENT" ? "not_repository" : "unavailable", message: error.code === "ENOENT" ? "未初始化 Git" : "无法读取 Git 目录" };
  }
  const git = async args => (await exec("git", ["--no-optional-locks", "-C", entry.path, ...args], {
    windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0" },
  })).stdout;
  try {
    const root = (await git(["rev-parse", "--show-toplevel"])).trim();
    if (await realpath(root) !== await realpath(entry.path)) return { ...base, status: "unavailable", message: "Git 根目录与项目目录不一致" };
    const output = await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    let branch = null, commit = null, upstream = null, ahead = null, behind = null;
    const changes = [], records = output.split("\0");
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (record.startsWith("# branch.head ")) branch = record.slice(14);
      else if (record.startsWith("# branch.oid ")) commit = record.slice(13) === "(initial)" ? null : record.slice(13);
      else if (record.startsWith("# branch.upstream ")) upstream = record.slice(18);
      else if (record.startsWith("# branch.ab ")) { const match = /\+(\d+) -(\d+)/.exec(record); if (match) { ahead = Number(match[1]); behind = Number(match[2]); } }
      else if (record.startsWith("? ")) changes.push({ status: "??", path: record.slice(2) });
      else if (/^[12u] /.test(record)) {
        const fields = record.split(" ");
        const offset = record[0] === "1" ? 8 : record[0] === "2" ? 9 : 10;
        changes.push({ status: fields[1], path: fields.slice(offset).join(" "), ...(record[0] === "2" ? { original_path: records[++index] } : {}) });
      }
    }
    const names = (await git(["remote"])).trim().split(/\r?\n/).filter(Boolean);
    const remotes = await Promise.all(names.map(async name => ({ name, ...remoteAddress((await git(["remote", "get-url", name])).trim()) })));
    return { ...base, status: "ready", branch, commit, upstream, ahead, behind, dirty: changes.length > 0, changes, remotes };
  } catch (error) {
    return { ...base, status: "unavailable", message: error.code === "ENOENT" ? "本机未找到 Git" : "Git 状态读取失败，请通过本机 Git 检查目录或重试" };
  }
}
