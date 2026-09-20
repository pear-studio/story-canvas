import assert from "node:assert/strict";
import test from "node:test";

import {
  characterRevealBranchKeys,
  chooseInitialProjectId,
  navigationCollapsedStorageKey,
  readCollapsedBranchKeys,
  readLastProjectId,
  storyRevealBranchKeys,
  writeCollapsedBranchKeys,
  writeLastProjectId,
} from "../src/navigation-collapse.ts";


function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

test("无 URL 项目时优先恢复上次项目，其次列表第一项", () => {
  const ids = ["alpha", "beta"];
  assert.equal(chooseInitialProjectId(ids, "beta", "alpha"), "beta");
  assert.equal(chooseInitialProjectId(ids, "", "beta"), "beta");
  assert.equal(chooseInitialProjectId(ids, "", "missing"), "alpha");
  assert.equal(chooseInitialProjectId(ids, "missing", "missing-too"), "alpha");
  assert.equal(chooseInitialProjectId([], "", ""), "");
});

test("上次项目随激活写入本地存储", () => {
  const storage = memoryStorage();
  assert.equal(readLastProjectId(storage), "");
  writeLastProjectId(storage, "beta");
  assert.equal(readLastProjectId(storage), "beta");
});

test("分支收起状态按项目与分区读写", () => {
  const storage = memoryStorage();
  const storyKey = navigationCollapsedStorageKey("alpha", "story");
  const characterKey = navigationCollapsedStorageKey("alpha", "characters");
  assert.notEqual(storyKey, characterKey);
  assert.equal(navigationCollapsedStorageKey("beta", "story") === storyKey, false);
  writeCollapsedBranchKeys(storage, storyKey, new Set(["chapter:c1", "sequence:s1"]));
  assert.deepEqual([...readCollapsedBranchKeys(storage, storyKey)].sort(), ["chapter:c1", "sequence:s1"]);
  assert.deepEqual([...readCollapsedBranchKeys(storage, characterKey)], []);
});

test("损坏的存储内容回退为全部展开", () => {
  const storage = memoryStorage();
  storage.setItem("k", "{oops");
  assert.deepEqual([...readCollapsedBranchKeys(storage, "k")], []);
  storage.setItem("k", JSON.stringify({ nope: true }));
  assert.deepEqual([...readCollapsedBranchKeys(storage, "k")], []);
  storage.setItem("k", JSON.stringify(["a", 1, null]));
  assert.deepEqual([...readCollapsedBranchKeys(storage, "k")], ["a"]);
});

const outline = {
  chapters: [
    { id: "c1", sequences: [
      { id: "s1", pages: [{ page_key: { page_id: "p1" } }, { page_key: { page_id: "p2" } }] },
      { id: "s2", pages: [{ page_key: { page_id: "p3" } }] },
    ] },
    { id: "c2", sequences: [
      { id: "s3", pages: [{ page_key: { page_id: "p4" } }] },
    ] },
  ],
};

test("剧情页 reveal 定位到所属章节与情节单元", () => {
  assert.deepEqual(storyRevealBranchKeys(outline, "v3/p3"), ["chapter:c1", "sequence:s2"]);
  assert.deepEqual(storyRevealBranchKeys(outline, "v3/p4"), ["chapter:c2", "sequence:s3"]);
  assert.deepEqual(storyRevealBranchKeys(outline, "v3/missing"), []);
  assert.deepEqual(storyRevealBranchKeys(outline, null), []);
});

const characters = [
  { id: "hero", pages: [
    { page_key: { page_id: "cp1" }, variant_id: "daily" },
    { page_key: { page_id: "cp2" }, variant_id: null },
  ] },
  { id: "rival", pages: [
    { page_key: { page_id: "cp3" }, variant_id: "battle" },
  ] },
];

test("角色视觉页 reveal 定位到角色与子设定", () => {
  assert.deepEqual(characterRevealBranchKeys(characters, "v3/cp1", null, "profile"), ["character:hero", "variant:hero:daily"]);
  assert.deepEqual(characterRevealBranchKeys(characters, "v3/cp2", null, "profile"), ["character:hero"]);
  assert.deepEqual(characterRevealBranchKeys(characters, "v3/p1", null, "profile"), []);
});

test("未选中页面时按当前查看的角色 reveal", () => {
  assert.deepEqual(characterRevealBranchKeys(characters, null, "rival", "battle"), ["character:rival", "variant:rival:battle"]);
  assert.deepEqual(characterRevealBranchKeys(characters, null, "rival", "profile"), ["character:rival"]);
  assert.deepEqual(characterRevealBranchKeys(characters, null, null, "profile"), []);
});
