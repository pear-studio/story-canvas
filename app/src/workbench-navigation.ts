import { pageKeyId, samePageKey, type PageKey } from "./page-key.ts";
import { pageKeyBelongsToTab, readNavigationUrlState, type NavigationUrlState } from "./navigation-restoration.ts";
import type { ProjectWorkbenchView, WorkbenchPage } from "./project-workbench-client.ts";

const tabs = ["project-home", "scenes", "orphan-pages", "prompt-overview", "finished", "project-story", "project-settings", "project-render-profile", "project-lettering", "project-tasks", "project-materials", "comparison", "resource-base", "resource-loras", "lora-datasets", "lora-tasks", "lora-runs", "characters", "story"] as const;
export type ActiveTab = typeof tabs[number];
export type NavigationState = Omit<NavigationUrlState, "activeTab"> & { activeTab: ActiveTab; editorTab?: "visual" | "lettering" | "flow"; overviewTarget?: { kind: "overview" } | { kind: "chapter" | "sequence"; id: string } };

export function projectNavigation(projectId: string): NavigationState {
  return { projectId, activeTab: "project-home", activePageKey: null, activeCharacterId: "", activeCharacterSettingId: "profile", sceneId: "", sceneSettingId: "profile" };
}

export function initialWorkbenchNavigation(search: string): NavigationState {
  const requested = readNavigationUrlState(search);
  const activeTab = tabs.includes(requested.activeTab as ActiveTab) ? requested.activeTab as ActiveTab : requested.activePageKey ? "story" : "project-settings";
  return { ...requested, activeTab, activePageKey: pageKeyBelongsToTab(activeTab, requested.activePageKey) ? requested.activePageKey : null };
}

function pageLocations(view: ProjectWorkbenchView | null) {
  if (!view) return [];
  return [
    ...view.outline.chapters.flatMap(chapter => chapter.sequences.flatMap(sequence => sequence.pages.map(page => ({ page, group: `story:${sequence.id}`, tab: "story" as ActiveTab, ownerId: "" })))),
    ...view.characters.flatMap(character => character.pages.map(page => ({ page, group: `character:${character.id}:${page.variant_id}`, tab: "characters" as ActiveTab, ownerId: character.id }))),
    ...(view.scenes?.scenes ?? []).flatMap(scene => scene.pages.map(page => ({ page, group: `scene:${scene.id}:${page.variant_id}`, tab: "scenes" as ActiveTab, ownerId: scene.id }))),
    ...(view.orphan_pages ?? []).map(page => ({ page, group: "orphan-pages", tab: "orphan-pages" as ActiveTab, ownerId: "" })),
  ];
}

export function allWorkbenchPages(view: ProjectWorkbenchView | null): WorkbenchPage[] {
  return [...new Map(pageLocations(view).map(({ page }) => [pageKeyId(page.page_key), page])).values()];
}

export function openNavigationPage(state: NavigationState, pageKey: PageKey, view: ProjectWorkbenchView | null, tab?: ActiveTab): NavigationState {
  const location = pageLocations(view).find(item => samePageKey(item.page.page_key, pageKey));
  const activeTab = location ? (tab === "prompt-overview" && location.tab === "story" ? tab : location.tab) : tab ?? "story";
  return { ...state, activeTab, activePageKey: pageKey, editorTab: samePageKey(state.activePageKey, pageKey) ? state.editorTab : "visual",
    activeCharacterId: location?.tab === "characters" ? location.ownerId : "",
    activeCharacterSettingId: location?.tab === "characters" ? location.page.variant_id ?? "profile" : "profile",
    sceneId: location?.tab === "scenes" ? location.ownerId : "",
    sceneSettingId: location?.tab === "scenes" ? location.page.variant_id ?? "profile" : "profile" };
}

export function openNavigationCharacter(state: NavigationState, characterId: string, settingId: string): NavigationState {
  return { ...state, activeTab: "characters", activePageKey: null, activeCharacterId: characterId, activeCharacterSettingId: settingId, sceneId: "", sceneSettingId: "profile" };
}

