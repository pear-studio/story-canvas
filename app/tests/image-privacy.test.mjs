import assert from "node:assert/strict";
import test from "node:test";

import { IMAGE_PRIVACY_STORAGE_KEY, applyImagePrivacy, initializeImagePrivacy, persistImagePrivacy } from "../src/image-privacy.mjs";

test("图片隐私状态可跨刷新恢复并写入页面显示状态", () => {
  const values = new Map([[IMAGE_PRIVACY_STORAGE_KEY, "hidden"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const root = { dataset: {} };

  assert.equal(initializeImagePrivacy(storage, root), true);
  assert.equal(root.dataset.imagePrivacy, "hidden");

  persistImagePrivacy(storage, root, false);
  assert.equal(root.dataset.imagePrivacy, "visible");
  assert.equal(values.get(IMAGE_PRIVACY_STORAGE_KEY), "visible");
});

test("长按透视只临时改变页面显示，不覆盖持久隐私状态", () => {
  const values = new Map([[IMAGE_PRIVACY_STORAGE_KEY, "hidden"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const root = { dataset: {} };

  assert.equal(initializeImagePrivacy(storage, root), true);
  applyImagePrivacy(root, "peek");

  assert.equal(root.dataset.imagePrivacy, "peek");
  assert.equal(values.get(IMAGE_PRIVACY_STORAGE_KEY), "hidden");

  persistImagePrivacy(storage, root, true);
  assert.equal(root.dataset.imagePrivacy, "hidden");
});

test("浏览器存储不可用时当前页面仍可隐藏图片", () => {
  const storage = {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
  };
  const root = { dataset: {} };

  assert.equal(initializeImagePrivacy(storage, root), false);
  assert.equal(root.dataset.imagePrivacy, "visible");

  assert.doesNotThrow(() => persistImagePrivacy(storage, root, true));
  assert.equal(root.dataset.imagePrivacy, "hidden");
});
