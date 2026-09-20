import { registeredProjectPath, listRegisteredProjects, registerProject, unregisterProject, readProjectRegistry } from "./project-registry.mjs";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { isSafeLoraFilename } from "./lora-config.mjs";
import { listLocalLoraResources } from "./lora-resources.mjs";
import { requireProjectDirectoryName } from "./project-contracts.mjs";
import { compileEffectiveRenderProfile, readResolvedRenderProfile } from "./render-profile-compiler.mjs";
import { diagnoseModelFile, diagnoseRenderProfile } from "./render-profile-diagnostics.mjs";
import { inspectRenderProfile } from "./render-profile-inspection.mjs";
import { readVisualPageTemplates } from "./visual-page-templates.mjs";
import { readWorkflowDefinition } from "./workflow-definition.mjs";

const renderProfileIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const modelDiscoveryRoots = [
  ["checkpoints", "checkpoint"],
  ["loras", "lora"],
  ["vae", "vae"],
  ["embeddings", "embedding"],
];
const modelFileExtensions = new Set([".safetensors", ".ckpt", ".pt", ".pth", ".bin"]);

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(target, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

function configuredPath(projectRoot, value) {
  return typeof value === "string" && value.trim() ? path.resolve(projectRoot, value) : null;
}

export async function readRenderProfileBundle(projectRoot, profileId) {
  if (typeof profileId !== "string" || !renderProfileIdPattern.test(profileId)) return null;
  if (!(await pathExists(path.join(projectRoot, "library", "render-profiles", `${profileId}.json`)))) return null;
  return readResolvedRenderProfile(projectRoot, profileId);
}

export async function readEffectiveRenderProfileCompilation(projectRoot, projectDirectory, profileId) {
  if (typeof profileId !== "string" || !renderProfileIdPattern.test(profileId)) return null;
  if (!(await pathExists(path.join(projectRoot, "library", "render-profiles", `${profileId}.json`)))) return null;
  return compileEffectiveRenderProfile({ repositoryRoot: projectRoot, projectRoot: projectDirectory, profileId });
}

export function executableRenderProfileBundle(compilation, { allowBaseOnConflict = false } = {}) {
  if (!compilation) return null;
  if (compilation.blocked) return allowBaseOnConflict ? compilation.base_bundle : null;
  return {
    resolved_profile: compilation.effective_profile,
    workflow_definitions: compilation.workflow_definitions,
    source_identity: compilation.source_identity,
    resolved_profile_sha256: compilation.effective_profile_sha256,
  };
}

export function renderProfileOverrideBlockers(compilation) {
  if (!compilation?.override_resolution?.conflicts?.length) return [];
  return compilation.override_resolution.conflicts.map((conflict) => ({
    code: "render_profile_override_conflict",
    target: conflict.target,
    original: structuredClone(conflict.original),
    current: structuredClone(conflict.current),
    project: structuredClone(conflict.project),
  }));
}

export function renderProfileEffectiveIdentity(compilation) {
  if (!compilation) return null;
  return {
    base_profile_id: compilation.base_bundle.resolved_profile.id,
    base_profile_sha256: compilation.base_bundle.resolved_profile_sha256,
    override_sha256: compilation.override_source_identity.sha256,
    effective_profile_sha256: compilation.effective_profile_sha256,
    blockers: renderProfileOverrideBlockers(compilation),
  };
}

export async function diagnoseAndInspectRenderProfile(bundle, projectRoot, config, resourceCatalog = null, inspectionContext = {}) {
  const diagnosis = await diagnoseRenderProfile(bundle.resolved_profile, projectRoot, config, resourceCatalog, inspectionContext.diagnosis_options ?? {});
  const baseBundle = inspectionContext.compilation?.base_bundle ?? bundle;
  const baseDiagnosis = baseBundle.resolved_profile_sha256 === bundle.resolved_profile_sha256
    ? diagnosis
    : await diagnoseRenderProfile(baseBundle.resolved_profile, projectRoot, config, resourceCatalog, inspectionContext.diagnosis_options ?? {});
  return {
    ...diagnosis,
    ...(inspectionContext.compilation?.blocked ? { available: false } : {}),
    effective_profile: inspectionContext.compilation ? renderProfileEffectiveIdentity(inspectionContext.compilation) : null,
    inspection: inspectRenderProfile({ bundle: inspectionContext.compilation ?? bundle, diagnosis, baseDiagnosis }),
  };
}

export function lightweightRenderProfile(bundle, projectRoot, config, resourceCatalog, configurationError = null) {
  const profile = bundle.resolved_profile;
  const primaryModel = profile.models?.dit ?? null;
  const resource = primaryModel
    ? (resourceCatalog?.models ?? []).find((model) => model.relative_path === primaryModel.relative_path && model.sha256 === primaryModel.sha256)
    : null;
  const routes = [];
  for (const [operation, operationValue] of Object.entries(profile.operations ?? {})) {
    for (const [inputSource, route] of Object.entries(operationValue.routes ?? {})) {
      routes.push({ operation, input_source: inputSource, workflow_id: route.workflow, recipe_source_id: route.recipe_source_id });
    }
  }
  const models = Object.fromEntries(Object.entries(profile.models ?? {}).map(([role, model]) => [role, {
    id: role,
    role,
    kind: role,
    filename: model.filename,
    relative_path: model.relative_path,
    sha256: model.sha256,
    source: model.source ?? null,
    status: "unverified",
    reason: "not_diagnosed",
    actual_sha256: null,
    integrity_status: "unverified",
  }]));
  const styleLoras = Object.fromEntries(Object.entries(profile.style_loras ?? {}).map(([id, lora]) => [id, {
    id,
    kind: "style",
    owner: profile.id,
    filename: lora.filename,
    relative_path: isSafeLoraFilename(lora.filename) ? `loras/${lora.filename}` : null,
    sha256: lora.sha256,
    weight: lora.weight,
    trigger: lora.trigger ?? null,
    status: "unverified",
    reason: "not_diagnosed",
    actual_sha256: null,
    errors: [],
  }]));
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description ?? "",
    tags: Array.isArray(profile.tags) ? profile.tags : [],
    preview: resource?.preview ?? null,
    architecture_family: profile.architecture_family,
    route_capabilities: {
      operations: [...new Set(routes.map((route) => route.operation))],
      routes,
    },
    prompt_family: profile.prompt?.family ?? null,
    available: null,
    diagnosis_loaded: false,
    models_root: configuredPath(projectRoot, config.models_root),
    models,
    style_loras: styleLoras,
    errors: configurationError ? [`生成配置无法编译：${configurationError.message}`] : [],
    inspection: null,
    ...(configurationError ? {
      configuration_error: {
        code: configurationError.code ?? "render_profile_compilation_failed",
        message: configurationError.message,
      },
    } : {}),
  };
}

