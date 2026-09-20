import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { loadLocalConfig } from "../server/http-support.mjs";
import { preparePromptDescriptionMigration, applyPromptDescriptionMigration } from "../server/prompt-description-migration.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const flags = process.argv.slice(2);
try {
  const apply = flags.join(" ") === "--apply --offline";
  if (flags.length && !apply) throw new Error("用法：prompt-description-migration.mjs [--apply --offline]；无参数仅预检，执行前停止 Node 服务及其他写入者");
  if (apply) {
    const config = await loadLocalConfig(path.join(repositoryRoot, "app"));
    const listening = await new Promise(resolve => {
      const socket = connect({ host: "127.0.0.1", port: Number(process.env.STORYVIS_PORT ?? config.port ?? 3000) });
      const finish = value => { socket.destroy(); resolve(value); };
      socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(1000, () => finish(true));
    });
    if (listening) throw new Error("Node 服务仍在监听，先停止服务再执行迁移");
  }
  const plan = await preparePromptDescriptionMigration(repositoryRoot);
  if (apply) await applyPromptDescriptionMigration(plan);
  console.log(JSON.stringify({ applied: apply, files: plan.files.map(item => path.relative(repositoryRoot, item.file)) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
