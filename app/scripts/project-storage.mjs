import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalConfig } from "../server/http-support.mjs";
import { connect } from "node:net";
import { resolveProjectLocation } from "../server/project-operations.mjs";
import { migrateProjectStorage } from "../server/project-storage-migration.mjs";
import { cleanProjectRuntime } from "../server/project-runtime-cleanup.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [operation, projectId, offline] = process.argv.slice(2);
try {
  if (!["migrate", "clean-runtime"].includes(operation) || !projectId || offline !== "--offline") throw new Error("用法：project-storage.mjs <migrate|clean-runtime> <project-id> --offline；先停止 Node 服务及项目写入者");
  const config = await loadLocalConfig(path.join(repositoryRoot, "app"));
  const listening = await new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port: Number(process.env.STORYVIS_PORT ?? config.port ?? 3000) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(1000, () => finish(true));
  });
  if (listening) throw new Error("Node 服务仍在监听，必须先停止服务再维护存储");
  const { projectDirectory } = await resolveProjectLocation(repositoryRoot, projectId);
  const result = operation === "migrate" ? await migrateProjectStorage(repositoryRoot, projectId) : await cleanProjectRuntime(projectDirectory);
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
