import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { emptyCreativeAgreement, emptyMaterialMetadata, validateCreativeAgreement, validateMaterialMetadata } from "../server/project-contracts.mjs";
import { deleteMaterial, readProjectMaterials, saveCreativeAgreement, saveMaterial } from "../server/project-materials.mjs";

test("创作约定使用单层规则并完整持久化强度与正文", async t => {
  const project = await mkdtemp(path.join(tmpdir(), "project-materials-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const agreement = {
    items: [
      { id: "agreement-name", strength: "hard", text: "角色名称只写作希格莉德。" },
      { id: "agreement-tone", strength: "preference", text: "整体氛围偏轻松。" },
    ],
  };

  assert.deepEqual(emptyCreativeAgreement(), { items: [] });
  assert.deepEqual(validateCreativeAgreement(agreement), []);
  assert.match(validateCreativeAgreement({ version: 2, items: [] }).join("\n"), /未知字段：version/);
  assert.match(validateCreativeAgreement({ ...agreement, items: [...agreement.items, agreement.items[0]] }).join("\n"), /id 重复/);

  assert.deepEqual(await saveCreativeAgreement(project, agreement), agreement);
  assert.deepEqual(JSON.parse(await readFile(path.join(project, "creative-agreement.json"), "utf8")), agreement);
});

test("参考材料由实际文件形成单一清单，保存和删除同步维护正文与标题", async t => {
  const project = await mkdtemp(path.join(tmpdir(), "project-materials-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(path.join(project, "materials"), { recursive: true });
  await writeFile(path.join(project, "materials", "loose.md"), "初稿", "utf8");
  await writeFile(path.join(project, "materials", "index.json"), `${JSON.stringify({ items: [{ file: "loose.md", title: "材料标题" }] }, null, 2)}\n`, "utf8");

  assert.deepEqual(emptyMaterialMetadata(), { items: [] });
  assert.deepEqual(validateMaterialMetadata({ items: [{ file: "loose.md", title: "材料标题" }] }), []);
  assert.match(validateMaterialMetadata({ version: 1, items: [] }).join("\n"), /未知字段：version/);

  const initial = await readProjectMaterials(project, "demo");
  assert.deepEqual(Object.keys(initial).sort(), ["agreement", "materials"]);
  assert.equal(initial.materials.length, 1);
  assert.deepEqual(
    { file: initial.materials[0].file, title: initial.materials[0].title, text: initial.materials[0].text },
    { file: "loose.md", title: "材料标题", text: "初稿" },
  );
  assert.equal("registered" in initial.materials[0], false);

  await saveMaterial(project, "demo", { file: "loose.md", title: "修改后的标题", encoding: "utf8", content: "修改后的正文" });
  await saveMaterial(project, "demo", { file: "notes.md", title: "补充笔记", encoding: "utf8", content: "新材料" });
  assert.equal(await readFile(path.join(project, "materials", "loose.md"), "utf8"), "修改后的正文");
  assert.deepEqual(JSON.parse(await readFile(path.join(project, "materials", "index.json"), "utf8")), {
    items: [
      { file: "loose.md", title: "修改后的标题" },
      { file: "notes.md", title: "补充笔记" },
    ],
  });

  await deleteMaterial(project, "loose.md");
  await assert.rejects(access(path.join(project, "materials", "loose.md")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(path.join(project, "materials", "index.json"), "utf8")), {
    items: [{ file: "notes.md", title: "补充笔记" }],
  });
  assert.deepEqual((await readProjectMaterials(project, "demo")).materials.map((item) => item.file), ["notes.md"]);
});

test("素材只容纳一层纯文件名，嵌套路径被拒绝且不进入清单", async t => {
  const project = await mkdtemp(path.join(tmpdir(), "project-materials-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(path.join(project, "materials", "nested"), { recursive: true });
  await writeFile(path.join(project, "materials", "flat.md"), "一层材料", "utf8");
  await writeFile(path.join(project, "materials", "nested", "hidden.md"), "嵌套材料", "utf8");

  assert.match(validateMaterialMetadata({ items: [{ file: "nested/hidden.md", title: "嵌套" }] }).join("\n"), /不是 materials\/ 下的有效文件名/);
  for (const file of ["nested/hidden.md", "nested\\hidden.md", "a/b/c.md"]) {
    await assert.rejects(
      () => saveMaterial(project, "demo", { file, title: "嵌套材料", encoding: "utf8", content: "不应写入" }),
      (error) => error?.status === 422 && error?.code === "invalid_material_path",
    );
    await assert.rejects(() => deleteMaterial(project, file), (error) => error?.code === "invalid_material_path");
  }
  assert.equal(await access(path.join(project, "materials", "nested", "hidden.md")).then(() => true, () => false), true, "拒绝时不得改写既有文件");

  await saveMaterial(project, "demo", { file: "notes.md", title: "纯文件名", encoding: "utf8", content: "正常登记" });
  assert.deepEqual(
    (await readProjectMaterials(project, "demo")).materials.map((item) => item.file),
    ["flat.md", "notes.md"],
    "嵌套文件不得出现在素材清单",
  );
});
