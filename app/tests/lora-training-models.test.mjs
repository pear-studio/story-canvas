import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {trainingModel,defaultTrainingTarget} from '../server/lora-training-models.mjs';
import {qwenV5RunnerCompatible} from '../server/lora-training-plan.mjs';
import {requireRun} from '../server/lora-training-runtime.mjs';
import {registerProject} from '../server/project-registry.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');

test('MOSS 默认训练只选择 SFT 身份并使用专属 runner；未知模型不回退',async()=>{
  const target=await defaultTrainingTarget(root,'moss-image');
  assert.equal(target.base.dit.relative_path,'diffusion_models/moss_image_sft_bf16.safetensors');
  assert.equal(trainingModel('moss-image').resumable,false);
  assert.equal(trainingModel('moss-image').runnerFile,'moss-image-lora-runner.py');
  assert.throws(()=>trainingModel('moss-base'),{code:'unsupported_lora_training_family'});
  const manifest=JSON.parse(await readFile(path.join(root,'library/lora-training/moss-image-sft-models.json'),'utf8'));
  const dit=manifest.files.filter(file=>file.relative_path.startsWith('diffusion_models/'));
  assert.equal(dit.length,1);assert.equal(dit[0].sha256,'f96738d8116d78b7316b57c663d8c98591ddafab7488f48e3099b7655e34ab6f');
});

test('旧 Qwen 续训只接受版本入口这一处变更，任意训练内容变化仍拒绝',async()=>{
  const file=path.join(root,'app/python/qwen-image21-lora-runner.py');
  const current=await readFile(file,'utf8');
  const old=current.replace('manifest.get("version") not in (5, 6)','manifest.get("version") != 5').replace('manifest version 必须为 5 或 6','manifest version 必须为 5');
  assert.equal(await qwenV5RunnerCompatible(file,digest(old),digest(current)),true);
  assert.equal(await qwenV5RunnerCompatible(file,digest(old+'\n# other training changes'),digest(current)),false);
  assert.equal(await qwenV5RunnerCompatible(file,digest(old),'a'.repeat(64)),false);
});

test('损坏的新 manifest 不得被当作 Anima 历史记录',async context=>{
  const tests=path.join(root,'Saved/Tests');await mkdir(tests,{recursive:true});
  const directory=await mkdtemp(path.join(tests,'manifest-invalid-'));
  context.after(()=>rm(directory,{recursive:true,force:true}));
  const repository=path.join(directory,'repository'),project=path.join(directory,'external-project');
  const task='lora-111111111111',run='run-222222222222',archive=path.join(project,'Training',task,run);
  await mkdir(archive,{recursive:true});
  registerProject(repository,{id:'dataset-111111111111',type:'training',path:project,temporary:true});
  await writeFile(path.join(archive,'manifest.json'),JSON.stringify({version:6,id:run,task_id:task,family:'moss-image'}));
  await writeFile(path.join(archive,'result.json'),JSON.stringify({status:'completed'}));
  await assert.rejects(requireRun(repository,task,run),{code:'invalid_lora_training_run_manifest'});
});
