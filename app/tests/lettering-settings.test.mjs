import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  LETTERING_SETTINGS_SCHEMA_ID,
  defaultLetteringSettings,
  validateLetteringSettingsDocument,
} from "../server/lettering-settings.mjs";

test("统一嵌字设置契约同时约束排版预设和角色颜色", async () => {
  const schema = JSON.parse(await readFile(new URL("../../library/schemas/lettering-settings.schema.json", import.meta.url), "utf8"));
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const settings = defaultLetteringSettings();
  settings.character_colors = { ellen: "#C23A4D", guest: "#112233" };

  assert.equal(schema.$id, LETTERING_SETTINGS_SCHEMA_ID);
  assert.equal(validateSchema(settings), true);
  assert.deepEqual(validateLetteringSettingsDocument(settings), []);

  settings.character_colors.ellen = "red";
  assert.equal(validateSchema(settings), false);
  assert.ok(validateLetteringSettingsDocument(settings).some((error) => error.includes("character_colors.ellen")));
});
