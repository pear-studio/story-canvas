import { type PageKey, pageKeyId } from "./page-key.ts";

const lastProjectStorageKey = "story-canvas:last-project:v1";
const collapsedStoragePrefix = "story-canvas:navigation-collapsed:v1";

export function navigationCollapsedStorageKey(projectId: string, section: "story" | "characters" | "scenes") {
  return `${collapsedStoragePrefix}:${section}:${projectId}`;
}

export function readCollapsedBranchKeys(storage: Pick<Storage, "getItem">, key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedBranchKeys(storage: Pick<Storage, "setItem">, key: string, collapsed: ReadonlySet<string>) {
  try {
    storage.setItem(key, JSON.stringify([...collapsed]));
  } catch { /* 存储不可用时仅保留会话内状态 */ }
}

export function readLastProjectId(storage: Pick<Storage, "getItem">) {
  try {
    return storage.getItem(lastProjectStorageKey) ?? "";
  } catch {
    return "";
  }
}

export function writeLastProjectId(storage: Pick<Storage, "setItem">, projectId: string) {
  try {
    storage.setItem(lastProjectStorageKey, projectId);
  } catch { /* 存储不可用时仅保留会话内状态 */ }
}

export function chooseInitialProjectId(projectIds: readonly string[], urlProjectId: string, storedProjectId: string) {
  if (urlProjectId && projectIds.includes(urlProjectId)) return urlProjectId;
  if (storedProjectId && projectIds.includes(storedProjectId)) return storedProjectId;
  return projectIds[0] ?? "";
}

type StoryOutlineBranches = {
  chapters: { id: string; sequences: { id: string; pages: { page_key: PageKey }[] }[] }[];
};

type CharacterBranches = {
  id: string;
  pages: { page_key: PageKey; variant_id?: string | null }[];
};

/** 选中剧情页时需要确保展开的章节/情节单元分支。 */
export function storyRevealBranchKeys(outline: StoryOutlineBranches, selectedKey: string | null) {
  if (!selectedKey) return [];
  for (const chapter of outline.chapters) {
    for (const sequence of chapter.sequences) {
      if (sequence.pages.some((page) => pageKeyId(page.page_key) === selectedKey)) {
        return [`chapter:${chapter.id}`, `sequence:${sequence.id}`];
      }
    }
  }
  return [];
}

/** 选中角色视觉页或正在查看角色设定时需要确保展开的角色/子设定分支。 */
export function characterRevealBranchKeys(characters: readonly CharacterBranches[], selectedKey: string | null, activeCharacterId: string | null, activeCharacterSettingId: string) {
  if (selectedKey) {
    for (const character of characters) {
      const page = character.pages.find((entry) => pageKeyId(entry.page_key) === selectedKey);
      if (page) {
        return [`character:${character.id}`, ...(page.variant_id ? [`variant:${character.id}:${page.variant_id}`] : [])];
      }
    }
    return [];
  }
  if (!activeCharacterId) return [];
  return [
    `character:${activeCharacterId}`,
    ...(activeCharacterSettingId && activeCharacterSettingId !== "profile" ? [`variant:${activeCharacterId}:${activeCharacterSettingId}`] : []),
  ];
}

/** 场景采用同样的子设定分支展开规则，但保持独立目录键。 */
export function sceneRevealBranchKeys(scenes: readonly CharacterBranches[], selectedKey: string | null, sceneId: string | null, settingId: string) {
  return characterRevealBranchKeys(scenes, selectedKey, sceneId, settingId).map(key => key.replace(/^character:/, "scene:"));
}
