import { type PageKey } from "./page-key.ts";
import type {PageType} from './PageNavigationSummary';

export type NavigationUrlState = {
  projectId: string;
  activeTab: string;
  activePageKey: PageKey | null;
  activeCharacterId: string;
  activeCharacterSettingId: string;
  sceneId?: string;
  sceneSettingId?: string;
  storyPageType?:PageType;
  overviewTarget?:{kind:'overview'}|{kind:'chapter'|'sequence';id:string};
};

/** PageKey 不含归属；具体目录在工作台快照载入后解析。 */
export function pageKeyBelongsToTab(tab: string, pageKey: PageKey | null | undefined) {
  return Boolean(pageKey && ["story", "prompt-overview", "characters", "scenes", "orphan-pages"].includes(tab));
}

export function readNavigationUrlState(search: string): NavigationUrlState {
  const params = new URLSearchParams(search);
  const pageId = params.get("page");
  const pageType=params.get('page_type');
  const story=params.get('tab')==='project-story';
  return {
    projectId: params.get("project") ?? "",
    activeTab: params.get("tab") ?? "",
    activeCharacterId: params.get("character") ?? "",
    activeCharacterSettingId: params.get("setting") ?? "profile",
    sceneId: params.get("scene") ?? "",
    sceneSettingId: params.get("scene_setting") ?? "profile",
    activePageKey: pageId ? { page_id: pageId } : null,
    ...(story&&['text','image','video','comic','collage'].includes(pageType??'')?{storyPageType:pageType as PageType}:{}),
    ...(story&&params.get('sequence')?{overviewTarget:{kind:'sequence' as const,id:params.get('sequence')!}}:story&&params.get('chapter')?{overviewTarget:{kind:'chapter' as const,id:params.get('chapter')!}}:{}),
  };
}

export function syncNavigationUrl(url: URL, state: NavigationUrlState) {
  const next = new URL(url.toString());
  if (state.activeTab === "comparison" || state.activeTab.startsWith("lora-") || state.activeTab.startsWith("resource-")) next.searchParams.delete("project");
  else next.searchParams.set("project", state.projectId);
  next.searchParams.set("tab", state.activeTab);
  for (const key of ["page", "owner_kind", "owner", "character", "setting", "scene", "scene_setting",'chapter','sequence','page_type']) next.searchParams.delete(key);
  if(state.activeTab==='project-story'){
    if(state.storyPageType)next.searchParams.set('page_type',state.storyPageType);
    if(state.overviewTarget&&state.overviewTarget.kind!=='overview')next.searchParams.set(state.overviewTarget.kind,state.overviewTarget.id);
  }
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
