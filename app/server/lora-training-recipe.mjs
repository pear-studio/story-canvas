import path from "node:path";

import * as support from "./lora-training-support.mjs";

const { isRecord, readJson, sha256File } = support;

export async function readLoraTrainingRecipe(projectRoot, recipeId) {
  const file = path.join(projectRoot, "library", "lora-training", "recipes", String(recipeId) + ".json");
  const recipe = await readJson(file, { optional: true });
  if (!isRecord(recipe) || recipe.id !== recipeId || !isRecord(recipe.semantic_config)) return null;
  return { ...recipe, sha256: await sha256File(file) };
}
