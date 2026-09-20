import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { loadLocalConfig } from "../server/http-support.mjs";
import { requireIdleProject } from "../server/project-management.mjs";
import { resolveProjectLocation } from "../server/project-operations.mjs";
import { migratePromptPerson } from "../server/prompt-person-migration.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [projectId, flag] = process.argv.slice(2);
try {
  if (!projectId || flag !== "--offline") throw new Error("用法：node app/scripts/prompt-person-migration.mjs <project-id> --offline；先停止工作台服务及项目写入者");
  const config = await loadLocalConfig(path.join(root, "app"));
  const listening = await new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port: Number(process.env.STORYVIS_PORT ?? config.port ?? 3000) });
    const done = value => { socket.destroy(); resolve(value); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.setTimeout(1000, () => done(true));
  });
  if (listening) throw new Error("工作台仍在监听，不能离线迁移");
  const { projectDirectory } = await resolveProjectLocation(root, projectId);
  await requireIdleProject(projectDirectory);
  // 仅列举当前事实目录，不进入媒体、runtime、子项目 Git 或材料。
  const relatives = ["scenes.json", "render-profile.override.json"];
  for (const dir of ["characters", "characters/pages", "story/pages"]) {
    for (const entry of await readdir(path.join(projectDirectory, dir), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".prompt.json")) relatives.push(`${dir}/${entry.name}`);
    }
  }
  const changes = [];
  for (const relative of relatives) {
    const filename = path.join(projectDirectory, relative);
    const before = await readFile(filename, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (before === null) continue;
    const source = JSON.parse(before), next = migratePromptPerson(source);
    if (JSON.stringify(source) !== JSON.stringify(next)) changes.push({ relative, filename, before, after: `${JSON.stringify(next, null, 2)}\n` });
  }
  const backup = path.join(root, "Saved", "prompt-person-migration", `${projectId}-${Date.now()}.json`);
  if (changes.length) {
    await mkdir(path.dirname(backup), { recursive: true });
    await writeFile(backup, JSON.stringify(changes, null, 2), "utf8");
    try {
      for (const change of changes) {
        if (await readFile(change.filename, "utf8") !== change.before) throw new Error(`迁移期间文件变化：${change.relative}`);
      }
      for (const change of changes) await writeFile(change.filename, change.after, "utf8");
    } catch (error) {
      // 离线维护失败后恢复本次写入前的完整事实。
      for (const change of changes) if (await readFile(change.filename, "utf8") === change.after) await writeFile(change.filename, change.before, "utf8");
      throw error;
    }
  }
  console.log(JSON.stringify({ project_id: projectId, files: changes.map(change => change.relative), backup: changes.length ? backup : null }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
