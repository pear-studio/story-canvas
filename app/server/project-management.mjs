import { registeredProjectPath, listRegisteredProjects, registerProject, unregisterProject, readProjectRegistry } from "./project-registry.mjs";
import { projectFactDirectories, projectSettingFiles } from "./project-storage-layout.mjs";
import { listFinishedJobs } from "./finished-jobs.mjs";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ProjectContractError, requireProjectDirectoryName } from "./project-contracts.mjs";
import { listActiveProjectTaskIds } from "./render-task-storage.mjs";

export { listActiveProjectTaskIds } from "./render-task-storage.mjs";



async function pathExists(target) {
  try { await lstat(target); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function requirePlainDirectory(target, notFoundCode = "project_not_found") {
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectContractError(409, "unsafe_project_directory");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ProjectContractError(404, notFoundCode);
    throw error;
  }
  return target;
}

async function copyPlainTree(source, destination, { skip = () => false } = {}) {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) throw new ProjectContractError(409, "unsafe_project_content", [path.basename(source)]);
  if (sourceInfo.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return;
  }
  if (!sourceInfo.isDirectory()) throw new ProjectContractError(409, "unsupported_project_content", [path.basename(source)]);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (skip(entry.name) || entry.name === ".git" || /^(?:config\.local\.json|\.env.*)$|\.(?:pem|key|safetensors|ckpt|pt|pth|bin|gguf)$/i.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new ProjectContractError(409, "unsafe_project_content", [path.join(source, entry.name)]);
    await copyPlainTree(path.join(source, entry.name), path.join(destination, entry.name), { skip });
  }
}

async function readJsonOptional(target) {
  try { return JSON.parse(await readFile(target, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function requireIdleProject(projectDirectory) {
  if ((await listFinishedJobs(projectDirectory)).some(job => ["queued", "upscaling", "lettering", "publishing"].includes(job.status))) throw new ProjectContractError(409, "project_has_active_tasks");
  const taskIds = await listActiveProjectTaskIds(projectDirectory);
  if (taskIds.length) throw new ProjectContractError(409, "project_has_active_tasks", taskIds);
  for (const scope of ["comparisons"]) {
    const root = path.join(projectDirectory, "Saved", scope);
    const scan = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
        if (entry.isSymbolicLink()) throw new ProjectContractError(409, "unsafe_project_content");
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(target);
        else if (entry.name === "status.json") {
          const value = await readJsonOptional(target);
          if (["queued", "running", "paused", "starting", "stopping"].includes(value?.status)) throw new ProjectContractError(409, "project_has_active_tasks", [target]);
        }
      }
    };
    await scan(root);
  }
}

async function nextCopyDestination(workspaceRoot, sourceId, registeredIds) {
  for (let copyNumber = 1; copyNumber < 10000; copyNumber += 1) {
    const id = `${sourceId}_${copyNumber}`;
    if (id.length > 80) throw new ProjectContractError(422, "copy_project_id_too_long");
    if (!registeredIds.has(id) && !(await pathExists(path.join(workspaceRoot, id)))) return { id, copyNumber };
  }
  throw new ProjectContractError(409, "copy_project_id_exhausted");
}

export async function copyProject(projectRoot, projectId) {
  const sourceId = requireProjectDirectoryName(projectId);
  const workspaceRoot = path.join(path.resolve(projectRoot), "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const sourceDirectory = await requirePlainDirectory(registeredProjectPath(projectRoot, sourceId));
  await requireIdleProject(sourceDirectory);
  const { id, copyNumber } = await nextCopyDestination(workspaceRoot, sourceId, new Set(readProjectRegistry(projectRoot).map(entry => entry.id)));
  const destinationDirectory = path.join(workspaceRoot, id);
  const stagingDirectory = path.join(workspaceRoot, `.copy-${randomUUID()}`);
  if (!isWithin(workspaceRoot, stagingDirectory) || path.dirname(stagingDirectory) !== workspaceRoot) throw new ProjectContractError(500, "unsafe_copy_staging_path");
  try {
    await mkdir(stagingDirectory, { recursive: false });
    for (const directory of projectFactDirectories) {
      const source = path.join(sourceDirectory, directory);
      if (await pathExists(source)) await copyPlainTree(source, path.join(stagingDirectory, directory));
    }
    for (const filename of projectSettingFiles.filter((name) => name !== "project.json")) {
      const source = path.join(sourceDirectory, filename);
      if (await pathExists(source)) await copyPlainTree(source, path.join(stagingDirectory, filename));
    }
    const project = await readJsonOptional(path.join(sourceDirectory, "project.json"));
    if (!project) throw new ProjectContractError(422, "project_manifest_not_found");
    const nextProject = { ...project, title: `${String(project.title ?? sourceId)}（副本 ${copyNumber}）` };
    delete nextProject.id;
    await writeFile(path.join(stagingDirectory, "project.json"), `${JSON.stringify(nextProject, null, 2)}\n`, "utf8");
    if (await pathExists(destinationDirectory)) throw new ProjectContractError(409, "project_already_exists");
    await rename(stagingDirectory, destinationDirectory);
    registerProject(projectRoot, { id, type: "story", path: destinationDirectory, temporary: true });
    return { id, title: nextProject.title, directory: `workspace/${id}`, copied_from: sourceId };
  } catch (error) {
    if (await pathExists(stagingDirectory)) {
      try { await rm(stagingDirectory, { recursive: true, force: false }); }
      catch (cleanupError) { throw new ProjectContractError(500, "copy_cleanup_failed", [error?.message ?? String(error), cleanupError?.message ?? String(cleanupError)]); }
    }
    throw error;
  }
}

export async function renameProjectDirectory(projectRoot, projectId, nextProjectId) {
  const sourceId = requireProjectDirectoryName(projectId);
  const destinationId = requireProjectDirectoryName(nextProjectId);
  if (readProjectRegistry(projectRoot).some(entry => entry.id === destinationId && entry.id !== sourceId)) throw new ProjectContractError(409, "project_already_exists");
  if (sourceId === destinationId) throw new ProjectContractError(409, "project_id_unchanged");
  const workspaceRoot = path.join(path.resolve(projectRoot), "workspace");
  await requirePlainDirectory(workspaceRoot, "workspace_not_found");
  const sourceDirectory = await requirePlainDirectory(registeredProjectPath(projectRoot, sourceId));
  const destinationDirectory = path.join(path.dirname(sourceDirectory), destinationId);
  if (path.dirname(destinationDirectory) !== path.dirname(sourceDirectory)) throw new ProjectContractError(400, "invalid_project_id");
  if (await pathExists(destinationDirectory)) throw new ProjectContractError(409, "project_already_exists");
  await requireIdleProject(sourceDirectory);
  try { await rename(sourceDirectory, destinationDirectory); }
  catch (error) { throw new ProjectContractError(409, "project_rename_failed", [error?.message ?? String(error)]); }
  const prior = readProjectRegistry(projectRoot).find(entry => entry.id === sourceId);
  unregisterProject(projectRoot, sourceId);
  registerProject(projectRoot, { ...prior, id: destinationId, path: destinationDirectory });
  return { id: destinationId, directory: destinationDirectory, renamed_from: sourceId };
}
