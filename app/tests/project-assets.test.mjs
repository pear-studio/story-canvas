import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerProject } from "../server/project-registry.mjs";
import { planAssetTransfer, commitAssetTransfer } from "../server/project-assets.mjs";
import { listLocalLoraResources, readLocalLoraResource, openLoraResourceMedia } from "../server/lora-resources.mjs";
import { createProjectOperations } from "../server/project-operations.mjs";
import { copyProject } from "../server/project-management.mjs";
import { readWritingCorpusContext } from "../server/writing-corpus.mjs";

async function fixture(t) {
  const base = fileURLToPath(new URL("../../Saved/Tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "project-assets-"));
  t.after(() => rm(root, { recursive: true }));
  const owner = path.join(root, "external", "owner");
  await mkdir(owner, { recursive: true });
  await writeFile(path.join(owner, "project.json"), JSON.stringify({ title: "所属项目" }));
  registerProject(root, { id: "owner", type: "story", path: owner });
  return { root, owner };
}

async function addResource(root) {
  const resource = JSON.parse(await readFile(new URL("../../library/resources/loras/lora-6ecff93984c1b084/resource.json", import.meta.url), "utf8"));
  const directory = path.join(root, "library/resources/loras", resource.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "resource.json"), JSON.stringify(resource));
  for (const media of [...resource.previews, ...resource.examples]) {
    await mkdir(path.dirname(path.join(directory, media.file)), { recursive: true });
    await writeFile(path.join(directory, media.file), "preview bytes");
  }
  return resource;
}

test("项目 LoRA 移动后沿用 ID、元数据与图片，复制项目不重复复制所属资料", async t => {
  const { root, owner } = await fixture(t);
  const resource = await addResource(root);
  const operations = createProjectOperations({ projectRoot: root });
  const before = await operations.state("owner");
  const input = { kind: "lora", id: resource.id, source_storage: "repository", storage: "project", project_id: "owner" };
  const plan = await planAssetTransfer(root, input);
  await operations.mutateTargetFacts("owner", () => commitAssetTransfer(root, input, plan.fingerprint));
  assert.notEqual(await operations.state("owner"), before);
  const list = await listLocalLoraResources(root);
  assert.equal(list.resources.length, 1);
  assert.equal(list.resources[0].owner_project_id, "owner");
  const read = await readLocalLoraResource(root, {}, resource.id);
  assert.deepEqual(read.resource, resource);
  const media = await openLoraResourceMedia(root, resource.id, resource.previews[0].file);
  assert.ok(media.target.startsWith(owner));
  assert.equal(await readFile(media.target, "utf8"), "preview bytes");
  const copy = await copyProject(root, "owner");
  await assert.rejects(readFile(path.join(root, copy.directory, "resources/loras", resource.id, "resource.json")), { code: "ENOENT" });
  assert.equal((await readLocalLoraResource(root, {}, resource.id)).owner_project_id, "owner");
});

test("迁移计划拒绝过期源、目标冲突及非法路径；slider 转本机后图片和 ID 可读", async t => {
  const { root } = await fixture(t);
  const resource = await addResource(root);
  const input = { kind: "lora", id: resource.id, source_storage: "repository", storage: "local" };
  const plan = await planAssetTransfer(root, input);
  const image = path.join(plan.source, resource.previews[0].file);
  await writeFile(image, "changed");
  await assert.rejects(commitAssetTransfer(root, input, plan.fingerprint), { code: "asset_transfer_conflict" });
  await assert.rejects(planAssetTransfer(root, { ...input, id: "../../outside" }), { code: "invalid_lora_resource_id" });
  const fresh = await planAssetTransfer(root, input);
  await commitAssetTransfer(root, input, fresh.fingerprint);
  assert.equal((await readLocalLoraResource(root, {}, resource.id)).storage, "local");
  assert.equal(await readFile((await openLoraResourceMedia(root, resource.id, resource.previews[0].file)).target, "utf8"), "changed");
  await assert.rejects(planAssetTransfer(root, input), { code: "asset_destination_exists" });
});

test("语料只进入所属项目、原始字节和偏移不变，Git 保护字节，项目复制不带语料", async t => {
  const { root, owner } = await fixture(t);
  const source = path.join(root, "library/writing-corpus/source/原文");
  await mkdir(source, { recursive: true });
  const bytes = Buffer.from("首行\r\n第二行\r\n", "utf8");
  await writeFile(path.join(source, "book.txt"), bytes);
  const input = { kind: "corpus", source_storage: "repository", storage: "project", project_id: "owner" };
  const plan = await planAssetTransfer(root, input);
  await commitAssetTransfer(root, input, plan.fingerprint);
  assert.deepEqual(await readFile(path.join(owner, "writing-corpus/source/原文/book.txt")), bytes);
  assert.match(await readFile(path.join(owner, ".gitattributes"), "utf8"), /writing-corpus\/\*\* -text/);
  const result = await readWritingCorpusContext(owner, "source/原文/book.txt", Buffer.byteLength("首行\r\n", "utf8"));
  assert.equal(result.lines.find(line => line.hit).text, "第二行");
  const copy = await copyProject(root, "owner");
  await assert.rejects(readFile(path.join(root, copy.directory, "writing-corpus/source/原文/book.txt")), { code: "ENOENT" });
});
