import assert from "node:assert/strict";
import test from "node:test";
import { initialWorkbenchNavigation, projectNavigation, openNavigationPage, openNavigationCharacter, openNavigationScene, openNavigationTab, reconcileNavigation } from "../src/workbench-navigation.ts";
import { syncNavigationUrl } from "../src/navigation-restoration.ts";
import { rememberNavigation } from "../src/navigation-history.ts";

const story = id => ({ kind: "story", page_id: id, page_key: { page_id: id } });
const portrait = (id, owner = "alice", variant = "daily") => ({ kind: "character", page_id: id, page_key: { page_id: id }, character_id: owner, variant_id: variant });
const view = (first = [story("a"), story("b"), story("c")], portraits = [portrait("p1"), portrait("p2")]) => ({
  project: { id: "alpha" },
  outline: { chapters: [{ sequences: [{ id: "one", pages: first }, { id: "two", pages: [story("other")] }] }] },
  characters: [{ id: "alice", visual: { variants: [{ id: "daily" }, { id: "dress" }] }, pages: portraits }, { id: "bob", visual: { variants: [{ id: "daily" }] }, pages: [portrait("bob-page", "bob")] }],
});

test("会话历史保留页内标签，后台更新不新增记录，返回后新跳转丢弃前进分支，切项目重置", () => {
  const a = openNavigationPage(projectNavigation('alpha'), story('a').page_key, view());
  const b = openNavigationPage(a, story('b').page_key, view());
  let history = rememberNavigation({ entries: [], index: -1 }, a);
  history = rememberNavigation(history, { ...a, editorTab: 'lettering' }, true);
  history = rememberNavigation(history, b);
  history = rememberNavigation(history, { ...b }, true);
  assert.deepEqual(history.entries.map(entry => [entry.activePageKey.page_id, entry.editorTab]), [['a', 'lettering'], ['b', 'visual']]);
  const inTools = rememberNavigation(history, openNavigationTab(b, 'lora-datasets', view()));
  assert.deepEqual(inTools, history);
  history = rememberNavigation({ ...history, index: 0 }, { ...projectNavigation('alpha'), activeTab: 'scenes', sceneId: 'wall' });
  assert.deepEqual(history.entries.map(entry => entry.activeTab), ['story', 'scenes']);
  assert.equal(history.entries[1].sceneId, 'wall');
  history = rememberNavigation(history, projectNavigation('beta'));
  assert.deepEqual(history, { entries: [projectNavigation('beta')], index: 0 });
});

test("切项目回项目管理，深链和任务跳转仍打开指定页且 URL 对应当前视图", () => {
  const initial = initialWorkbenchNavigation("?project=alpha&tab=characters&page=p2");
  const restored = reconcileNavigation(initial, null, view());
  assert.equal(restored.activeCharacterSettingId, "daily");
  assert.deepEqual(restored.activePageKey, portrait("p2").page_key);
  assert.deepEqual(reconcileNavigation(projectNavigation("alpha"), null, view()), projectNavigation("alpha"));
  const task = openNavigationPage(projectNavigation("alpha"), story("c").page_key, null);
  assert.deepEqual(reconcileNavigation(task, null, view()).activePageKey, story("c").page_key);
  const url = new URL(syncNavigationUrl(new URL("http://local/?project=alpha&tab=story&page=c"), projectNavigation("beta")), "http://local");
  assert.equal(url.search, "?project=beta&tab=project-settings");
  assert.equal(reconcileNavigation(projectNavigation("beta"), null, view()).projectId, "beta", "其他项目的快照不能改变导航");
});

