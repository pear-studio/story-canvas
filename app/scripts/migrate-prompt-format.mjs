import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProjectRegistry} from '../server/project-registry.mjs';
import {createProjectOperations} from '../server/project-operations.mjs';
import {
  planPromptFormatMigration, validatePromptFormatMigration, comparePromptFormatMigration,
  backupPromptFormatMigration, commitPromptFormatMigration, restorePromptFormatMigration,
} from '../server/prompt-format-migration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), apply = args.includes('--apply');
function option(name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; }
const baselineFile = option('--baseline'), outputFile = option('--out');
if (!baselineFile || !outputFile) throw new Error('用法：node <绝对路径>/migrate-prompt-format.mjs --baseline <旧编译快照> --out <回执> [--apply]');
for (let index = 0; index < args.length; index++) {
  if (['--baseline', '--out'].includes(args[index])) index++;
  else if (args[index] !== '--apply') throw new Error(`未知参数：${args[index]}`);
}
const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
const registered = readProjectRegistry(root), prepared = [];
const allowed = ['midnight-snack', 'kama-sutra'];
if (baseline.projects.length !== 2 || new Set(baseline.projects.map(project => project.id)).size !== 2) throw new Error('基线必须包含且仅包含两个迁移项目');
const receipt = {mode:apply ? 'apply' : 'preview', started_at:new Date().toISOString(), projects:[]};
for (const project of baseline.projects) {
  const entry = registered.find(candidate => candidate.id === project.id);
  if (!allowed.includes(project.id) || !entry || path.resolve(entry.path) !== path.resolve(project.directory)) throw new Error(`项目登记与迁移范围不匹配：${project.id}`);
  const plan = planPromptFormatMigration(project.files);
  validatePromptFormatMigration(plan);
  const comparison = comparePromptFormatMigration(project, plan);
  if (comparison.failures.length) throw new Error(`迁移前后实际 Prompt 不一致：${project.id}: ${comparison.failures.join(', ')}`);
  const record = {project_id:project.id, changed_files:plan.changes.length, removed_adjustments:plan.removed.length, comparison};
  receipt.projects.push(record);
  prepared.push({project, plan, record});
}
if (apply) {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  for (const {project, plan, record} of prepared) {
    record.backup_directory = path.join(path.dirname(project.directory), '.prompt-redesign-backups', stamp, project.id);
    await backupPromptFormatMigration(project.directory, plan, record.backup_directory);
  }
  const operations = createProjectOperations({projectRoot:root}), committed = [];
  try {
    for (const item of prepared) {
      await operations.mutateTargetFacts(item.project.id, ({projectDirectory}) => commitPromptFormatMigration(projectDirectory, item.plan));
      committed.push(item);
      item.record.saved = true;
    }
  } catch (error) {
    for (const item of committed.reverse()) await operations.mutateTargetFacts(item.project.id, ({projectDirectory}) => restorePromptFormatMigration(projectDirectory, item.plan));
    throw error;
  } finally { operations.close(); }
}
receipt.finished_at = new Date().toISOString();
await mkdir(path.dirname(path.resolve(outputFile)), {recursive:true});
await writeFile(outputFile, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
