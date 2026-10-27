import path from 'node:path';
import {readFile} from 'node:fs/promises';

// 训练注册只描述已实现的路线；未知模型不得退化为 Qwen。
const models={
  anima:{family:'anima',promptFamily:'anima',runnerName:'anima-lora-runner',runnerFile:'anima-lora-runner.py',recipeId:'anima-lora-v1',modelManifest:'anima-models.json',trainerManifest:'sd-scripts.json',trainerConfigKey:'sd_scripts',trainerDirectory:'sd-scripts',modelKinds:['dit','text_encoder','vae'],resumable:false,usageDefaults:{clip_skip:null,sampler:'euler_ancestral',scheduler:'normal',steps:30,cfg:4}},
  'qwen-image-2-1':{family:'qwen-image-2-1',promptFamily:'qwen',runnerName:'qwen-image21-lora-runner',runnerFile:'qwen-image21-lora-runner.py',recipeId:'qwen-image21-lora-v1',modelManifest:'qwen-image21-models.json',trainerManifest:'diffsynth.json',trainerConfigKey:'diffsynth',trainerDirectory:'DiffSynth-Studio',modelKinds:['dit','text_encoder','vae','processor'],resumable:true,usageDefaults:{clip_skip:null,sampler:'euler',scheduler:'simple',steps:25,cfg:1},source:'https://huggingface.co/Qwen/Qwen-Image-2.1',base:{dit:'diffusion_models/qwen-image-2.1/',text_encoder:'text_encoders/qwen-image-2.1/',vae:'vae/qwen-image-2.1/',processor:'text_encoders/qwen-image-2.1/processor/'}},
  'moss-image':{family:'moss-image',promptFamily:'moss',runnerName:'moss-image-lora-runner',runnerFile:'moss-image-lora-runner.py',recipeId:'moss-image-sft-lora-v1',modelManifest:'moss-image-sft-models.json',trainerManifest:'moss-diffsynth.json',trainerConfigKey:'moss',trainerDirectory:'MOSS-DiffSynth-Studio',modelKinds:['dit','text_encoder','vae','tokenizer'],resumable:false,usageDefaults:{clip_skip:null,sampler:'euler',scheduler:'simple',steps:50,cfg:3},source:'https://huggingface.co/openmoss/MOSS-Image-SFT',base:{dit:'diffusion_models/moss_image_sft_bf16.safetensors',text_encoder:'text_encoders/moss-image-base/',vae:'vae/moss-image-base/diffusion_pytorch_model.safetensors',tokenizer:'text_encoders/moss-image-base/tokenizer/'}},
};
export const trainingFamilies=Object.freeze(Object.keys(models));
export function trainingModel(family){
  if(!Object.hasOwn(models,family))throw Object.assign(new Error('unsupported_lora_training_family'),{status:422,code:'unsupported_lora_training_family'});
  return models[family];
}
export const defaultRecipeId=family=>trainingModel(family).recipeId;
export async function defaultTrainingTarget(projectRoot,family){
  const model=trainingModel(family);
  const base=family==='anima'?Object.fromEntries(JSON.parse(await readFile(path.join(projectRoot,'library/lora-training',model.modelManifest),'utf8')).files.map(file=>[file.kind,{relative_path:file.relative_path,source:file.source}])):Object.fromEntries(Object.entries(model.base).map(([kind,relative_path])=>[kind,{relative_path,source:model.source}]));
  return {family,prompt_family:model.promptFamily,usage_defaults:structuredClone(model.usageDefaults),base};
}
