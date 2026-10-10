import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, loadConfigFromFile } from "vite";

async function requestWithHost(port, host) {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/", headers: { host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("开发服务器跳过本机资源与运行产物，仍监听前端源码变化", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-watch-"));
  let server;
  context.after(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const directory of ["src", "data.local/assets/nested", "Saved/logs", ".temp/test-output"]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, "sample.js"), "export default 1;\n");
  }
  await writeFile(path.join(root, "index.html"), '<script type="module" src="/src/sample.js"></script>');
  const { config } = await loadConfigFromFile({ command: "serve", mode: "development" }, fileURLToPath(new URL("../vite.config.ts", import.meta.url)));
  server = await createServer({
    ...config,
    root,
    configFile: false,
    cacheDir: path.join(root, "node_modules/.vite"),
    // 隔离应用本身位于 Saved/Tests；按模拟应用根限定原配置，避免上级 Saved 吞掉整个源码夹具。
    server: { ...config.server, middlewareMode: true, hmr: false, ws: false,watch:{...config.server.watch,ignored:config.server.watch.ignored.map(pattern=>pattern.replace('**/',`${root.replaceAll('\\','/')}/`))} },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [],
  });
  const sourceWatched = () => Object.entries(server.watcher.getWatched()).some(([directory, names]) => path.resolve(directory) === path.join(root, "src") && names.includes("sample.js"));
  // Vite 的配置/环境文件也会触发 ready；以源码文件真正进入监听集合为准。
  const deadline = Date.now() + 5_000;
  while (!sourceWatched() && Date.now() < deadline) await delay(20);
  const watched = Object.keys(server.watcher.getWatched()).map((entry) => path.resolve(entry));
  assert.ok(sourceWatched(), "前端源文件必须保持监听");
  for (const directory of ["data.local", "Saved", "../Saved/Tests"]) {
    const excluded = path.join(root, directory);
    assert.deepEqual(watched.filter((entry) => entry === excluded || entry.startsWith(`${excluded}${path.sep}`)), [], `${directory} 不应建立文件监听`);
  }
  const changed = once(server.watcher, "change", { signal: AbortSignal.timeout(5_000) });
  await writeFile(path.join(root, "src/sample.js"), "export default 12345;\n");
  assert.equal(path.resolve((await changed)[0]), path.join(root, "src/sample.js"));
});

test("开发服务器允许通过 Tailscale Serve 域名访问工作台", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "story-canvas-tailnet-host-"));
  let viteServer;
  let httpServer;
  context.after(async () => {
    if (httpServer?.listening) await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    await viteServer?.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "index.html"), "<main>tailnet test</main>\n");
  const { config } = await loadConfigFromFile({ command: "serve", mode: "development" }, fileURLToPath(new URL("../vite.config.ts", import.meta.url)));
  viteServer = await createServer({
    ...config,
    root,
    configFile: false,
    cacheDir: path.join(root, "node_modules/.vite"),
    server: { ...config.server, middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [],
  });
  httpServer = createHttpServer(viteServer.middlewares);
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");

  const response = await requestWithHost(address.port, "storyvisualizer.example.ts.net");
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<main>tailnet test<\/main>/);

  const unknownHostResponse = await requestWithHost(address.port, "storyvisualizer.example.invalid");
  assert.equal(unknownHostResponse.statusCode, 403);
  assert.match(unknownHostResponse.body, /host .* is not allowed/i);
});