export async function listProjectRenderProfiles(projectRoot, projectDirectory, config, resourceCatalog = null, currentProfileId = null) {
  const profileIds = await listRenderProfileIds(projectRoot);
  const catalog = resourceCatalog ?? await readResourceCatalog(projectRoot);
  return Promise.all(profileIds.map(async (profileId) => {
    let baseBundle;
    try {
      baseBundle = await readResolvedRenderProfile(projectRoot, profileId);
      const compilation = await readEffectiveRenderProfileCompilation(projectRoot, projectDirectory, baseBundle.resolved_profile.id);
      const bundle = executableRenderProfileBundle(compilation, { allowBaseOnConflict: true });
      if (profileId !== currentProfileId) return lightweightRenderProfile(bundle, projectRoot, config, catalog);
      return diagnoseAndInspectRenderProfile(bundle, projectRoot, config, catalog, {
        compilation,
        baseBundle,
        diagnosis_options: { modelShaPolicy: "advisory" },
      });
    } catch (error) {
      if (!baseBundle) {
        let rawProfile = null;
        try {
          rawProfile = JSON.parse(await readFile(path.join(projectRoot, "library", "render-profiles", `${profileId}.json`), "utf8"));
        } catch {
          // 文件身份仍由文件名保留，具体解析错误显示在卡片诊断中。
        }
        return {
          id: profileId,
          name: typeof rawProfile?.name === "string" ? rawProfile.name : profileId,
          description: typeof rawProfile?.description === "string" ? rawProfile.description : "",
          tags: Array.isArray(rawProfile?.tags) ? rawProfile.tags.filter((tag) => typeof tag === "string") : [],
          architecture_family: typeof rawProfile?.architecture_family === "string" ? rawProfile.architecture_family : undefined,
          route_capabilities: { operations: [], routes: [] },
          available: false,
          models_root: configuredPath(projectRoot, config.models_root),
          models: {},
          style_loras: {},
          errors: [`生成配置无法编译：${error.message}`],
          inspection: null,
          configuration_error: {
            code: error?.code ?? "render_profile_compilation_failed",
            message: error.message,
          },
        };
      }
      if (profileId !== currentProfileId) return lightweightRenderProfile(baseBundle, projectRoot, config, catalog, error);
      const diagnosis = await diagnoseAndInspectRenderProfile(baseBundle, projectRoot, config, catalog, {
        diagnosis_options: profileId === currentProfileId ? { modelShaPolicy: "advisory" } : {},
      });
      return {
        ...diagnosis,
        available: false,
        errors: [...(diagnosis.errors ?? []), `项目生成配置调整无效：${error.message}`],
        configuration_error: {
          code: error?.code ?? "render_profile_compilation_failed",
          message: error.message,
        },
      };
    }
  }));
}

