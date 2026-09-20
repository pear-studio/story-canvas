import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalConfig } from "../server/http-support.mjs";
import { connect } from "node:net";
import { resolveProjectLocation } from "../server/project-operations.mjs";
import { migrateProjectCharacterVariants } from "../server/character-variant-explicit-migration.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [projectId, ...flags] = process.argv.slice(2);
try {
  if (!projectId || flags.length !== 1 || flags[0] !== "--offline") {
    throw new Error("用法：character-variant-explicit-migration.mjs <project-id> --offline；先停止 Node 服务及项目写入者");
  }
  const config = await loadLocalConfig(path.join(repositoryRoot, "app"));
  const listening = await new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port: Number(process.env.STORYVIS_PORT ?? config.port ?? 3000) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(1000, () => finish(true));
  });
  if (listening) throw new Error("Node 服务仍在监听，必须先停止服务再迁移角色造型引用");
  const { projectDirectory } = await resolveProjectLocation(repositoryRoot, projectId);
  const result = await migrateProjectCharacterVariants(projectDirectory);
  console.log(JSON.stringify(result, null, 2));
  if (result.files.some(report => report.status === "aborted")) {
    console.error("部分文件未迁移，详见上方报告");
    process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
