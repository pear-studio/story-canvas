import assert from "node:assert/strict";
import test from "node:test";

import { previewLetteringItems, darkenDisplayColor, geometryIssues, letteringPreset, letteringTypographyVariables, neutralLetteringColor } from "../src/lettering.ts";

const style = {
  font_family: "LXGW WenKai",
  font_size: 42,
  character_speech: { direction: "vertical", kind: "balloon" },
  character_thought: { direction: "vertical", kind: "plain" },
  npc_speech: { direction: "horizontal", kind: "balloon" },
};

test("文案语义确定项目统一预设，NPC 不冒充正式角色", () => {
  assert.equal(letteringPreset({ id: "1", mode: "speech", speaker: "hero", text: "走。" }, style), style.character_speech);
  assert.equal(letteringPreset({ id: "2", mode: "thought", speaker: "hero", text: "不对。" }, style), style.character_thought);
  assert.equal(letteringPreset({ id: "3", mode: "speech", speaker: "npc", text: "请进。" }, style), style.npc_speech);
  assert.deepEqual(letteringPreset({ id: "4", mode: "narration", text: "夜深了。" }, style), { direction: "horizontal", kind: "plain" });
});

test("角色标识色保留色相并压暗，非法颜色回退为中性墨色", () => {
  assert.equal(darkenDisplayColor("#E75A78"), "#8c2138");
  assert.equal(darkenDisplayColor("#888888"), "#575757");
  assert.equal(darkenDisplayColor("not-a-color"), neutralLetteringColor);
});

test("设置样张与页面预览按同一画布宽度缩放", () => {
  assert.deepEqual(letteringTypographyVariables(style, 1), {
    "--lettering-font-family": '"LXGW WenKai", "Microsoft YaHei", sans-serif',
    "--lettering-font-size": "42px",
    "--lettering-canvas-unit": "10.24px",
  });
  assert.deepEqual(letteringTypographyVariables(style, 340.5 / 1024), {
    "--lettering-font-family": '"LXGW WenKai", "Microsoft YaHei", sans-serif',
    "--lettering-font-size": "13.9658203125px",
    "--lettering-canvas-unit": "3.405px",
  });
  assert.deepEqual(letteringTypographyVariables(style, "canvas"), {
    "--lettering-font-family": '"LXGW WenKai", "Microsoft YaHei", sans-serif',
    "--lettering-font-size": "4.1015625cqw",
    "--lettering-canvas-unit": "1cqw",
  });
  assert.equal(letteringTypographyVariables({ ...style, font_family: 'Demo "Font"' }, 1)["--lettering-font-family"], '"Demo Font", "Microsoft YaHei", sans-serif');
});

test("结构检查只报告客观的边缘与明显重叠问题", () => {
  const items = [
    { dialogue_id: "a", box: { x: 0.01, y: 0.08, w: 0.4, h: 0.2 } },
    { dialogue_id: "b", box: { x: 0.3, y: 0.12, w: 0.35, h: 0.2 } },
    { dialogue_id: "c", box: { x: 0.7, y: 0.7, w: 0.2, h: 0.15 } },
  ];
  assert.deepEqual([...geometryIssues(items).get("a")].sort(), ["edge", "overlap"]);
  assert.deepEqual([...geometryIssues(items).get("b")], ["overlap"]);
  assert.deepEqual([...geometryIssues(items).get("c")], []);
});

test("预览自动补全已保存文案位置，保留手动草稿且不改写输入", () => {
  const dialogue = [
    { id: "a", mode: "narration", text: "门口" },
    { id: "b", mode: "speech", speaker: "hero", text: "进来。" },
    { mode: "narration", text: "尚未保存的新文案" },
  ];
  const items = [{ dialogue_id: "a", box: { x: 0.4, y: 0.5, w: 0.3, h: 0.1 } }];
  const before = structuredClone(items);
  const preview = previewLetteringItems(dialogue, items, style);
  assert.deepEqual(preview.map((item) => item.dialogue_id), ["b"], "旁白固定在底部字幕条，不产生也不保留布局项");
  assert.deepEqual(items, before);
  assert.deepEqual(previewLetteringItems(dialogue, preview, style), preview);
  assert.deepEqual(previewLetteringItems([], items, style), []);
});
