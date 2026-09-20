import assert from "node:assert/strict";
import test from "node:test";

import { completedTaskPageLabel, formatTaskDuration, orderActiveTasks, remainingImageCount, taskBatchLabel, taskPagePreview, workbenchDocumentTitle } from "../src/task-summary.ts";

test("工作台标题按所有活动批次的剩余图片数汇总", () => {
  const tasks = [
    { item_counts: { running: 1, queued: 5 } },
    { item_counts: { running: 0, queued: 2 } },
  ];
  assert.equal(remainingImageCount(tasks), 8);
  assert.equal(workbenchDocumentTitle("雾桥·银刃", tasks), "[8] 雾桥·银刃");
  assert.equal(workbenchDocumentTitle("雾桥·银刃", []), "雾桥·银刃");
  assert.equal(workbenchDocumentTitle(null, []), "工作台");
});

test("最近完成记录显示页面名称并区分跨页批次", () => {
  assert.equal(completedTaskPageLabel({ current_page_order: 1, current_page_title: "雾塔与石桥", page_count: 1 }), "01 雾塔与石桥");
  assert.equal(completedTaskPageLabel({ current_page_order: 1, current_page_title: "雾塔与石桥", page_count: 3 }), "01 雾塔与石桥 · 共 3 页");
  assert.equal(completedTaskPageLabel({ current_page_order: null, current_page_title: null, page_count: 2 }), "共 2 页");
});

test("活动任务按实际执行顺序显示，正在采样优先且等待任务旧的在前", () => {
  const tasks = [
    { id: "newer-waiting", created_at: "2026-08-12T08:02:00.000Z", item_counts: { running: 1, queued: 2 }, progress: null },
    { id: "older-queued", created_at: "2026-08-12T08:00:00.000Z", item_counts: { running: 0, queued: 3 }, progress: null },
    { id: "sampling", created_at: "2026-08-12T08:01:00.000Z", item_counts: { running: 1, queued: 2 }, progress: { value: 1, max: 24 } },
  ];
  assert.deepEqual(orderActiveTasks(tasks).map((task) => task.id), ["sampling", "newer-waiting", "older-queued"]);
});

test("多页生成摘要保留批次规模并提供有限的页面预览", () => {
  const pages = [
    { order: 1, title: "雾塔与石桥", item_counts: { total: 3 } },
    { order: 2, title: "负伤归来", item_counts: { total: 3 } },
    { order: 3, title: "石上的爪声", item_counts: { total: 3 } },
    { order: 4, title: "雾中狼人", item_counts: { total: 3 } },
  ];
  assert.equal(taskBatchLabel("candidate", pages, 12), "候选图 · 4 页 / 12 张");
  assert.equal(taskPagePreview(pages), "01 雾塔与石桥、02 负伤归来、03 石上的爪声 等 4 页");
});

test("任务时长只按调用者传入的状态起止时间计算", () => {
  assert.equal(formatTaskDuration("2026-08-13T08:00:30.000Z", "2026-08-13T08:02:05.000Z"), "01:35");
  assert.equal(formatTaskDuration("2026-08-13T08:00:00.000Z", "2026-08-13T09:02:03.000Z"), "1:02:03");
  assert.equal(formatTaskDuration(null, "2026-08-13T09:02:03.000Z"), "");
});
