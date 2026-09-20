import { registeredProjectPath, listRegisteredProjects, registerProject, unregisterProject, readProjectRegistry } from "./project-registry.mjs";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { requireProjectDirectoryName } from "./project-contracts.mjs";
import {
  EXPECTED_PROJECT_REVISION_HEADER,
  PROJECT_REVISION_HEADER,
  ProjectWriteCoordinatorError,
  createProjectWriteCoordinator,
} from "./project-write-coordinator.mjs";

export {
  EXPECTED_PROJECT_REVISION_HEADER,
  PROJECT_REVISION_HEADER,
  ProjectWriteCoordinatorError as ProjectOperationError,
};

function projectError(status, code, details) {
  return new ProjectWriteCoordinatorError(status, code, details);
}

export async function resolveProjectLocation(projectRoot, projectId) {
  let safeProjectId;
  try {
    safeProjectId = requireProjectDirectoryName(projectId);
  } catch (error) {
    throw projectError(error?.status ?? 400, error?.code ?? "invalid_project_id", error?.details);
  }
  const projectDirectory = registeredProjectPath(projectRoot, safeProjectId);
  if (await lstat(path.join(projectDirectory, ".storage-migration.json")).catch(error => error.code === "ENOENT" ? null : Promise.reject(error))) {
    throw projectError(409, "project_storage_migration_incomplete");
  }
  try {
    const info = await lstat(projectDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw projectError(404, "project_not_found");
  } catch (error) {
    if (error instanceof ProjectWriteCoordinatorError) throw error;
    if (error?.code === "ENOENT") throw projectError(404, "project_not_found");
    throw error;
  }
  return Object.freeze({ projectId: safeProjectId, projectDirectory });
}

function assertCredential(credential) {
  if (!credential || typeof credential !== "object" || (credential.expectedRevision !== null && typeof credential.expectedRevision !== "string")) {
    throw projectError(400, "invalid_project_credential");
  }
}

export function projectCredentialFromRequest(request) {
  const get = (name) => {
    const value = request?.headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return { expectedRevision: get(EXPECTED_PROJECT_REVISION_HEADER) ?? null };
}

export function createProjectOperations({
  projectRoot,
  onExternalChange,
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const coordinator = createProjectWriteCoordinator({ onExternalChange });
  let lifecycleLock = Promise.resolve();

  const contextFor = (project) => Object.freeze({
    projectId: project.projectId,
    projectDirectory: project.projectDirectory,
  });

  async function state(projectId, { cached = false } = {}) {
    const project = await resolveProjectLocation(resolvedProjectRoot, projectId);
    return cached ? coordinator.getObservedState(project.projectDirectory) : coordinator.getState(project.projectDirectory);
  }

  async function readFacts(projectId, read) {
    const project = await resolveProjectLocation(resolvedProjectRoot, projectId);
    if (typeof read !== "function") throw projectError(500, "project_read_operation_missing");
    const result = await coordinator.readConsistent(
      project.projectDirectory,
      () => read(contextFor(project)),
    );
    return { value: result.value, revision: result.revision };
  }

  async function executeCredentialed(projectId, credential, operation, { facts }) {
    const project = await resolveProjectLocation(resolvedProjectRoot, projectId);
    assertCredential(credential);
    if (typeof operation !== "function") throw projectError(500, "project_operation_missing");
    return coordinator.withMutationLock(project.projectDirectory, async ({ currentRevision }) => {
      const current = await currentRevision();
      if (!credential.expectedRevision) throw projectError(428, "expected_project_revision_required");
      if (credential.expectedRevision !== current) {
        throw projectError(409, "project_revision_conflict", { revision: current });
      }
      const value = await operation(contextFor(project));
      const revision = await currentRevision({ suppressExternalChange: facts });
      return { value, revision };
    });
  }

  async function mutateFacts(projectId, credential, mutation) {
    return executeCredentialed(projectId, credential, mutation, { facts: true });
  }

  // 窄写入由领域入口检查目标与必要依赖，不以无关事实的 revision 拒绝提交。
  async function mutateTargetFacts(projectId, mutation) {
    const project = await resolveProjectLocation(resolvedProjectRoot, projectId);
    return coordinator.withMutationLock(project.projectDirectory, async ({ currentRevision }) => {
      const value = await mutation(contextFor(project));
      return { value, revision: await currentRevision({ suppressExternalChange: true }) };
    });
  }

  async function deriveFromFacts(projectId, credential, derive) {
    return executeCredentialed(projectId, credential, derive, { facts: false });
  }

  async function mutateDerived(projectId, mutation) {
    const project = await resolveProjectLocation(resolvedProjectRoot, projectId);
    if (typeof mutation !== "function") throw projectError(500, "project_operation_missing");
    return coordinator.withMutationLock(project.projectDirectory, async () => ({
      value: await mutation(contextFor(project)),
    }));
  }

  async function withLifecycleLock(operation) {
    const previous = lifecycleLock;
    let release;
    lifecycleLock = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally { release(); }
  }

  async function runLifecycle(projectId, credential, operation, { rename = false } = {}) {
    return withLifecycleLock(async () => {
      const project = await resolveProjectLocation(resolvedProjectRoot, projectId);
      assertCredential(credential);
      return coordinator.withMutationLock(project.projectDirectory, async ({ currentRevision }) => {
        const current = await currentRevision();
        if (!credential.expectedRevision) throw projectError(428, "expected_project_revision_required");
        if (credential.expectedRevision !== current) throw projectError(409, "project_revision_conflict", { revision: current });
        const value = await operation(contextFor(project));
        const nextProjectId = value?.id;
        let revision = current;
        if (typeof nextProjectId === "string") {
          const safeNextProjectId = requireProjectDirectoryName(nextProjectId);
          const nextDirectory = registeredProjectPath(resolvedProjectRoot, safeNextProjectId);
          if (rename) coordinator.retire(project.projectDirectory);
          coordinator.restore(nextDirectory);
          const nextRevision = await coordinator.getState(nextDirectory);
          if (rename) revision = nextRevision;
        }
        return { value, revision };
      });
    });
  }

  const copyProject = (projectId, credential, operation) => runLifecycle(projectId, credential, operation);
  const renameProject = (projectId, credential, operation) => runLifecycle(projectId, credential, operation, { rename: true });

  return Object.freeze({
    close: () => coordinator.close(),
    state,
    readFacts,
    mutateFacts,
    mutateTargetFacts,
    deriveFromFacts,
    mutateDerived,
    copyProject,
    renameProject,
  });
}