export async function listRenderProfileIds(projectRoot) {
  const root = path.join(projectRoot, "library", "render-profiles");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const ids = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
    ids.push(path.basename(entry.name, ".json"));
  }
  return ids;
}

export async function listRenderProfileBundles(projectRoot) {
  const bundles = [];
  for (const profileId of await listRenderProfileIds(projectRoot)) bundles.push(await readResolvedRenderProfile(projectRoot, profileId));
  return bundles;
}

async function listFilesBelow(root, relativeRoot, kind, limit = 2000) {
  const files = [];
  async function visit(directory, relativeDirectory) {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (files.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(target, relative);
      else if (entry.isFile() && modelFileExtensions.has(path.extname(entry.name).toLowerCase())) {
        const info = await stat(target);
        files.push({ kind, filename: entry.name, relative_path: relative, size_bytes: info.size });
      }
    }
  }
  await visit(root, relativeRoot);
  return files;
}

export async function readResourceCatalog(projectRoot) {
  const catalog = await readJsonFile(path.join(projectRoot, "library", "resources", "catalog.json"), { optional: true });
  return catalog?.version === 1 && Array.isArray(catalog.models) ? catalog : { version: 1, models: [] };
}

export function profileResourcePaths(profile) {
  return [
    ...Object.values(profile.models ?? {}).map((model) => model.relative_path),
    ...Object.values(profile.style_loras ?? {}).map((lora) => isSafeLoraFilename(lora?.filename) ? `loras/${lora.filename}` : null),
  ].filter(Boolean);
}

export async function readProjectResourceUsage(projectRoot, profiles) {
  const byPath = new Map();
  for (const profile of profiles) {
    for (const relativePath of profileResourcePaths(profile)) {
      if (!byPath.has(relativePath)) byPath.set(relativePath, { profiles: [], projects: [] });
      byPath.get(relativePath).profiles.push({ id: profile.id, name: profile.name });
    }
  }
  const entries = listRegisteredProjects(projectRoot, "story").filter(entry => entry.available);
  for (const entry of entries) {
    const directory = entry.path;
    const [project, characterIndex] = await Promise.all([
      readJsonFile(path.join(directory, "project.json"), { optional: true }).catch(() => null),
      readJsonFile(path.join(directory, "characters", "index.json"), { optional: true }).catch(() => null),
    ]);
    if (!project) continue;
    const usedPaths = new Set();
    let projectProfile = null;
    try {
      const compilation = await readEffectiveRenderProfileCompilation(projectRoot, directory, project.default_render_profile);
      projectProfile = executableRenderProfileBundle(compilation)?.resolved_profile ?? null;
    } catch {
      // 单个项目配置损坏或冲突时，资源页仍展示其他项目。
    }
    for (const relativePath of projectProfile ? profileResourcePaths(projectProfile) : []) usedPaths.add(relativePath);
    for (const characterId of characterIndex?.characters ?? []) {
      const prompt = await readJsonFile(path.join(directory, "characters", `${characterId}.prompt.json`), { optional: true }).catch(() => null);
      if (isSafeLoraFilename(prompt?.identity?.lora?.filename)) usedPaths.add(`loras/${prompt.identity.lora.filename}`);
      const configurations = Object.values(prompt?.variants ?? {});
      for (const configuration of configurations) {
        for (const lora of Array.isArray(configuration?.loras) ? configuration.loras : []) {
          if (isSafeLoraFilename(lora?.filename)) usedPaths.add(`loras/${lora.filename}`);
        }
      }
    }
    for (const relativePath of usedPaths) {
      if (!byPath.has(relativePath)) byPath.set(relativePath, { profiles: [], projects: [] });
      byPath.get(relativePath).projects.push({ id: entry.id, title: project.title });
    }
  }
  return byPath;
}

