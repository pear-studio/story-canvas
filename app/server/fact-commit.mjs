import { unlink } from 'node:fs/promises';
import { targetPath, writeJsonAtomic } from './fact-storage.mjs';
import { prunePageTranslationChange } from './page-translation-document.mjs';
import { checkRemovedSettingReferences, cleanRemovedReferences } from './reference-materials.mjs';

// 项目写锁由调用入口持有；失败时恢复已写文件，避免半套连带修改。
export async function commitFactChanges(directory, writes, { cleanupReferences = true } = {}) {
  const pruned = [];
  for (const write of writes) {
    const change = await prunePageTranslationChange(directory, write);
    if (change && !writes.some(item => item.relative === change.relative)) pruned.push(change);
  }
  writes = [...writes, ...pruned];
  if (cleanupReferences) await checkRemovedSettingReferences(directory, writes);
  const done = [];
  try {
    for (const write of writes) {
      if(write.remove) await unlink(targetPath(directory,write.relative));
      else await writeJsonAtomic(targetPath(directory, write.relative), write.after);
      done.push(write);
    }
  } catch (error) {
    for (const write of done.reverse()) {
      const target = targetPath(directory, write.relative);
      if (write.before === null) await unlink(target);
      else await writeJsonAtomic(target, write.before);
    }
    throw error;
  }
  // 事实已提交，清理旧素材失败不能伪装成保存失败、诱发重复提交。
  const warnings = [];
  if (cleanupReferences) for (const write of writes) if (write.relative.endsWith('.prompt.json')) {
    try { await cleanRemovedReferences(directory, write.before); }
    catch (error) {
      warnings.push({ code: 'reference_cleanup_failed', file: write.relative });
      console.warn('[story-canvas] 保存完成，旧素材清理失败', error);
    }
  }
  return { warnings };
}
