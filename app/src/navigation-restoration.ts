import { type PageKey } from "./page-key.ts";

export type NavigationUrlState = {
  projectId: string;
  activeTab: string;
  activePageKey: PageKey | null;
  activeCharacterId: string;
  activeCharacterSettingId: string;
  sceneId?: string;
  sceneSettingId?: string;
};

/** PageKey 不含归属；具体目录在工作台快照载入后解析。 */
export function pageKeyBelongsToTab(tab: string, pageKey: PageKey | null | undefined) {
  return Boolean(pageKey && ["story", "prompt-overview", "characters", "scenes", "orphan-pages"].includes(tab));
}

export function readNavigationUrlState(search: string): NavigationUrlState {
  const params = new URLSearchParams(search);
  const pageId = params.get("page");
  return {
    projectId: params.get("project") ?? "",
    activeTab: params.get("tab") ?? "",
    activeCharacterId: params.get("character") ?? "",
    activeCharacterSettingId: params.get("setting") ?? "profile",
    sceneId: params.get("scene") ?? "",
    sceneSettingId: params.get("scene_setting") ?? "profile",
    activePageKey: pageId ? { page_id: pageId } : null,
  };
}

export function syncNavigationUrl(url: URL, state: NavigationUrlState) {
  const next = new URL(url.toString());
  if (state.activeTab === "comparison" || state.activeTab.startsWith("lora-") || state.activeTab.startsWith("resource-")) next.searchParams.delete("project");
  else next.searchParams.set("project", state.projectId);
  next.searchParams.set("tab", state.activeTab);
  for (const key of ["page", "owner_kind", "owner", "character", "setting", "scene", "scene_setting"]) next.searchParams.delete(key);
  const pageKey = pageKeyBelongsToTab(state.activeTab, state.activePageKey) ? state.activePageKey : null;
  if (pageKey) next.searchParams.set("page", pageKey.page_id);
  if (state.activeTab === "characters" && !pageKey && state.activeCharacterId) {
    next.searchParams.set("character", state.activeCharacterId);
    if (state.activeCharacterSettingId && state.activeCharacterSettingId !== "profile") next.searchParams.set("setting", state.activeCharacterSettingId);
  }
  if (state.activeTab === "scenes" && !pageKey && state.sceneId) {
    next.searchParams.set("scene", state.sceneId);
    if (state.sceneSettingId && state.sceneSettingId !== "profile") next.searchParams.set("scene_setting", state.sceneSettingId);
  }
  return `${next.pathname}${next.search}${next.hash}`;
}
