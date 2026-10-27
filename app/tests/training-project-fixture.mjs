import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { createLoraTrainingDataset as create } from "../server/lora-training-facts.mjs";
import * as training from "../server/lora-training.mjs";
import { captionSetPaths, readCaptionSets } from "../server/lora-caption-sets.mjs";
export * from "../server/lora-training.mjs";

// 既有单方案领域测试明确选择初建集和 Qwen；多集/缺身份测试直接调用生产接口。
export async function testCaptionOptions(root, id, options = {}) {
 return { caption_set_id: (await readCaptionSets(root, id))[0]?.id, ...options };
}
export async function testCaptionPaths(root, id) {
 return captionSetPaths(root, id, (await testCaptionOptions(root, id)).caption_set_id);
}
export async function readLoraTrainingDataset(root, id, options) {
 return training.readLoraTrainingDataset(root, id, await testCaptionOptions(root, id, options));
}
export async function importLoraTrainingAssets(root, id, input) {
 const before = await training.readLoraTrainingDataset(root, id);
 const result = await training.importLoraTrainingAssets(root, id, { ...input, files: input.files.map(({ caption, ...file }) => file) });
 const added = result.items.filter(item => !before.items.some(old => old.id === item.id));
 for (const [index, item] of added.entries()) {
  if (Object.hasOwn(input.files[index], "caption")) await saveLoraTrainingCaption(root, id, item.id, input.files[index].caption);
 }
 return readLoraTrainingDataset(root, id);
}
export async function saveLoraTrainingCaption(root, id, item, caption, options) {
 return training.saveLoraTrainingCaption(root, id, item, caption, await testCaptionOptions(root, id, options));
}
export async function readLoraCaptioning(root, id, options) {
 return training.readLoraCaptioning(root, id, await testCaptionOptions(root, id, options));
}
export async function readLoraCaptionAudit(root, id, options) {
 return training.readLoraCaptionAudit(root, id, await testCaptionOptions(root, id, options));
}
export async function readCaptionAuditSnapshot(root, id, options) {
 return training.readCaptionAuditSnapshot(root, id, await testCaptionOptions(root, id, options));
}
export async function copyLoraTrainingItem(root, id, input) {
 await training.copyLoraTrainingItem(root, id, input);
 return readLoraTrainingDataset(root, id);
}
export async function recordLoraCaptionAudit(root, id, input) {
 return training.recordLoraCaptionAudit(root, id, await testCaptionOptions(root, id, input));
}
export async function updateLoraCaptioningItem(root, id, item, caption, options) {
 return training.updateLoraCaptioningItem(root, id, item, caption, await testCaptionOptions(root, id, options));
}
export async function runLoraCaptioning(root, project, id, mode, config, options) {
 return training.runLoraCaptioning(root, project, id, mode, config, await testCaptionOptions(project, id, options));
}
export async function readLoraTrainingTask(root, id, options = {}) {
 return training.readLoraTrainingTask(root, id, { family: "qwen-image-2-1", ...options });
}
export async function createLoraTrainingTask(root, project, input) {
 return training.createLoraTrainingTask(root, project, { target: { family: "qwen-image-2-1" }, ...await testCaptionOptions(project, input.dataset_id), ...input });
}
export async function preflightLoraTraining(root, project, id, config, options = {}) {
 return training.preflightLoraTraining(root, project, id, config, { family: "qwen-image-2-1", ...options });
}
export async function readLoraTrainingRunSettings(root, project, id, config, options = {}) {
 return training.readLoraTrainingRunSettings(root, project, id, config, { family: "qwen-image-2-1", ...options });
}
export async function createLoraTrainingDataset(root, input) {
 const target = path.join(root, "library", "lora-training");
 await mkdir(target, { recursive: true });
 await cp(new URL("../../library/lora-training/", import.meta.url), target, { recursive: true, force: false });
 return create(root, input);
}
