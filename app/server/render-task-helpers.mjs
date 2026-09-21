import { randomInt } from "node:crypto";

function clone(value) { return structuredClone(value); }
function triggerText(lora) { return typeof lora?.trigger === "string" ? lora.trigger.trim() : ""; }

export function uniqueCandidateSeeds(count, nextSeed = () => randomInt(0, 2 ** 31 - 1)) {
  if (!Number.isInteger(count) || count < 1) throw new Error("候选数量必须是正整数");
  const seeds = [];
  const used = new Set();
  for (let index = 0; index < count; index += 1) {
    let seed = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = Number(nextSeed());
      if (!Number.isInteger(candidate) || candidate < 0 || candidate > 2 ** 31 - 1) throw new Error("随机种子超出可用范围");
      if (!used.has(candidate)) { seed = candidate; break; }
    }
    if (seed == null) {
      seed = seeds.length ? (seeds.at(-1) + 1) % (2 ** 31) : 0;
      while (used.has(seed)) seed = (seed + 1) % (2 ** 31);
    }
    used.add(seed);
    seeds.push(seed);
  }
  return seeds;
}

export function candidateSeedSequence(count, startSeed = null, nextSeed = () => randomInt(0, 2 ** 31 - 1)) {
  if (startSeed == null) return uniqueCandidateSeeds(count, nextSeed);
  if (!Number.isInteger(count) || count < 1) throw new Error("候选数量必须是正整数");
  if (!Number.isInteger(startSeed) || startSeed < 0 || startSeed > 2 ** 31 - 1) throw new Error("指定种子超出可用范围");
  if (startSeed + count - 1 > 2 ** 31 - 1) throw new Error("指定种子与候选数量超出可用范围");
  return Array.from({ length: count }, (_, index) => startSeed + index);
}

export function freezePageLorasForTask(page, projection) {
  const frozen = (page?.loras ?? []).map((lora) => clone(lora));
  const byFilename = new Map(frozen.map((lora) => [lora.filename, lora]));
  const sources = [
    ...(projection?.active_character_settings ?? []).map(setting => ({ ...setting, owner: setting.character_id, kind: "character" })),
    ...(projection?.active_scene_settings ?? []).map(setting => ({ ...setting, owner: setting.scene_id, kind: "scene" })),
  ];
  for (const setting of sources) {
    for (const lora of setting?.loras ?? []) {
      const trigger = triggerText(lora);
      const binding = lora ? byFilename.get(lora.filename) : null;
      if (!trigger || !binding) continue;
      binding.activation_triggers ??= [];
      binding.activation_triggers.push({ text: trigger, owner: setting.owner, kind: setting.kind });
    }
  }
  return frozen;
}
