import { resolveParticipantLoras } from "./lora-config.mjs";
import { validatePageKey } from "./page-key.mjs";
import { pagePromptAudit } from "./prompt-audit.mjs";
import { characterSource, sceneSource } from "./prompt-contract.mjs";
import { checkPagePromptOverrideReferences } from "./story-files.mjs";

const sentenceEndPattern = /[。！？.!?]$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function overrideText(pagePrompt, source) {
  const overrides = isRecord(pagePrompt?.text_overrides) ? pagePrompt.text_overrides : {};
  return Object.hasOwn(overrides, source) ? overrides[source] : null;
}

function imageLabel(indices, singleImage) {
  return singleImage ? "参考图" : indices.map((index) => `<image${index}>`).join("、");
}

/**
 * 确定性整段编译：全局文字、逐角色段、场景段、附图用途和本页描述。
 * referencePlan 由 page-render-resolver 与任务冻结共享，含每来源有序条目与扁平编号序列。
 */
export function compileCurrentPagePrompt({
  pageId,
  pageKey,
  pagePrompt,
  profile,
  characters = [],
  scenes = [],
  participantIds = [],
  referencePlan = { groups: [], page: { entries: [] }, sequence: [], errors: [] },
}) {
  const pageKeyErrors = validatePageKey(pageKey);
  if (pageKeyErrors.length) throw new TypeError(pageKeyErrors.join("；"));
  const missing = [];
  const errors = [...(referencePlan.errors ?? [])];
  const characterById = new Map(characters.map((character) => [character.id, character]));
  const activeReferences = participantIds
    .map((characterId) => ({ character_id: characterId, variant_id: characterById.get(characterId)?.configuration_id }))
    .filter((reference) => reference.variant_id);
  errors.push(...checkPagePromptOverrideReferences(pagePrompt, activeReferences));

  const globalText = typeof profile?.prompt?.text === "string" ? profile.prompt.text : null;
  if (globalText === null) missing.push(`${profile?.id ?? "当前生成配置"}.prompt.text`);

  const sequence = referencePlan.sequence ?? [];
  const indexBySource = new Map();
  sequence.forEach((entry, position) => {
    if (!indexBySource.has(entry.source)) indexBySource.set(entry.source, []);
    indexBySource.get(entry.source).push(position + 1);
  });
  const singleImage = sequence.length === 1;
  const groupBySource = new Map((referencePlan.groups ?? []).map((group) => [group.source, group]));

  const sections = [];
  const paragraphs = [];
  if (globalText) {
    sections.push({ kind: "global", text: globalText });
    paragraphs.push(globalText);
  }

  const settingSection = (kind, setting) => {
    const source = kind === "character"
      ? characterSource(setting.id, setting.configuration_id)
      : sceneSource(setting.id, setting.configuration_id);
    const promptName = typeof setting.prompt_name === "string" && setting.prompt_name.trim()
      ? setting.prompt_name : setting.id;
    const text = overrideText(pagePrompt, source) ?? setting.text ?? "";
    const indices = indexBySource.get(source) ?? [];
    const imageIds = (groupBySource.get(source)?.entries ?? []).map((entry) => entry.id);
    sections.push({ kind, source, prompt_name: promptName, text, ...(imageIds.length ? { image_ids: imageIds } : {}) });
    const lines = [`${promptName}：`];
    if (indices.length) {
      const reference = kind === "character" ? `${promptName}的身份与服装参考。` : `${promptName}的环境外观参考。`;
      lines.push(`${imageLabel(indices, singleImage)}：${reference}`);
    }
    if (text) lines.push(text);
    paragraphs.push(lines.join("\n"));
  };

  for (const characterId of participantIds) {
    const character = characterById.get(characterId);
    if (!character) {
      errors.push(`${pageId} 引用了未知角色：${characterId}`);
      continue;
    }
    settingSection("character", character);
  }
  for (const scene of scenes) settingSection("scene", scene);

  const pageEntries = referencePlan.page?.entries ?? [];
  pageEntries.forEach((entry, position) => {
    const purpose = typeof entry.purpose === "string" ? entry.purpose.trim() : "";
    if (!purpose) return;
    const index = sequence.length - pageEntries.length + position + 1;
    const text = sentenceEndPattern.test(purpose) ? purpose : `${purpose}。`;
    sections.push({ kind: "attachment", source: "page", text, image_ids: [entry.id] });
    paragraphs.push(`${imageLabel([index], singleImage)}：${text}`);
  });

  const pageText = typeof pagePrompt?.text === "string" ? pagePrompt.text : "";
  if (pageText.trim()) {
    sections.push({ kind: "page", text: pageText });
    paragraphs.push(`本页描述：\n${pageText}`);
  }

  const resolvedLoras = resolveParticipantLoras(profile, participantIds, characters, pageId, scenes);
  errors.push(...resolvedLoras.errors);

  const positive = paragraphs.join("\n\n");
  const audit = pagePromptAudit({ missing, errors, positive });
  return {
    page_key: structuredClone(pageKey),
    ready: missing.length === 0 && errors.length === 0 && positive.trim() !== "",
    missing,
    errors: [...new Set(errors)],
    positive_prompt: positive,
    negative_prompt: "",
    sections,
    images: sequence.map((entry, position) => ({
      index: position + 1,
      source: entry.source,
      id: entry.id,
      file: entry.file,
    })),
    audit,
    loras: resolvedLoras.loras,
  };
}
