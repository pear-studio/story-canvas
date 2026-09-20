import path from 'node:path';
import { migrateUnifiedPages } from '../server/unified-pages-migration.mjs';
import { createProjectOperations } from '../server/project-operations.mjs';

const value = flag => process.argv[process.argv.indexOf(flag) + 1];
if (!process.argv.includes('--project')) throw new Error('需要 --project <项目绝对路径>；默认预演，--apply 执行并备份。');
const directory = path.resolve(value('--project'));
const operations = createProjectOperations({ projectRoot: path.dirname(path.dirname(directory)) });
const run = () => migrateUnifiedPages(directory, { apply: process.argv.includes('--apply'), ...(process.argv.includes('--backup') ? { backupDirectory: value('--backup') } : {}) });
try {
  const result = process.argv.includes('--apply') ? (await operations.mutateTargetFacts(path.basename(directory), run)).value : await run();
  console.log(JSON.stringify(result, null, 2));
} finally { operations.close(); }
