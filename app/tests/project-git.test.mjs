import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerProject } from "../server/project-registry.mjs";
import { readProjectGit } from "../server/project-git.mjs";
import { handleProjectRequest } from "../server/project-http.mjs";

const exec = promisify(execFile);
async function fixture(t) {
  const tests = new URL("../../Saved/Tests/", import.meta.url);
  await mkdir(tests, { recursive: true });
  const root = await mkdtemp(path.join(fileURLToPath(tests), "project-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); await mkdir(project);
  registerProject(root, { id: "example", type: "training", path: project });
  const git = async (...args) => (await exec("git", ["-C", project, ...args], { windowsHide: true })).stdout;
  return { root, project, git };
}

test("独立项目 Git 状态支持空仓库、中文重命名、暂存和忽略文件，远程凭据不回传", async t => {
  const { root, project, git } = await fixture(t);
  assert.equal((await readProjectGit(root, "example")).status, "not_repository");
  await git("init", "-b", "main");
  let result = await readProjectGit(root, "example");
  assert.equal(result.status, "ready"); assert.equal(result.branch, "main"); assert.equal(result.commit, null);
  await writeFile(path.join(project, ".gitignore"), "/Saved/\n");
  await writeFile(path.join(project, "原 图.txt"), "reference");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
  await git("mv", "原 图.txt", "新 图.txt");
  await writeFile(path.join(project, "new.txt"), "new");
  await mkdir(path.join(project, "Saved")); await writeFile(path.join(project, "Saved", "cache"), "ignored");
  await git("remote", "add", "origin", "https://user:secret@example.com/project.git?token=secret");
  result = await readProjectGit(root, "example");
  assert.equal(result.dirty, true); assert.equal(result.changes.length, 2);
  assert.deepEqual(result.changes.find(item => item.status === "R."), { status: "R.", path: "新 图.txt", original_path: "原 图.txt" });
  assert.deepEqual(result.changes.find(item => item.status === "??"), { status: "??", path: "new.txt" });
  assert.equal(result.remotes[0].url, "https://example.com/project.git");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  await git("checkout", "--detach");
  assert.equal((await readProjectGit(root, "example")).branch, "(detached)");
});

test("不向上读取工具仓库；缺失路径和未登记项目明确区分", async t => {
  const { root, project } = await fixture(t);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  assert.equal((await readProjectGit(root, "example")).status, "not_repository");
  await rename(project, `${project}-moved`);
  assert.equal((await readProjectGit(root, "example")).status, "unavailable");
  await assert.rejects(readProjectGit(root, "missing"), { code: "project_not_registered" });
});

test("共用 HTTP 只读接口与本地 upstream 计数，不 fetch 远程", async t => {
  const { root, project, git } = await fixture(t);
  const remote = path.join(root, "remote.git");
  await exec("git", ["init", "--bare", remote]);
  await git("init", "-b", "main");
  await writeFile(path.join(project, "a"), "one"); await git("add", ".");
  const commit = () => git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-am", "change");
  await commit(); await git("remote", "add", "origin", remote); await git("push", "-u", "origin", "main");
  await writeFile(path.join(project, "a"), "two"); await commit();
  await rename(remote, `${remote}-offline`);
  let body;
  const response = { writeHead(code) { assert.equal(code, 200); }, end(value) { body = JSON.parse(value); } };
  assert.equal(await handleProjectRequest({ request: { method: "GET" }, response, decodedPath: "/api/project-library/example/git", projectRoot: root }), true);
  assert.equal(body.upstream, "origin/main"); assert.equal(body.ahead, 1); assert.equal(body.behind, 0); assert.equal(body.dirty, false);
});
