import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { listRegisteredProjects } from "./project-registry.mjs";
import { validateLoraResource, loraResourceIdPattern, LoraResourceError } from "./lora-resources.mjs";
import { readJsonBody, sendJson } from "./http-support.mjs";

const fail = (code, details, status = 409) => { throw new LoraResourceError(status, code, details); };
const exists = target => lstat(target).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error));
const hash = value => createHash("sha256").update(value).digest("hex");

// 移动现有完整资料树，不接受任意本机路径，不改写原文或 resource.json。
function transferLocations(root, input) {
  if (!input || !["lora", "corpus"].includes(input.kind) || !["repository", "local"].includes(input.source_storage)
      || !["project", "local"].includes(input.storage)
      || Object.keys(input).some(key => !["kind", "id", "source_storage", "storage", "project_id"].includes(key))) fail("invalid_asset_transfer", undefined, 422);
  if (input.kind === "lora" && !loraResourceIdPattern.test(input.id)) fail("invalid_lora_resource_id", undefined, 422);
  if (input.kind === "corpus" && (input.id || input.source_storage !== "repository" || input.storage !== "project")) fail("invalid_corpus_transfer", undefined, 422);
  const owner = input.storage === "project" ? listRegisteredProjects(root).find(project => project.id === input.project_id && project.available) : null;
  if (input.storage === "project" && !owner) fail("project_not_registered", undefined, 404);
  if (input.storage === "local" && input.project_id) fail("invalid_asset_transfer", undefined, 422);
  const relative = input.kind === "corpus" ? "writing-corpus" : path.join("resources", "loras", input.id);
  const source = input.kind === "corpus" ? path.join(root, "library", relative)
    : path.join(root, input.source_storage === "repository" ? "library/resources/loras" : "app/data.local/lora-resources", input.id);
  const destination = owner ? path.join(owner.path, relative) : path.join(root, "app/data.local/lora-resources", input.id);
  if (source === destination) fail("asset_transfer_same_location");
  return { source, destination, owner, boundary: owner?.path ?? root };
}

async function treeInventory(directory) {
  const files = [];
  async function visit(target) {
    const info = await lstat(target);
    if (info.isSymbolicLink()) fail("unsafe_asset_transfer", [target], 422);
    if (info.isDirectory()) {
      for (const entry of await readdir(target)) await visit(path.join(target, entry));
    } else if (info.isFile()) files.push({ file: path.relative(directory, target).replaceAll("\\", "/"), bytes: info.size, sha256: hash(await readFile(target)) });
    else fail("unsafe_asset_transfer", [target], 422);
  }
  await visit(directory);
  return files.sort((a, b) => a.file.localeCompare(b.file, "en"));
}

async function checkDestination(boundary, destination) {
  const rootReal = await realpath(boundary);
  const relative = path.relative(boundary, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("unsafe_asset_transfer");
  let current = boundary;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!await exists(current)) break;
    const resolvedRelative = path.relative(rootReal, await realpath(current));
    if ((await lstat(current)).isSymbolicLink() || resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) fail("unsafe_asset_transfer");
  }
  if (await exists(destination)) fail("asset_destination_exists", [destination]);
}

export async function planAssetTransfer(repositoryRoot, input) {
  const root = path.resolve(repositoryRoot);
  const locations = transferLocations(root, input);
  await checkDestination(locations.boundary, locations.destination);
  const sourceBoundary = input.kind === "corpus" ? path.join(root, "library") : path.dirname(locations.source);
  await checkSourceBoundary(root, sourceBoundary);
  if (!await exists(locations.source)) fail("asset_source_missing", [locations.source], 404);
  const files = await treeInventory(locations.source);
  if (input.kind === "lora") {
    const resource = JSON.parse(await readFile(path.join(locations.source, "resource.json"), "utf8"));
    const errors = validateLoraResource(resource);
    if (resource.id !== input.id) errors.push("目录名与资源 ID 不一致");
    for (const media of [...(resource.previews ?? []), ...(resource.examples ?? [])]) if (!files.some(file => file.file === media.file)) errors.push(`图片缺失：${media.file}`);
    if (errors.length) fail("invalid_lora_resource", errors, 422);
    for (const project of listRegisteredProjects(root).filter(project => project.available)) {
      if (await exists(path.join(project.path, "resources", "loras", input.id))) fail("lora_resource_already_owned", [project.id]);
    }
  }
  const attributes = locations.owner && input.kind === "corpus" ? await readFile(path.join(locations.owner.path, ".gitattributes"), "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error)) : null;
  const plan = { input, source: locations.source, destination: locations.destination, file_count: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), files, attributes_sha256: attributes === null ? null : hash(attributes) };
  return { ...plan, fingerprint: hash(JSON.stringify(plan)) };
}

async function checkSourceBoundary(root, directory) {
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep)) {
    current = path.join(current, segment);
    if (await exists(current) && (await lstat(current)).isSymbolicLink()) fail("unsafe_asset_transfer");
  }
}

export async function commitAssetTransfer(repositoryRoot, input, fingerprint) {
  const plan = await planAssetTransfer(repositoryRoot, input);
  if (typeof fingerprint !== "string" || fingerprint !== plan.fingerprint) fail("asset_transfer_conflict");
  await mkdir(path.dirname(plan.destination), { recursive: true });
  try { await rename(plan.source, plan.destination); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    await cp(plan.source, plan.destination, { recursive: true, errorOnExist: true, force: false });
    if (JSON.stringify(await treeInventory(plan.destination)) !== JSON.stringify(plan.files)) fail("asset_transfer_verification_failed");
    // source 是仓库内经过核验的固定资源目录，永不指向模型或运行环境。
    await rm(plan.source, { recursive: true });
  }
  if (JSON.stringify(await treeInventory(plan.destination)) !== JSON.stringify(plan.files)) fail("asset_transfer_verification_failed");
  if (input.kind === "corpus") {
    const target = path.join(path.dirname(plan.destination), ".gitattributes");
    const previous = await readFile(target, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
    if (!previous.split(/\r?\n/).includes("writing-corpus/** -text")) {
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}writing-corpus/** -text\n`, { flag: "wx" });
      await rename(temporary, target);
    }
  }
  return { ...plan, fingerprint: undefined, files: undefined, moved: true };
}

export function createAssetTransferHandler(repositoryRoot) {
  let pending = Promise.resolve();
  return async ({ request, response, decodedPath, mutateTargetFacts, trainingOperations }) => {
    if (request.method !== "POST" || !["/api/project-assets/plan", "/api/project-assets/transfer"].includes(decodedPath)) return false;
    const body = await readJsonBody(request);
    const save = decodedPath.endsWith("/transfer");
    const operation = () => save ? commitAssetTransfer(repositoryRoot, body.input, body.fingerprint) : planAssetTransfer(repositoryRoot, body.input);
    const execute = async () => {
      const owner = body.input?.storage === "project" ? listRegisteredProjects(repositoryRoot).find(project => project.id === body.input.project_id) : null;
      if (save && owner?.type === "story") return (await mutateTargetFacts(owner.id, operation)).value;
      if (save && owner?.type === "training") return (await trainingOperations.execute("/api/lora-training/datasets", null, true, operation)).value;
      return operation();
    };
    const result = pending.then(execute);
    pending = result.catch(() => undefined);
    sendJson(response, 200, await result);
    return true;
  };
}
