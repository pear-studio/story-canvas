import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createBlankComparisonInput } from "../server/comparison-inputs.mjs";
import { stageComparisonImports, materializeComparisonReferences } from "../server/comparison-reference-images.mjs";
import { createComparisonExperiment } from "../server/comparison-experiment.mjs";
import { preflightComparisonExperiment } from "../server/comparison-preflight.mjs";
import { createComparisonExperimentStorage, readComparisonExperimentStorage } from "../server/comparison-experiment-storage.mjs";
import { prepareComparisonExperimentExecution } from "../server/comparison-execution-plan.mjs";
import { resolveComparisonReferenceWorkflow } from "../server/comparison-experiment-runtime.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("参考图导入、创建与启动均使用独立冻结图片", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-comparison-reference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 12, height: 9, channels: 3, background: "#c09070" } }).png().toBuffer();
  const identity = { material_file: "portrait.png", source_sha256: sha(bytes), sha256: sha(bytes), width: 12, height: 9 };
  const input = await createBlankComparisonInput(repositoryRoot, "qwen-image-2-1");
  input.prompt.positive = "woman reading under a lamp";
  input.reference_images = [identity];
  input.reference_image_bytes = [{ identity, bytes }];
  const [staged] = await stageComparisonImports(root, [input]);
  assert.equal(staged.reference_image_bytes, undefined);
  assert.match(staged.reference_import_id, /^[0-9a-f-]{36}$/);
  const { inputs, images } = await materializeComparisonReferences(root, [staged]);
  assert.equal(inputs[0].reference_import_id, undefined);
  const manifest = createComparisonExperiment({ id: "reference-case", axes: [{ type: "input", values: [{ value_id: "ref", label: "参考", value: input.id }] }] });
  const preflight = preflightComparisonExperiment({ manifest, inputs });
  const record = await createComparisonExperimentStorage({ projectRoot: root, manifest, preflight, referenceImages: images });
  assert.deepEqual(await readFile(path.join(record.directory, "inputs", `${identity.sha256}.png`)), bytes);
  await rm(path.join(root, "Saved", "comparison-imports"), { recursive: true });
  const prepared = await prepareComparisonExperimentExecution({ repositoryRoot, projectRoot: root, localConfig: {}, experimentId: manifest.id });
  const cell = prepared.execution.cells[0];
  assert.deepEqual(cell.reference_images, [identity]);
  assert.ok(Object.values(cell.workflow.api).some(node => node.class_type === "LoadImage" && node.inputs.image === `StoryCanvas/references/${identity.sha256}.png`));
  const uploads = [];
  const submitted = await resolveComparisonReferenceWorkflow(structuredClone(cell.workflow.api), cell.reference_images, {
    async uploadReference(directory, reference) {
      assert.deepEqual(await readFile(path.join(directory, "inputs", `${reference.sha256}.png`)), bytes);
      uploads.push(reference.sha256);
      return `StoryCanvas/references/uploaded-${reference.sha256}.png`;
    },
  }, record.directory);
  assert.deepEqual(uploads, [identity.sha256]);
  assert.ok(Object.values(submitted).some(node => node.class_type === "LoadImage" && node.inputs.image === `StoryCanvas/references/uploaded-${identity.sha256}.png`));
  assert.deepEqual((await readComparisonExperimentStorage(root, manifest.id)).preflight.inputs[0].reference_images, [identity]);
});

test("冻结参考图损坏会阻止启动", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-comparison-reference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const identity = { material_file: "reference.png", source_sha256: sha(bytes), sha256: sha(bytes), width: 8, height: 8 };
  const input = await createBlankComparisonInput(repositoryRoot, "qwen-image-2-1");
  input.prompt.positive = "portrait";
  input.reference_images = [identity];
  input.reference_image_bytes = [{ identity, bytes }];
  const { inputs, images } = await materializeComparisonReferences(root, await stageComparisonImports(root, [input]));
  const manifest = createComparisonExperiment({ id: "reference-damage", axes: [{ type: "input", values: [{ value_id: "ref", label: "参考", value: input.id }] }] });
  const preflight = preflightComparisonExperiment({ manifest, inputs });
  const record = await createComparisonExperimentStorage({ projectRoot: root, manifest, preflight, referenceImages: images });
  await writeFile(path.join(record.directory, "inputs", `${identity.sha256}.png`), Buffer.from("changed"));
  await assert.rejects(prepareComparisonExperimentExecution({ repositoryRoot, projectRoot: root, localConfig: {}, experimentId: manifest.id }), { code: "comparison_reference_changed" });
});
