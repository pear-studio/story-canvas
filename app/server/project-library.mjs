import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { registerProject, unregisterProject, listRegisteredProjects, readProjectRegistry } from "./project-registry.mjs";
import { requireIdleProject, copyProject } from "./project-management.mjs";
import { ProjectContractError } from "./project-contracts.mjs";

const fail = (code, status = 409) => { throw new ProjectContractError(status, code); };
const exists = target => lstat(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const gitignore = "/Saved/\n/Outputs/\n/Training/\n*.safetensors\n*.npz\n";

export function projectLibrary(repositoryRoot) { return { projects: listRegisteredProjects(repositoryRoot).map(entry => { let title = entry.id; if (entry.available) { try { const facts = JSON.parse(readFileSync(path.join(entry.path, "project.json"), "utf8")); title = facts.title ?? facts.name ?? title; } catch {} } return { ...entry, title }; }) }; }

export async function openProjectDirectory(repositoryRoot, directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("absolute_project_path_required", 422);
  const target = path.resolve(directory);
  const prior = readProjectRegistry(repositoryRoot).find(entry => path.resolve(entry.path).toLowerCase() === target.toLowerCase());
  if (prior) return prior;
  const facts = JSON.parse(await readFile(path.join(target, "project.json"), "utf8"));
  const type = Array.isArray(facts.groups) && Array.isArray(facts.items) ? "training" : typeof facts.title === "string" ? "story" : null;
  if (!type) fail("invalid_project_manifest", 422);
  if (type === "training" && !await exists(path.join(target, "settings.json"))) fail("training_settings_missing", 422);
  const id = type === "training" ? `dataset-${randomBytes(6).toString("hex")}` : path.basename(target);
  if (readProjectRegistry(repositoryRoot).some(entry => entry.id === id)) fail("project_id_registered");
  return registerProject(repositoryRoot, { id, type, path: target, temporary: false });
}

async function requireIdle(entry) {
  if (entry.type === "story") return requireIdleProject(entry.path);
  const walk = async directory => {
    const { readdir } = await import("node:fs/promises");
    for (const item of await readdir(directory, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.name === "status.json") {
        const state = JSON.parse(await readFile(file, "utf8"));
        if (["starting", "running", "stopping"].includes(state.status)) fail("project_has_active_tasks");
      }
    }
  };
  await walk(path.join(entry.path, "Saved", "Training"));
}

let pending = Promise.resolve();
export function manageRegisteredProject(repositoryRoot, id, action, input = {}) {
  const result = pending.then(() => manageProject(repositoryRoot, id, action, input));
  pending = result.catch(() => undefined);
  return result;
}
async function fileInventory(directory) {
  const entries = [];
  async function walk(root) {
    for (const item of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, item.name);
      if (item.isSymbolicLink()) fail("project_link_not_supported", 422);
      if (item.isDirectory()) await walk(file);
      else entries.push([path.relative(directory, file), createHash("sha256").update(await readFile(file)).digest("hex")]);
    }
  }
  await walk(directory); return JSON.stringify(entries.sort((a,b) => a[0].localeCompare(b[0])));
}
async function manageProject(repositoryRoot, id, action, input) {
  const entry = readProjectRegistry(repositoryRoot).find(item => item.id === id);
  if (!entry) fail("project_not_registered", 404);
  if (action === "forget") return unregisterProject(repositoryRoot, id);
  if (action === "relocate") {
    const facts = JSON.parse(await readFile(path.join(input.path, "project.json"), "utf8"));
    if ((entry.type === "training") !== (Array.isArray(facts.groups) && Array.isArray(facts.items))) fail("project_type_mismatch", 422);
    return registerProject(repositoryRoot, { ...entry, path: input.path });
  }
  await requireIdle(entry);
  if (action === "copy") {
    if (entry.type === "story") { const copy = await copyProject(repositoryRoot, id); return readProjectRegistry(repositoryRoot).find(item => item.id === copy.id); }
    const nextId = `dataset-${randomBytes(6).toString("hex")}`;
    const directory = path.join(repositoryRoot, "workspace", nextId);
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory, { recursive: false });
    for (const name of ["project.json", "settings.json", "assets", "captioning", "References"]) {
      const source = path.join(entry.path, name);
      if (await exists(source)) await cp(source, path.join(directory, name), { recursive: true, dereference: false, errorOnExist: true });
    }
    await writeFile(path.join(directory, ".gitignore"), gitignore);
    return registerProject(repositoryRoot, { id: nextId, type: "training", path: directory, temporary: true });
  }
  if (!["promote", "delete"].includes(action) || !entry.temporary) fail("temporary_project_required", 422);
  // 只允许工作台拥有的 workspace 直接子目录接受临时项目删除／提升。
  if (path.dirname(path.resolve(entry.path)) !== path.join(path.resolve(repositoryRoot), "workspace")) fail("temporary_project_outside_workspace", 422);
  if (action === "delete") {
    await rm(entry.path, { recursive: true });
    return unregisterProject(repositoryRoot, id);
  }
  if (typeof input.path !== "string" || !path.isAbsolute(input.path)) fail("absolute_project_path_required", 422);
  const destination = path.resolve(input.path);
  const relative = path.relative(entry.path, destination);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) fail("destination_inside_project", 422);
  if (await exists(destination)) fail("project_already_exists");
  await mkdir(path.dirname(destination), { recursive: true });
  // 跨磁盘提升也保留全部成果；复制成功才移除原目录。
  await cp(entry.path, destination, { recursive: true, errorOnExist: true, force: false });
  if (await fileInventory(entry.path) !== await fileInventory(destination)) fail("project_copy_verification_failed");
  await promisify(execFile)("git", ["init", "-b", "main"], { cwd: destination, windowsHide: true });
  const saved = registerProject(repositoryRoot, { ...entry, path: destination, temporary: false });
  await rm(entry.path, { recursive: true });
  return saved;
}
