import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectContractError, requireProjectDirectoryName } from "./project-contracts.mjs";

// 登记只保存定位信息；标题、素材与配置属于项目自身。同步读写避免单服务内丢失登记。
export function readProjectRegistry(repositoryRoot) {
  const file = path.join(repositoryRoot, "Config", "projects.json");
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || !Array.isArray(value.projects)) throw new ProjectContractError(422, "invalid_project_registry");
  const ids = new Set();
  const paths = new Set();
  for (const entry of value.projects) {
    requireProjectDirectoryName(entry.id);
    if (!["story", "training"].includes(entry.type) || !path.isAbsolute(entry.path) || typeof entry.temporary !== "boolean") throw new ProjectContractError(422, "invalid_project_registry");
    const key = process.platform === "win32" ? path.resolve(entry.path).toLowerCase() : path.resolve(entry.path);
    if (ids.has(entry.id) || paths.has(key)) throw new ProjectContractError(422, "duplicate_project_registration");
    ids.add(entry.id); paths.add(key);
  }
  return value.projects;
}

function saveRegistry(repositoryRoot, projects) {
  const file = path.join(repositoryRoot, "Config", "projects.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, projects }, null, 2) + "\n", { flag: "wx" });
  renameSync(temporary, file);
}

export function registeredProjectPath(repositoryRoot, id, type = "story") {
  requireProjectDirectoryName(id);
  const entry = readProjectRegistry(repositoryRoot).find(item => item.id === id && item.type === type);
  if (!entry) throw new ProjectContractError(404, "project_not_registered", [id]);
  return path.resolve(entry.path);
}

export function listRegisteredProjects(repositoryRoot, type) {
  return readProjectRegistry(repositoryRoot).filter(entry => !type || entry.type === type).map(entry => {
    let available = false;
    try { const info = lstatSync(entry.path); available = info.isDirectory() && !info.isSymbolicLink(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { ...entry, available };
  });
}

export function registerProject(repositoryRoot, { id, type, path: directory, temporary = false }) {
  requireProjectDirectoryName(id);
  if (!["story", "training"].includes(type) || !path.isAbsolute(directory)) throw new ProjectContractError(422, "invalid_project_registration");
  const target = path.resolve(directory);
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectContractError(422, "invalid_project_directory");
  const entry = { id, type, path: target, temporary: Boolean(temporary) };
  const entries = readProjectRegistry(repositoryRoot);
  const key = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (entries.some(item => item.id !== id && key(path.resolve(item.path)) === key(target))) throw new ProjectContractError(409, "project_path_registered");
  const existing = entries.find(item => item.id === id);
  if (existing && existing.type !== type) throw new ProjectContractError(409, "project_id_registered");
  saveRegistry(repositoryRoot, [...entries.filter(item => item.id !== id), entry]);
  return entry;
}

export function unregisterProject(repositoryRoot, id) {
  saveRegistry(repositoryRoot, readProjectRegistry(repositoryRoot).filter(entry => entry.id !== id));
  return { removed: id };
}
