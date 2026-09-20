import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceFileWithRetry } from "../server/file-replace.mjs";

test("Windows 短暂替换失败只重试 rename，成功前旧文件保持完整", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "replace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "new.json"), target = path.join(root, "status.json");
  await writeFile(source, '{"new":true}');
  await writeFile(target, '{"old":true}');
  let attempts = 0;
  const waits = [];
  await replaceFileWithRetry(source, target, { platform: "win32", wait: async ms => waits.push(ms),
    renameFile: async (...args) => {
      assert.equal(await readFile(target, "utf8"), '{"old":true}');
      if (++attempts < 3) throw Object.assign(new Error("busy"), { code: "EPERM" });
      await rename(...args);
    } });
  assert.deepEqual(waits, [10, 20]);
  assert.equal(await readFile(target, "utf8"), '{"new":true}');
});

test("持续权限错误有界退出，非目标错误及明确只读目标不重试", async () => {
  for (const entry of [
    { code: "EPERM", mode: 0o600, platform: "win32", attempts: 8 },
    { code: "EACCES", mode: 0o600, platform: "win32", attempts: 8 },
    { code: "ENOSPC", mode: 0o600, platform: "win32", attempts: 1 },
    { code: "EPERM", mode: 0o400, platform: "win32", attempts: 1 },
    { code: "EPERM", mode: 0o600, platform: "linux", attempts: 1 },
  ]) {
    const error = Object.assign(new Error("replace failed"), { code: entry.code });
    let attempts = 0, waited = 0;
    await assert.rejects(replaceFileWithRetry("source", "target", {
      platform: entry.platform, renameFile: async () => { attempts++; throw error; },
      statFile: async () => ({ isFile: () => true, mode: entry.mode }), wait: async ms => { waited += ms; },
    }), value => value === error);
    assert.equal(attempts, entry.attempts);
    assert.ok(waited <= 1270);
  }
});
