import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { claimInstance, instanceAlive, readInstance, replaceWorkbench } from "../server/workbench-instance.mjs";

test("实例互斥拒绝重复所有者，过期 PID 身份可恢复且不会终止无关进程", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-owner-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const owner = await claimInstance(root, "server");
  await assert.rejects(claimInstance(root, "server"), /已有工作台实例/);
  await owner.release();
  await writeFile(path.join(root, "Saved/workbench-server.json"), JSON.stringify({ ...owner.record, identity: "expired" }));
  await replaceWorkbench(root);
  assert.equal(await readInstance(root, "server"), null);
  const next = await claimInstance(root, "server");
  assert.notEqual(next.record.token, owner.record.token);
  await owner.release();
  assert.equal((await readInstance(root, "server")).token, next.record.token);
  await next.release();
});

async function until(read, accept, label) {
  const deadline = Date.now() + 45000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`等待超时：${typeof label === "function" ? label() : label}`);
}

test("真实启动器替换 dev 监听树，非 dev 构建当前版本且源码变化不重启", { timeout: 120000 }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench launch "));
  const app = path.join(root, "app");
  await mkdir(path.join(app, "scripts"), { recursive: true });
  await mkdir(path.join(app, "server"), { recursive: true });
  await mkdir(path.join(app, "shared"), { recursive: true });
  await mkdir(path.join(app, "node_modules/vite/bin"), { recursive: true });
  await cp(new URL("../scripts/start-workbench.mjs", import.meta.url), path.join(app, "scripts/start-workbench.mjs"));
  await cp(new URL("../server/workbench-instance.mjs", import.meta.url), path.join(app, "server/workbench-instance.mjs"));
  // 用最小服务隔离 ComfyUI，仍运行正式启动器、实例锁和 Node watcher。
  await writeFile(path.join(app, "server/index.mjs"), `
    import { createServer } from 'node:http';
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { claimInstance } from './workbench-instance.mjs';
    import '../shared/version.mjs';
    import '../node_modules/vite/cached-config.mjs';
    const root = path.resolve('..');
    let owner;
    const server = createServer(async (req,res) => {
      if(req.url === '/api/workbench/shutdown' && req.headers['x-workbench-token'] === owner.record.token) {
        await writeFile(path.join(root,'graceful.txt'),'closed');
        res.end('ok'); server.close();
      } else res.end('ready');
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    owner = await claimInstance(root,'server',{port:server.address().port});
    server.once('close',()=>void owner.release());
  `);
  await writeFile(path.join(app, "node_modules/vite/bin/vite.js"), `require('node:fs').writeFileSync('built.txt',require('node:fs').readFileSync('shared/source.txt'));`);
  await writeFile(path.join(app, "shared/source.txt"), "version-one");
  await writeFile(path.join(app, "shared/version.mjs"), "export default 1;");
  await writeFile(path.join(app, 'node_modules/vite/cached-config.mjs'), 'export default 1;');
  const children = [];
  let logs = "";
  const launch = (...args) => {
    const child = spawn(process.execPath, [path.join(app, "scripts/start-workbench.mjs"), ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
    children.push(child); return child;
  };
  context.after(async () => {
    await replaceWorkbench(root);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const dev = launch("dev", "--replace");
  const first = await until(() => readInstance(root, "server"), Boolean, logs);
  assert.equal(await instanceAlive(first), true);
  await writeFile(path.join(app, 'node_modules/vite/cached-config.mjs'), 'export default 2;');
  await writeFile(path.join(root, 'Saved/probe.tmp'), 'x');
  await delay(1500);
  assert.equal((await readInstance(root, 'server')).token, first.token, 'Vite 临时配置与 runtime/ 写入不应重启后端');
  const duplicate = launch("production");
  const [duplicateCode] = await once(duplicate, "exit");
  assert.equal(duplicateCode, 1);
  assert.equal((await readInstance(root, "server")).token, first.token);
  await writeFile(path.join(app, "shared/source.txt"), "version-two");
  await writeFile(path.join(app, "shared/version.mjs"), "export default 2;");
  const refreshed = await until(() => readInstance(root, "server"), item => item && item.token !== first.token, "dev 自动重启");
  launch("production", "--build", "--replace");
  const production = await until(() => readInstance(root, "server"), item => item && item.token !== refreshed.token, () => `替换为非 dev\n${logs}`);
  await until(async () => dev.exitCode ?? dev.signalCode, value => value !== null, "旧监听器退出");
  assert.equal(await instanceAlive(refreshed), false);
  assert.equal(await readFile(path.join(root, "graceful.txt"), "utf8"), "closed");
  assert.equal(await readFile(path.join(app, "built.txt"), "utf8"), "version-two");
  await writeFile(path.join(app, "shared/source.txt"), "version-three");
  await writeFile(path.join(app, "shared/version.mjs"), "export default 3;");
  await delay(1200);
  assert.equal((await readInstance(root, "server")).token, production.token);
  assert.equal(await instanceAlive(production), true);
});
