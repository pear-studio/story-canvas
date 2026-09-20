import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { requireIdleProject } from "./project-management.mjs";

// 一次性迁移：去除 base 特殊性。每个角色一份显式映射（用户已确认），
// renames 同时驱动 prompt.variants 键改名与下游 variant_id 引用修正；
// default_variant 是旧默认造型（原 variants.base）的新身份，用于创建 visual 条目并补全缺省引用。
export const VARIANT_MIGRATION_PLAN = {
  sigrid: {
    renames: { base: "uniform" },
    default_variant: { id: "uniform", name: "制服" },
  },
  pyrois: {
    renames: { base: "nude-armor", variant: "futanari" },
    default_variant: { id: "nude-armor", name: "裸身甲" },
  },
  wise: {
    renames: { base: "default" },
    default_variant: { id: "default", name: "默认" },
  },
};

// 无 base_description 可并入时新建 visual 条目使用的占位说明，与项目现有占位一致。
const PLACEHOLDER_VARIANT_DESCRIPTION = "待补充子设定视觉说明。";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// prompt.json：variants 键按映射改名，保留配置内容、片段 ID 与键顺序（原 base 本就在最前）。
export function migrateCharacterPromptVariants(source, plan) {
  if (!isRecord(source) || !isRecord(source.variants)) throw new Error("character prompt.variants 必须是对象");
  const document = structuredClone(source);
  let changed = false;
  for (const [from, to] of Object.entries(plan.renames)) {
    const hasFrom = Object.hasOwn(document.variants, from);
    const hasTo = Object.hasOwn(document.variants, to);
    if (hasFrom && hasTo) throw new Error(`character prompt.variants 同时包含 ${from} 与 ${to}，冲突未迁移`);
    if (!hasFrom && !hasTo) throw new Error(`character prompt.variants 缺少 ${from}，无法确认迁移状态`);
    if (!hasFrom) continue;
    document.variants = Object.fromEntries(Object.entries(document.variants)
      .map(([variantId, configuration]) => [variantId === from ? to : variantId, configuration]));
    changed = true;
  }
  return { document, changed };
}

// visual.json：base_description 并入新默认子设定条目并排 variants 最前，随后删除该字段；
// 无 base_description 时确保默认子设定条目存在（占位说明）；条目 id 按映射改名（base 不是 visual 条目 id）。
export function migrateCharacterVisualVariants(source, plan) {
  if (!isRecord(source) || !Array.isArray(source.variants)) throw new Error("character visual.variants 必须是数组");
  const document = structuredClone(source);
  let changed = false;
  const defaultId = plan.default_variant.id;
  const hasDefault = document.variants.some((variant) => variant?.id === defaultId);
  if (document.base_description !== undefined) {
    if (hasDefault) throw new Error(`character visual.variants 已存在 ${defaultId}，与 base_description 冲突，未迁移`);
    document.variants.unshift({
      id: defaultId,
      name: plan.default_variant.name,
      description: String(document.base_description),
    });
    delete document.base_description;
    changed = true;
  } else if (!hasDefault) {
    document.variants.unshift({ id: defaultId, name: plan.default_variant.name, description: PLACEHOLDER_VARIANT_DESCRIPTION });
    changed = true;
  }
  for (const [from, to] of Object.entries(plan.renames)) {
    if (from === "base") continue;
    const fromIndex = document.variants.findIndex((variant) => variant?.id === from);
    const hasTo = document.variants.some((variant) => variant?.id === to);
    if (fromIndex >= 0 && hasTo) throw new Error(`character visual.variants 同时包含 ${from} 与 ${to}，冲突未迁移`);
    if (fromIndex < 0) continue;
    document.variants[fromIndex] = { ...document.variants[fromIndex], id: to };
    changed = true;
  }
  return { document, changed };
}

// 角色视觉页 index 与剧情页 narrative 共用同一引用修正：缺 variant_id 补默认造型，旧 id 改名。
function migrateVariantReferences(references) {
  let changed = false;
  for (const reference of references) {
    const plan = VARIANT_MIGRATION_PLAN[reference?.character_id];
    if (!plan) continue;
    if (reference.variant_id === undefined) {
      reference.variant_id = plan.default_variant.id;
      changed = true;
    } else if (Object.hasOwn(plan.renames, reference.variant_id)) {
      reference.variant_id = plan.renames[reference.variant_id];
      changed = true;
    }
  }
  return changed;
}

export function migrateCharacterPagesIndexVariants(source) {
  if (!isRecord(source) || !Array.isArray(source.pages)) throw new Error("character pages index.pages 必须是数组");
  const document = structuredClone(source);
  const changed = migrateVariantReferences(document.pages);
  return { document, changed };
}

export function migrateStoryNarrativeVariants(source) {
  if (!isRecord(source) || !Array.isArray(source.characters)) throw new Error("narrative.characters 必须是数组");
  const document = structuredClone(source);
  const changed = migrateVariantReferences(document.characters);
  return { document, changed };
}

async function migrateJsonFile(target, relativePath, migrate, files) {
  const raw = await readFile(target, "utf8").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (raw === null) return;
  const report = { file: relativePath, status: "skipped" };
  files.push(report);
  let result;
  try {
    result = migrate(JSON.parse(raw));
  } catch (error) {
    report.status = "aborted";
    report.error = error.message;
    return;
  }
  if (!result.changed) return;
  const serialized = JSON.stringify(result.document, null, 2) + "\n";
  if (serialized === raw) return;
  await writeFile(target, serialized);
  report.status = "migrated";
}

export async function migrateProjectCharacterVariants(projectDirectory) {
  await requireIdleProject(projectDirectory);
  const files = [];
  for (const [characterId, plan] of Object.entries(VARIANT_MIGRATION_PLAN)) {
    await migrateJsonFile(
      path.join(projectDirectory, "characters", `${characterId}.prompt.json`),
      `characters/${characterId}.prompt.json`,
      (document) => migrateCharacterPromptVariants(document, plan),
      files,
    );
    await migrateJsonFile(
      path.join(projectDirectory, "characters", `${characterId}.visual.json`),
      `characters/${characterId}.visual.json`,
      (document) => migrateCharacterVisualVariants(document, plan),
      files,
    );
  }
  await migrateJsonFile(
    path.join(projectDirectory, "characters", "pages", "index.json"),
    "characters/pages/index.json",
    migrateCharacterPagesIndexVariants,
    files,
  );
  const storyPagesDirectory = path.join(projectDirectory, "story", "pages");
  const narrativeNames = (await readdir(storyPagesDirectory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)))
    .filter((name) => name.endsWith(".narrative.json"))
    .sort();
  for (const name of narrativeNames) {
    await migrateJsonFile(
      path.join(storyPagesDirectory, name),
      `story/pages/${name}`,
      migrateStoryNarrativeVariants,
      files,
    );
  }
  return { project_directory: projectDirectory, files };
}
