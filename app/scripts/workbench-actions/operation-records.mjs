import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {invalid} from './contract.mjs';

// 派生回执，跨会话/重启可读；不把临时文件路径暴露为操作参数。
const root=fileURLToPath(new URL('../../../Saved/Agent/workbench-operations/',import.meta.url));
function filename(kind,id) {
  if(!['generation','cleanup'].includes(kind)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))throw invalid('无效的批次或预览 ID');
  return path.join(root,`${kind}-${id}.json`);
}
export async function saveOperationRecord(kind,value,id=randomUUID()) {
  const file=filename(kind,id),temp=`${file}.${randomUUID()}.tmp`;
  await mkdir(root,{recursive:true});
  await writeFile(temp,JSON.stringify(value),{flag:'wx'});
  await rename(temp,file);
  return id;
}
export async function readOperationRecord(kind,id) {
  try{return JSON.parse(await readFile(filename(kind,id),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;throw Object.assign(new Error('回执不存在或 Saved 已清理；查询原任务/重新预览，不重提生成。'),{code:'operation_record_missing'});}
}