export function openNavigationScene(state: NavigationState, sceneId: string, settingId: string): NavigationState {
  return { ...state, activeTab: "scenes", activePageKey: null, activeCharacterId: "", activeCharacterSettingId: "profile", sceneId, sceneSettingId: settingId };
}

export function openNavigationTab(state: NavigationState, activeTab: ActiveTab, view: ProjectWorkbenchView | null): NavigationState {
  if (state.activeTab === activeTab) return state;
  const next = { ...projectNavigation(state.projectId), activeTab };
  if (activeTab === "story" || activeTab === "prompt-overview" || activeTab === "orphan-pages") {
    const page = pageLocations(view).find(item => item.tab === (activeTab === "orphan-pages" ? "orphan-pages" : "story"))?.page;
    return page ? openNavigationPage(next, page.page_key, view, activeTab) : next;
  }
  if (activeTab === "characters" && view?.characters[0]) return openNavigationCharacter(next, view.characters[0].id, "profile");
  if (activeTab === "scenes" && view?.scenes?.scenes[0]) return openNavigationScene(next, view.scenes.scenes[0].id, "profile");
  return next;
}

/** 首次载入、后台刷新与导航操作后的刷新使用同一回退规则。 */
export function reconcileNavigation(state: NavigationState, previous: ProjectWorkbenchView | null, next: ProjectWorkbenchView): NavigationState {
  if (state.projectId !== next.project.id) return state;
  const available = pageLocations(next);
  if (state.activePageKey) {
    const retained = available.find(item => samePageKey(item.page.page_key, state.activePageKey));
    if (retained) return openNavigationPage(state, retained.page.page_key, next, state.activeTab);
    const before = pageLocations(previous);
    const old = before.find(item => samePageKey(item.page.page_key, state.activePageKey));
    if (old) {
      const siblings = before.filter(item => item.group === old.group);
      const index = siblings.indexOf(old);
      const byId = new Map(available.filter(item => item.group === old.group).map(item => [pageKeyId(item.page.page_key), item.page]));
      const neighbour = [...siblings.slice(index + 1), ...siblings.slice(0, index).reverse()].map(item => byId.get(pageKeyId(item.page.page_key))).find((page): page is WorkbenchPage => Boolean(page));
      if (neighbour) return openNavigationPage(state, neighbour.page_key, next, state.activeTab);
    }
    return { ...state, activePageKey: null, activeCharacterId: "", activeCharacterSettingId: "profile", sceneId: "", sceneSettingId: "profile" };
  }
  if (!previous && (state.activeTab === "story" || state.activeTab === "prompt-overview" || state.activeTab === "orphan-pages")) {
    const first = available.find(item => item.tab === (state.activeTab === "orphan-pages" ? "orphan-pages" : "story"));
    if (first) return openNavigationPage(state, first.page.page_key, next, state.activeTab);
  }
  if (state.activeTab === "characters") {
    const character = next.characters.find(item => item.id === state.activeCharacterId) ?? (!previous ? next.characters[0] : null);
    if (!character) return { ...state, activeCharacterId: "", activeCharacterSettingId: "profile" };
    const setting = character.visual.variants.some(item => item.id === state.activeCharacterSettingId) ? state.activeCharacterSettingId : "profile";
    return openNavigationCharacter(state, character.id, setting);
  }
  if (state.activeTab === "scenes") {
    const scene = next.scenes?.scenes.find(item => item.id === state.sceneId) ?? (!previous ? next.scenes?.scenes[0] : null);
    if (!scene) return { ...state, sceneId: "", sceneSettingId: "profile" };
    const setting = scene.visual.variants.some(item => item.id === state.sceneSettingId) ? state.sceneSettingId! : "profile";
    return openNavigationScene(state, scene.id, setting);
  }
  return state;
}
