import test from "node:test";
import assert from "node:assert/strict";
import { compileCurrentPagePrompt } from "../server/current-page-prompt.mjs";
import { freezePageLorasForTask } from "../server/render-task-helpers.mjs";
import { diagnoseResolvedLoras } from "../server/render-profile-diagnostics.mjs";

const prompt = (setting = []) => ({ subject: [], person: [], setting, camera: [], avoid: [] });
const lora = (name, trigger, weight = 1) => ({ filename: `${name}.safetensors`, sha256: "a".repeat(64), weight, trigger });
function fixture() {
  const scene = { id: "station", name: "车站", configuration_id: "night",
    identity: { prompt: prompt([{ description: "station platform" }]) },
    prompt: prompt([{ description: "moonlit platform" }]),
    identity_overrides: { "station platform": { weight: 0.8 } },
    loras: [lora("station", "station_token"), lora("night", "night_token")],
  };
  return { pageId: "page-001", pageKey: { page_id: "page-001" }, scenes: [scene],
    pagePrompt: { ...prompt(), scene_id: "station", scene_variant_id: "night",
      inheritance: { "scene:station:night": { "moonlit platform": { weight: 1.2 } } } },
    profile: { id: "test", style_loras: {}, models: { dit: { sha256: "a".repeat(64) } },
      prompt: { family: "anima", category_order: ["subject", "person", "setting", "camera"], avoidance_strategy: "negative_prompt", fragments: {} } },
  };
}

test("场景基础与子设定 Prompt/LoRA 编译、来源冻结", () => {
  const args = fixture();
  const compiled = compileCurrentPagePrompt(args);
  assert.deepEqual(compiled.errors, []);
  assert.deepEqual(compiled.missing, []);
  assert.match(compiled.positive_prompt, /station_token/);
  assert.match(compiled.positive_prompt, /night_token/);
  assert.match(compiled.positive_prompt, /\(station platform:0.8\)/);
  assert.match(compiled.positive_prompt, /\(moonlit platform:1.2\)/);
  assert.deepEqual(compiled.loras.map(value => value.kind), ["scene", "scene"]);
  assert.match(compiled.prompt_parts.positive.find(part => part.prompt_text === "station platform").path, /identity.prompt.setting/);
  const frozen = freezePageLorasForTask(compiled, { active_scene_settings: [{ scene_id: "station", loras: args.scenes[0].loras }] });
  assert.deepEqual(frozen[0].activation_triggers, [{ text: "station_token", kind: "scene", owner: "station" }]);

});

test("场景 LoRA 和角色同文件配置冲突不静默覆盖", () => {
  const args = fixture();
  args.participantIds = ["alice"];
  args.characters = [{ id: "alice", configuration_id: "default", identity: { prompt: prompt() }, prompt: prompt(), loras: [lora("station", "character_token", 0.6)] }];
  assert.match(compileCurrentPagePrompt(args).errors.join(" "), /character:alice 与 scene:station 之间配置冲突/);
});

test("场景 LoRA 使用共同文件诊断", async () => {
  const args = fixture();
  const compiled = compileCurrentPagePrompt(args);
  const diagnosis = await diagnoseResolvedLoras(compiled.loras, process.cwd(), { comfyui_urls: ["http://192.0.2.1:8188"] });
  assert.deepEqual(diagnosis.map(value => value.kind), ["scene", "scene"]);
});
