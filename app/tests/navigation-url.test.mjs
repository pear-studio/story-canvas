import assert from "node:assert/strict";
import test from "node:test";
import { readNavigationUrlState, syncNavigationUrl } from "../src/navigation-restoration.ts";
const base = { projectId: "alpha", activeTab: "story", activePageKey: null, activeCharacterId: "", activeCharacterSettingId: "profile" };
const sync = state => new URL(syncNavigationUrl(new URL("http://local/workbench?owner_kind=character&owner=old#page"), { ...base, ...state }), "http://local");
test("三种归属与待整理页面 URL 只携带稳定页面身份", () => {
  for (const tab of ["story", "characters", "scenes", "orphan-pages"]) {
    const url = sync({ activeTab: tab, activePageKey: { page_id: "page-a" }, sceneId: "room", sceneSettingId: "night" });
    assert.equal(url.search, `?project=alpha&tab=${tab}&page=page-a`);
    assert.equal(url.pathname, "/workbench"); assert.equal(url.hash, "#page");
    assert.deepEqual(readNavigationUrlState(url.search).activePageKey, { page_id: "page-a" });
  }
});
test("场景和角色子设定深链保留设置且切换工具时清理", () => {
  const scene = sync({ activeTab: "scenes", sceneId: "room", sceneSettingId: "night" });
  assert.equal(scene.search, "?project=alpha&tab=scenes&scene=room&scene_setting=night");
  assert.equal(readNavigationUrlState(scene.search).sceneSettingId, "night");
  assert.equal(sync({ activeTab: "characters", activeCharacterId: "hero", activeCharacterSettingId: "daily" }).search, "?project=alpha&tab=characters&character=hero&setting=daily");
  assert.equal(sync({ activeTab: "resource-base", activePageKey: { page_id: "page-a" }, sceneId: "room" }).search, "?tab=resource-base");
});

test('剧情总览的范围与类型支持刷新恢复，编辑页 URL 不携带浏览筛选',()=>{
  for(const kind of ['chapter','sequence'])for(const type of ['image','text','video','comic']){
    const state={activeTab:'project-story',storyPageType:type,overviewTarget:{kind,id:'arrival'}};
    const url=sync(state),restored=readNavigationUrlState(url.search);
    assert.equal(restored.storyPageType,type);assert.deepEqual(restored.overviewTarget,state.overviewTarget);
    const next=new URL(syncNavigationUrl(url,{...base,...state,activeTab:'story',activePageKey:{page_id:'page-001'}}),'http://local');
    for(const key of ['page_type','chapter','sequence'])assert.equal(next.searchParams.has(key),false);
  }
  assert.equal(readNavigationUrlState('?tab=project-story&page_type=invalid').storyPageType,undefined);
});
