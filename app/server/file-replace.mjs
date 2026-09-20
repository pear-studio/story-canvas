import { lstat, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// 只重试同一次替换，不重写内容、不删除目标，也不重试上层生成操作。
// Windows 错误码无法证明占用是短暂的，因此超时仍抛出原文件系统错误。
export async function replaceFileWithRetry(source, target, {
  platform = process.platform,
  renameFile = rename,
  statFile = lstat,
  wait = delay,
  delays = [10, 20, 40, 80, 160, 320, 640],
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameFile(source, target); }
    catch (error) {
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= delays.length) throw error;
      if (attempt === 0) {
        // 明确的目标类型或只读错误无需等待；其余权限错误仍受同一上限约束。
        try {
          const info = await statFile(target);
          if (!info.isFile() || !(info.mode & 0o200)) throw error;
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw error;
        }
      }
      await wait(delays[attempt]);
    }
  }
}
