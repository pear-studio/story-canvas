import assert from "node:assert/strict";
import test from "node:test";

import { replaceWorkbenchPage } from "../src/workbench-page-patch.ts";

function storyPage(id, layoutSha256) {
  return { kind: "story", page_id: id, page_key: { page_id: id }, title: id, layout_sha256: layoutSha256, lettering: { page: id, items: [] } };
}

function characterPage(id) {
  return { kind: "character", page_id: id, page_key: { page_id: id }, title: id };
}

function view(pages, characterPages = []) {
  return {
    outline: { synopsis: "", chapters: [{ id: "c1", title: "c1", sequences: [{ id: "s1", title: "s1", pages }] }] },
    characters: [{ id: "ellen", pages: characterPages }],
  };
}

test("嵌字保存的新指纹广播到全部剧情页，避免下一页保存拿旧指纹撞 409", () => {
  const a = storyPage("page-a", "sha-old");
  const b = storyPage("page-b", "sha-old");
  const characterVisual = characterPage("page-c");
  const items = [{ dialogue_id: "dialogue-aaaaaaaaaaaa", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } }];

  const next = replaceWorkbenchPage(view([a, b], [characterVisual]), a, { lettering: { page: "page-a", items }, layout_sha256: "sha-new" });

  const [nextA, nextB] = next.outline.chapters[0].sequences[0].pages;
  assert.equal(nextA.layout_sha256, "sha-new");
  assert.deepEqual(nextA.lettering.items, items);
  assert.equal(nextB.layout_sha256, "sha-new", "整文档指纹必须同步到其他剧情页");
  assert.deepEqual(nextB.lettering, b.lettering, "其他页的排版内容不变");
  assert.equal(next.characters[0].pages[0].layout_sha256, "sha-new", "所有视觉页共享嵌字文档指纹");
});

test("不含嵌字指纹的页面更新不波及其他页", () => {
  const a = storyPage("page-a", "sha-old");
  const b = storyPage("page-b", "sha-old");

  const next = replaceWorkbenchPage(view([a, b]), a, { title: "新标题", content_sha256: "content-new" });

  const [nextA, nextB] = next.outline.chapters[0].sequences[0].pages;
  assert.equal(nextA.title, "新标题");
  assert.equal(nextA.content_sha256, "content-new");
  assert.equal(nextA.layout_sha256, "sha-old");
  assert.equal(nextB, b);
});

test("场景和待整理页面可局部更新，统一列表同步更新", () => {
  const scene = { ...characterPage("scene-page"), kind: "scene" };
  const orphan = characterPage("orphan-page");
  const before = { ...view([]), scenes: { scenes: [{ id: "room", pages: [scene] }] }, orphan_pages: [orphan], pages: [scene, orphan] };
  const next = replaceWorkbenchPage(before, scene, { title: "夜间", layout_sha256: "new" });
  assert.equal(next.scenes.scenes[0].pages[0].title, "夜间");
  assert.equal(next.pages[0].title, "夜间");
  assert.equal(next.orphan_pages[0].layout_sha256, "new");
});
