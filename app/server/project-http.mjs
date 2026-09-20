import { projectLibrary, openProjectDirectory, manageRegisteredProject } from "./project-library.mjs";
import { registeredProjectPath, listRegisteredProjects, registerProject, unregisterProject, readProjectRegistry } from "./project-registry.mjs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { listProjectRenderProfiles, readRenderProfileBundle } from "./global-resources.mjs";
import { resolveMediaVariantWidth } from "./media-variants.mjs";
import {
  ApiError,
  imageContentType,
  readJsonBody,
  readJsonFile,
  requireProjectDirectory,
  sendFile,
  sendJson,
  serveProjectMedia,
  writeJsonFile,
} from "./http-support.mjs";
import { requireProjectDirectoryName } from "./project-contracts.mjs";
import {
  deleteMaterial,
  openMaterialFile,
  readProjectMaterials,
  saveCreativeAgreement,
  saveMaterial,
} from "./project-materials.mjs";
import { copyProject, renameProjectDirectory } from "./project-management.mjs";
import { validateProjectRenderProfileOverride } from "./render-profile-compiler.mjs";
import {
  readRenderProfileOverrideDocument,
  saveRenderProfileOverrideDocument,
} from "./render-profile-override.mjs";

const renderProfileIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const validCanvasRatios = new Set(["3:4", "2:3", "9:16", "4:3"]);
const editableProjectSettings = new Set(["title", "canvas", "default_render_profile"]);

export async function readWorkspaceProjects(projectRoot) {
  const entries = listRegisteredProjects(projectRoot, "story");
  const projects = [];
  for (const entry of entries) {
    const projectDirectory = entry.path;
    if (!entry.available) { projects.push({ id: entry.id, title: entry.id, path: entry.path, temporary: entry.temporary, available: false, pages: 0, renderProfile: "路径不可用", canvas: "" }); continue; }
    const [project, pageIndex] = await Promise.all([
      readJsonFile(path.join(projectDirectory, "project.json"), { optional: true }),
      readJsonFile(path.join(projectDirectory, "pages", "index.json"), { optional: true }),
    ]);
    const pageIds = new Set((pageIndex?.pages ?? []).map(page => page.page_id));
    projects.push({
      id: entry.id, path: entry.path, temporary: entry.temporary, available: true,
      title: String(project?.title ?? entry.id),
      pages: pageIds.size,
      renderProfile: String(project?.default_render_profile ?? "尚未设置"),
      canvas: String(project?.canvas ?? "尚未设置"),
    });
  }
  projects.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  return { workspace: "workspace", projects };
}

async function saveProjectRenderProfile(projectRoot, projectId, profileId) {
  const { safeProjectId, projectDirectory } = await requireProjectDirectory(projectRoot, projectId);
  if (typeof profileId !== "string" || !renderProfileIdPattern.test(profileId)) throw new ApiError(422, "invalid_render_profile");
  if (!(await readRenderProfileBundle(projectRoot, profileId))) throw new ApiError(422, "render_profile_not_found");
  const target = path.join(projectDirectory, "project.json");
  const project = await readJsonFile(target);
  const next = { ...project, default_render_profile: profileId };
  delete next.id;
  await writeJsonFile(target, next);
  return { ...next, id: safeProjectId };
}

async function readProjectRenderProfileOverride(projectRoot, projectId) {
  const { projectDirectory } = await requireProjectDirectory(projectRoot, projectId);
  return readRenderProfileOverrideDocument(projectDirectory);
}

async function saveProjectRenderProfileOverride(projectRoot, projectId, value) {
  const { projectDirectory } = await requireProjectDirectory(projectRoot, projectId);
  const override = await validateProjectRenderProfileOverride({
    repositoryRoot: projectRoot,
    projectRoot: projectDirectory,
    overrideDocument: value,
  });
  return saveRenderProfileOverrideDocument(projectDirectory, override);
}

