import assert from "node:assert/strict";
import test from "node:test";
import { readPopulation, setPopulation } from "../src/prompt-population.ts";

const fragment = (id, prompt_text, extra = {}) => ({ id, prompt_type: "danbooru", prompt_text, ...extra });
let nextId = 0;
const create = () => fragment(`draft-new-${++nextId}`, "");

test("单人与多人切换生成对应人数词并增删 solo，保留无关描述和已有片段身份", () => {
  const extra = fragment("token-extra", "an isolated subject", { prompt_type: "custom_description" });
  const initial = [fragment("token-girl", "1girl"), fragment("token-solo", "solo"), fragment("token-boy", "1boy", { enabled: false }), extra];
  assert.deepEqual(readPopulation(initial), { girls: 1, boys: 0 });
  const pair = setPopulation(initial, { girls: 1, boys: 1 }, create);
  assert.deepEqual(pair, [fragment("token-girl", "1girl"), fragment("token-boy", "1boy"), extra]);
  const single = setPopulation(pair, { girls: 0, boys: 1 }, create);
  assert.deepEqual(single.map(f => f.prompt_text), ["1boy", "solo", "an isolated subject"]);
  assert.equal(single[0].id, "token-boy");
  assert.deepEqual(setPopulation(single, { girls: 0, boys: 0 }, create), [extra]);
});

test("人数上限采用现有词库的群体标签，读取后可再次编辑", () => {
  const counts = { girls: 6, boys: 2 };
  const result = setPopulation([], counts, create);
  assert.deepEqual(result.map(f => f.prompt_text), ["6+girls", "2boys"]);
  assert.deepEqual(readPopulation(result), counts);
  assert.throws(() => setPopulation([], { girls: -1, boys: 0 }, create), RangeError);
});