export async function listKnownFonts() {
  const candidates = [
    { id: "microsoft-yahei", name: "微软雅黑", path: "C:/Windows/Fonts/msyh.ttc" },
    { id: "simhei", name: "黑体", path: "C:/Windows/Fonts/simhei.ttf" },
    { id: "noto-sans-cjk", name: "Noto Sans CJK", path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc" },
    { id: "pingfang", name: "苹方", path: "/System/Library/Fonts/PingFang.ttc" },
  ];
  const result = [];
  for (const candidate of candidates) if (await pathExists(candidate.path)) result.push({ ...candidate, status: "available" });
  return result;
}

export async function listComfyExtensions(projectRoot, config) {
  const comfyRoot = configuredPath(projectRoot, config.comfyui_root);
  if (!comfyRoot) return { root: null, status: "not_configured", items: [] };
  const candidates = [path.join(comfyRoot, "custom_nodes"), path.join(comfyRoot, "ComfyUI", "custom_nodes")];
  const customNodesRoot = (await Promise.all(candidates.map(async (candidate) => [candidate, await pathExists(candidate)]))).find(([, exists]) => exists)?.[0] ?? candidates[0];
  let entries = [];
  try {
    entries = await readdir(customNodesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { root: customNodesRoot, status: "missing", items: [] };
    throw error;
  }
  return {
    root: customNodesRoot,
    status: "available",
    items: entries.filter((entry) => (entry.isDirectory() || entry.isFile()) && !entry.isSymbolicLink() && !entry.name.startsWith(".")).map((entry) => ({
      id: entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      name: entry.name,
      kind: "custom_node",
      status: "available",
    })).sort((left, right) => left.name.localeCompare(right.name, "en")),
  };
}

export async function dictionaryStatus(projectRoot, config) {
  const dictionary = config.prompt_dictionary ?? {};
  const bundledRoot = path.join(projectRoot, "library", "prompt-dictionaries");
  const configuredTagsFile = configuredPath(projectRoot, dictionary.tags_file);
  const configuredTranslationsFile = configuredPath(projectRoot, dictionary.translations_file);
  const tagsFile = configuredTagsFile ?? path.join(bundledRoot, "danbooru.csv");
  const translationsFile = configuredTranslationsFile ?? path.join(bundledRoot, "zh.csv");
  const [tagsAvailable, translationsAvailable] = await Promise.all([pathExists(tagsFile), pathExists(translationsFile)]);
  const available = tagsAvailable && translationsAvailable;
  return {
    preset: dictionary.preset ?? "a1111-tagcomplete",
    configured: Boolean(configuredTagsFile),
    source: configuredTagsFile ? "local_override" : "bundled_snapshot",
    available,
    tags_file: tagsFile,
    translations_file: translationsFile,
    reason: available
      ? null
      : !tagsAvailable
        ? (configuredTagsFile ? "tags_file_missing" : "bundled_tags_snapshot_missing")
        : (configuredTranslationsFile ? "translations_file_missing" : "bundled_translations_snapshot_missing"),
  };
}

export async function readGlobalResources(projectRoot, config = {}) {
  const [catalog, profileBundles, dictionary, fonts, extensions, localLoras, visualPageTemplates] = await Promise.all([
    readResourceCatalog(projectRoot),
    listRenderProfileBundles(projectRoot),
    dictionaryStatus(projectRoot, config),
    listKnownFonts(),
    listComfyExtensions(projectRoot, config),
    listLocalLoraResources(projectRoot, config),
    readVisualPageTemplates(projectRoot),
  ]);
  const profiles = await Promise.all(profileBundles.map((bundle) => diagnoseAndInspectRenderProfile(bundle, projectRoot, config, catalog, {
    diagnosis_options: { modelShaPolicy: "strict" },
  })));
  const modelsRoot = configuredPath(projectRoot, config.models_root);
  const usage = await readProjectResourceUsage(projectRoot, profileBundles.map((bundle) => bundle.resolved_profile));
  const localModels = localLoras.resources.map(({ resource, status, reason, actual_sha256: actualSha256, size_bytes: sizeBytes, repository_record: repositoryRecord }) => {
    const previewItems = resource.previews.length ? resource.previews : resource.examples.slice(0, 3).map((example) => ({ ...example, alt: `${resource.name} 的示例图` }));
    return {
      id: resource.id,
      name: resource.name,
      kind: "lora",
      architecture_family: resource.architecture.family,
      prompt_family: resource.architecture.prompt_family,
      filename: path.basename(resource.file.relative_path),
      relative_path: resource.file.relative_path,
      sha256: resource.file.sha256,
      size_bytes: sizeBytes ?? resource.file.size_bytes,
      registered: true,
      local_record: !repositoryRecord,
      repository_record: Boolean(repositoryRecord),
      status,
      reason,
      actual_sha256: actualSha256,
      preview: previewItems.length ? { images: previewItems.map((item) => ({ src: `/api/lora-resources/${encodeURIComponent(resource.id)}/media/${item.file.split("/").map(encodeURIComponent).join("/")}`, alt: item.alt, ...(item.source ? { source: item.source } : {}), ...(Object.hasOwn(item, "nsfw_level") ? { nsfw_level: item.nsfw_level } : {}) })) } : null,
      lora_metadata: {
        name_zh: resource.name_zh,
        summary_zh: resource.summary_zh,
        purpose: resource.purpose,
        architecture: structuredClone(resource.architecture),
        base_models: structuredClone(resource.base_models),
        activation: structuredClone(resource.activation),
        recommended_generation: structuredClone(resource.recommended_generation),
        description: resource.description,
        usage_notes: resource.usage_notes,
        source: structuredClone(resource.source),
      },
      usage: usage.get(resource.file.relative_path) ?? { profiles: [], projects: [] },
    };
  });
  const registeredByPath = new Map([...catalog.models, ...localModels].map((model) => [model.relative_path, model]));
  const registered = await Promise.all(catalog.models.map(async (model) => {
    const diagnosis = await diagnoseModelFile({ projectRoot, config, relativePath: model.relative_path, sha256: model.sha256 });
    return { ...model, registered: true, status: diagnosis.status, reason: diagnosis.reason, actual_sha256: diagnosis.actualSha256, usage: usage.get(model.relative_path) ?? { profiles: [], projects: [] } };
  }));
  const discovered = localLoras.raw.filter((raw) => !registeredByPath.has(raw.relative_path)).map((raw) => ({
    id: raw.id,
    name: raw.name,
    kind: "lora",
    architecture_family: "other",
    registered: false,
    status: raw.status,
    reason: null,
    filename: path.basename(raw.relative_path),
    relative_path: raw.relative_path,
    sha256: raw.sha256,
    size_bytes: raw.size_bytes,
    usage: usage.get(raw.relative_path) ?? { profiles: [], projects: [] },
  }));
  if (modelsRoot) {
    for (const [directoryName, kind] of modelDiscoveryRoots) {
      if (directoryName === "loras") continue;
      const files = await listFilesBelow(path.join(modelsRoot, directoryName), directoryName, kind);
      for (const file of files) if (!registeredByPath.has(file.relative_path)) discovered.push({
        id: `discovered-${createHash("sha1").update(file.relative_path).digest("hex").slice(0, 12)}`,
        name: path.basename(file.filename, path.extname(file.filename)),
        architecture_family: "other",
        registered: false,
        status: "available",
        reason: null,
        usage: usage.get(file.relative_path) ?? { profiles: [], projects: [] },
        ...file,
      });
    }
  }
  let workflowEntries = [];
  try {
    workflowEntries = await readdir(path.join(projectRoot, "library", "workflows"), { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const workflowIds = [...new Set(workflowEntries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".api.json") || entry.name.endsWith(".manifest.json")))
    .map((entry) => entry.name.replace(/\.(?:api|manifest)\.json$/, "")))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const workflows = await Promise.all(workflowIds.map(async (id) => {
    try {
      const definition = await readWorkflowDefinition(projectRoot, id);
      return {
        id,
        name: id,
        status: "available",
        template_sha256: definition.template_sha256,
        manifest_sha256: definition.manifest_sha256,
      };
    } catch (error) {
      return { id, name: id, status: "invalid", reason: error.message };
    }
  }));
  return {
    models_root: modelsRoot,
    models: [...registered, ...localModels.filter((model) => !catalog.models.some((catalogModel) => catalogModel.relative_path === model.relative_path)), ...discovered],
    lora_resource_errors: localLoras.errors,
    dictionaries: [{ id: dictionary.preset, name: "Prompt 词库", ...dictionary }],
    fonts,
    extensions,
    workflows,
    render_profiles: profiles,
    visual_page_templates: visualPageTemplates,
  };
}