async function saveProjectSettings(projectRoot, projectId, value) {
  const { safeProjectId, projectDirectory } = await requireProjectDirectory(projectRoot, projectId);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid_project_settings");
  const unknown = Object.keys(value).filter((key) => !editableProjectSettings.has(key));
  if (unknown.length) throw new ApiError(422, "invalid_project_settings", unknown.map((key) => `未知字段：${key}`));
  if (typeof value.title !== "string" || !value.title.trim()) throw new ApiError(422, "invalid_project_title");
  if (!validCanvasRatios.has(value.canvas)) throw new ApiError(422, "invalid_project_canvas");
  if (typeof value.default_render_profile !== "string" || !(await readRenderProfileBundle(projectRoot, value.default_render_profile))) {
    throw new ApiError(422, "render_profile_not_found");
  }
  const target = path.join(projectDirectory, "project.json");
  const current = await readJsonFile(target);
  const next = {
    ...(typeof current.$schema === "string" ? { $schema: current.$schema } : {}),
    title: value.title.trim(),
    canvas: value.canvas,
    default_render_profile: value.default_render_profile,
  };
  await writeJsonFile(target, next);
  return { ...next, id: safeProjectId };
}

export async function handleProjectRequest({
  request,
  response,
  requestUrl,
  decodedPath,
  projectRoot,
  config,
  readFacts,
  readProjectRevision,
  mutateFacts,
  mutateDerived,
  trainingOperations,
  copyProjectOperation,
  renameProjectOperation,
  sendOperation,
}) {
  if (decodedPath === "/api/project-library" && request.method === "GET") { sendJson(response, 200, projectLibrary(projectRoot)); return true; }
  if (decodedPath === "/api/project-library/open" && request.method === "POST") { const body = await readJsonBody(request); sendJson(response, 201, await openProjectDirectory(projectRoot, body.path)); return true; }
  const libraryAction = /^\/api\/project-library\/([^/]+)\/(copy|forget|relocate|promote|delete)$/.exec(decodedPath);
  if (libraryAction && request.method === "POST") {
    const body = await readJsonBody(request);
    const entry = projectLibrary(projectRoot).projects.find(item => item.id === libraryAction[1]);
    const operation = () => manageRegisteredProject(projectRoot, libraryAction[1], libraryAction[2], body);
    const result = entry?.available ? entry.type === "training"
      ? (await trainingOperations.execute("/api/lora-training/datasets", null, false, operation)).value
      : (await mutateDerived(entry.id, operation)).value
      : await operation();
    sendJson(response, 200, result); return true;
  }
  const revisionMatch = /^\/api\/projects\/([^/]+)\/revision\/?$/.exec(decodedPath);
  if (request.method === "GET" && revisionMatch) {
    sendJson(response, 200, { revision: await readProjectRevision(revisionMatch[1]) });
    return true;
  }
  if (request.method === "GET" && decodedPath === "/api/projects") {
    sendJson(response, 200, await readWorkspaceProjects(projectRoot));
    return true;
  }

  const copyProjectMatch = /^\/api\/projects\/([^/]+)\/copy\/?$/.exec(decodedPath);
  if (request.method === "POST" && copyProjectMatch) {
    const copied = await copyProjectOperation(copyProjectMatch[1], () => copyProject(projectRoot, copyProjectMatch[1]));
    sendJson(response, 201, { copied: true, project: copied.value }, { revision: copied.revision });
    return true;
  }

  const renameProjectMatch = /^\/api\/projects\/([^/]+)\/rename\/?$/.exec(decodedPath);
  if (request.method === "POST" && renameProjectMatch) {
    const body = await readJsonBody(request);
    const renamed = await renameProjectOperation(renameProjectMatch[1], () => renameProjectDirectory(projectRoot, renameProjectMatch[1], body?.id));
    sendJson(response, 200, { renamed: true, project: renamed.value }, { revision: renamed.revision });
    return true;
  }

  const materialsMatch = /^\/api\/projects\/([^/]+)\/materials\/?$/.exec(decodedPath);
  if (request.method === "GET" && materialsMatch) {
    const result = await readFacts(materialsMatch[1], ({ projectDirectory, projectId }) => readProjectMaterials(projectDirectory, projectId));
    sendOperation(200, result);
    return true;
  }

  const creativeAgreementMatch = /^\/api\/projects\/([^/]+)\/creative-agreement\/?$/.exec(decodedPath);
  if (request.method === "PUT" && creativeAgreementMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(creativeAgreementMatch[1], ({ projectDirectory }) => saveCreativeAgreement(projectDirectory, value));
    sendOperation(200, result, { saved: true, agreement: result.value });
    return true;
  }

  const materialFileMatch = /^\/api\/projects\/([^/]+)\/materials\/file\/?$/.exec(decodedPath);
  if (request.method === "GET" && materialFileMatch) {
    const material = await openMaterialFile((await requireProjectDirectory(projectRoot, materialFileMatch[1])).projectDirectory, requestUrl.searchParams.get("file"));
    sendFile(response, material, { headers: { "x-content-type-options": "nosniff" } });
    return true;
  }

  const materialItemMatch = /^\/api\/projects\/([^/]+)\/materials\/item\/?$/.exec(decodedPath);
  if (request.method === "PUT" && materialItemMatch) {
    const value = await readJsonBody(request, 48 * 1024 * 1024);
    const result = await mutateFacts(materialItemMatch[1], ({ projectDirectory, projectId }) => saveMaterial(projectDirectory, projectId, value));
    sendOperation(200, result, { saved: true, material: result.value });
    return true;
  }
  if (request.method === "DELETE" && materialItemMatch) {
    const result = await mutateFacts(materialItemMatch[1], ({ projectDirectory }) => deleteMaterial(projectDirectory, requestUrl.searchParams.get("file")));
    sendOperation(200, result);
    return true;
  }

  const profileMatch = /^\/api\/projects\/([^/]+)\/render-profile\/?$/.exec(decodedPath);
  if (request.method === "GET" && profileMatch) {
    const result = await readFacts(profileMatch[1], async ({ projectDirectory }) => {
      const project = await readJsonFile(path.join(projectDirectory, "project.json"));
      const currentProfileId = project.default_render_profile;
      return {
        current_profile_id: currentProfileId,
        render_profiles: await listProjectRenderProfiles(projectRoot, projectDirectory, config, null, currentProfileId),
      };
    });
    sendOperation(200, result);
    return true;
  }
  if (request.method === "PUT" && profileMatch) {
    const body = await readJsonBody(request);
    const result = await mutateFacts(profileMatch[1], () => saveProjectRenderProfile(projectRoot, profileMatch[1], body?.id));
    sendOperation(200, result, { saved: true, project: result.value });
    return true;
  }

  const profileOverrideMatch = /^\/api\/projects\/([^/]+)\/render-profile-override\/?$/.exec(decodedPath);
  if (request.method === "GET" && profileOverrideMatch) {
    const result = await readFacts(profileOverrideMatch[1], () => readProjectRenderProfileOverride(projectRoot, profileOverrideMatch[1]));
    sendOperation(200, result, { override: result.value });
    return true;
  }
  if (request.method === "PUT" && profileOverrideMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(profileOverrideMatch[1], () => saveProjectRenderProfileOverride(projectRoot, profileOverrideMatch[1], value));
    sendOperation(200, result, { saved: true, override: result.value });
    return true;
  }

  const projectSettingsMatch = /^\/api\/projects\/([^/]+)\/project\/?$/.exec(decodedPath);
  if (request.method === "PUT" && projectSettingsMatch) {
    const value = await readJsonBody(request);
    const result = await mutateFacts(projectSettingsMatch[1], () => saveProjectSettings(projectRoot, projectSettingsMatch[1], value));
    sendOperation(200, result, { saved: true, project: result.value });
    return true;
  }

  const mediaMatch = /^\/api\/projects\/([^/]+)\/media\/(.+)$/.exec(decodedPath);
  if (request.method === "GET" && mediaMatch) {
    await serveProjectMedia(response, projectRoot, mediaMatch[1], mediaMatch[2], { variantWidth: resolveMediaVariantWidth(requestUrl.searchParams.get("w")) });
    return true;
  }

  return false;
}
