import { cp, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { createLoraTrainingDataset as create } from "../server/lora-training-facts.mjs";
export async function createLoraTrainingDataset(root, input) {
 const target = path.join(root, "library", "lora-training");
 await mkdir(target, { recursive: true });
 await cp(new URL("../../library/lora-training/", import.meta.url), target, { recursive: true, force: false });
 return create(root, input);
}