test("当前页删除后取原组后一页、否则前一页，连续删除和其他组不会干扰回退", () => {
  const before = view();
  const current = openNavigationPage(projectNavigation("alpha"), story("b").page_key, before);
  assert.deepEqual(reconcileNavigation(current, before, view([story("c"), story("b"), story("a")])).activePageKey, story("b").page_key);
  assert.deepEqual(reconcileNavigation(current, before, view([story("a"), story("c")])).activePageKey, story("c").page_key);
  assert.deepEqual(reconcileNavigation(current, before, view([story("a")])).activePageKey, story("a").page_key);
  const empty = reconcileNavigation(current, before, view([]));
  assert.equal(empty.activePageKey, null);
  assert.equal(reconcileNavigation(empty, view([]), view([])).activePageKey, null, "后续刷新保持空态，不跳到其他单元");
});

test("角色页回退不跨角色或子设定，删空后保持空态", () => {
  const before = view();
  const current = openNavigationPage(projectNavigation("alpha"), portrait("p1").page_key, before);
  assert.deepEqual(reconcileNavigation(current, before, view(undefined, [portrait("p2")])).activePageKey, portrait("p2").page_key);
  const after = view(undefined, [portrait("dress-page", "alice", "dress")]);
  const empty = reconcileNavigation(current, before, after);
  assert.equal(empty.activePageKey, null);
  assert.equal(empty.activeCharacterId, "");
  assert.deepEqual(reconcileNavigation(empty, after, after), empty);
});

test("标签切换不残留隐藏页面，角色设定刷新保持位置并回退已删除的子设定", () => {
  const before = view();
  const current = openNavigationPage(projectNavigation("alpha"), story("c").page_key, before);
  const settings = openNavigationTab(current, "project-settings", before);
  assert.equal(settings.activePageKey, null);
  assert.deepEqual(reconcileNavigation(settings, before, before), settings);
  const character = openNavigationCharacter(current, "alice", "dress");
  assert.equal(character.activePageKey, null);
  assert.deepEqual(reconcileNavigation(character, before, before), character);
  const after = view(); after.characters[0].visual.variants = [{ id: "daily" }];
  assert.equal(reconcileNavigation(character, before, after).activeCharacterSettingId, "profile");
});

test("移动归属保持页面和编辑标签，删除设定后的待整理页仍可定位", () => {
  const before = view();
  const current = { ...openNavigationPage(projectNavigation("alpha"), portrait("p1").page_key, before), editorTab: "lettering" };
  const after = view(undefined, [portrait("p2")]);
  const moved = { ...portrait("p1"), kind: "scene", scene_id: "room", variant_id: "night" };
  after.scenes = { scenes: [{ id: "room", visual: { variants: [{ id: "night" }] }, pages: [moved] }] };
  const resolved = reconcileNavigation(current, before, after);
  assert.equal(resolved.activeTab, "scenes"); assert.equal(resolved.sceneSettingId, "night");
  assert.equal(resolved.editorTab, "lettering"); assert.equal(resolved.activeCharacterId, "");
  const orphaned = { ...after, scenes: { scenes: [] }, orphan_pages: [moved] };
  const orphan = reconcileNavigation(resolved, after, orphaned);
  assert.equal(orphan.activeTab, "orphan-pages"); assert.deepEqual(orphan.activePageKey, { page_id: "p1" });
  assert.equal(reconcileNavigation(initialWorkbenchNavigation("?project=alpha&page=p1"), null, orphaned).activeTab, "orphan-pages");
});

test("场景子设定刷新保留位置，失效时回基础设定；历史区分子设定", () => {
  const next = view(); next.scenes = { scenes: [{ id: "room", visual: { variants: [{ id: "night" }] }, pages: [] }] };
  const current = openNavigationScene(projectNavigation("alpha"), "room", "night");
  assert.deepEqual(reconcileNavigation(current, next, next), current);
  const history = rememberNavigation(rememberNavigation({ entries: [], index: -1 }, current), openNavigationScene(current, "room", "profile"));
  assert.equal(history.entries.length, 2);
  const after = structuredClone(next); after.scenes.scenes[0].visual.variants = [];
  assert.equal(reconcileNavigation(current, next, after).sceneSettingId, "profile");
});
