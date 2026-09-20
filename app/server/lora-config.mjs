const sha256Pattern = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStableIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSafeLoraFilename(value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) return false;
  if (value.includes("\\") || value.includes("\0") || value.includes(":")) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

export function validateLoraDefinition(value, prefix) {
  const errors = [];
  if (!isRecord(value)) return [`${prefix} 必须是对象`];
  const allowed = new Set(["filename", "sha256", "weight", "trigger"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${prefix} 包含未知字段：${key}`);
  }
  if (!isSafeLoraFilename(value.filename)) errors.push(`${prefix}.filename 必须是 loras 目录下的安全相对路径`);
  if (typeof value.sha256 !== "string" || !sha256Pattern.test(value.sha256)) {
    errors.push(`${prefix}.sha256 必须是 64 位小写十六进制字符串`);
  }
  if (typeof value.weight !== "number" || !Number.isFinite(value.weight) || value.weight < -2 || value.weight > 2) {
    errors.push(`${prefix}.weight 必须是 -2 到 2 之间的有限数值`);
  }
  if (value.trigger !== undefined && (typeof value.trigger !== "string" || !value.trigger.trim())) {
    errors.push(`${prefix}.trigger 必须是非空字符串`);
  }
  return errors;
}

export function validateStyleLoras(profile) {
  if (!isRecord(profile?.style_loras)) return [`${profile?.id ?? "当前生成配置"}.style_loras 必须是对象`];
  return Object.keys(profile.style_loras).sort(compareStableIds)
    .flatMap((id) => validateLoraDefinition(profile.style_loras[id], `${profile.id ?? "当前生成配置"}.style_loras.${id}`));
}

function normalizedLora(lora, kind, owner) {
  return {
    kind,
    owner,
    filename: lora.filename,
    sha256: lora.sha256,
    weight: lora.weight,
  };
}

export function resolveParticipantLoras(profile, participantIds, characters = [], pageId = "当前页面", scenes = []) {
  const errors = [...validateStyleLoras(profile)];
  const resolved = [];
  const byFilename = new Map();

  function append(lora, kind, owner, prefix) {
    const validation = validateLoraDefinition(lora, prefix);
    errors.push(...validation);
    if (validation.length) return;
    const next = normalizedLora(lora, kind, owner);
    const current = byFilename.get(next.filename);
    if (current) {
      if (current.sha256 !== next.sha256 || current.weight !== next.weight) {
        errors.push(`${pageId} 的 LoRA ${next.filename} 在 ${current.kind}:${current.owner} 与 ${kind}:${owner} 之间配置冲突`);
      }
      return;
    }
    byFilename.set(next.filename, next);
    resolved.push(next);
  }

  for (const id of Object.keys(profile.style_loras ?? {}).sort(compareStableIds)) {
    append(profile.style_loras[id], "style", profile.id, `${profile.id}.style_loras.${id}`);
  }

  const characterById = new Map(characters.map((character) => [character.id, character]));
  const sources = [
    ...(participantIds ?? []).map(id => ({ kind: "character", owner: id, value: characterById.get(id) })),
    ...scenes.map(scene => ({ kind: "scene", owner: scene.id, value: scene })),
  ];
  for (const { kind, owner, value } of sources) {
    for (const [index, lora] of (Array.isArray(value?.loras) ? value.loras : []).entries()) {
      append(lora, kind, owner, `${kind}s.${owner}.loras[${index}]`);
    }
  }

  return { loras: resolved, errors: [...new Set(errors)] };
}

export function styleLoraTriggers(profile) {
  return [...new Set(Object.keys(profile?.style_loras ?? {}).sort(compareStableIds)
    .map((id) => profile.style_loras[id])
    .map((lora) => typeof lora?.trigger === "string" ? lora.trigger.trim() : "")
    .filter(Boolean))];
}
