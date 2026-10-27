import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {defaultTrainingTarget,trainingFamilies,trainingModel} from '../server/lora-training-models.mjs';
import {loraTrainingOverridesForFamily,validateLoraTrainingTask} from '../server/lora-training-support.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const readSchema=async name=>JSON.parse(await readFile(new URL(`../../library/schemas/${name}.schema.json`,import.meta.url),'utf8'));
async function modelSettings(family){
 const model=trainingModel(family),recipe=JSON.parse(await readFile(new URL(`../../library/lora-training/recipes/${model.recipeId}.json`,import.meta.url),'utf8'));
 return {version:6,target:await defaultTrainingTarget(root,family),caption_set_id:'caption-set-123456abcdef',training_recipe:{id:recipe.id,overrides:Object.fromEntries(Object.keys(loraTrainingOverridesForFamily(family)).map(key=>[key,recipe.semantic_config[key]]))},run_defaults:{max_train_steps:2000,save_every_n_steps:500,seed:42}};
}

test('训练设置 Schema 对应 v6 模型容器，支持三模型且隔离旧版只读结构',async()=>{
 const schema=await readSchema('lora-training-settings'),validate=new Ajv2020({strict:true,allErrors:true}).compile(schema);
 const models=Object.fromEntries(await Promise.all(trainingFamilies.map(async family=>[family,await modelSettings(family)])));
 const current={version:6,models};
 const accepts=(value,expected)=>assert.equal(validate(value),expected,JSON.stringify(validate.errors));
 accepts(current,true);
 for(const model of Object.values(models)) assert.deepEqual(validateLoraTrainingTask({...model,name:'测试',dataset_id:'dataset-123456abcdef'}),[]);
 accepts({version:6,models:{}},true);
 const {caption_set_id,...old}=models['qwen-image-2-1'];
 accepts({...old,version:5},true);
 accepts({...old,version:6},false);
 const noSet=structuredClone(current);delete noSet.models['moss-image'].caption_set_id;accepts(noSet,false);
 const unknown=structuredClone(current);unknown.models.unknown=unknown.models.anima;accepts(unknown,false);
 const mismatched=structuredClone(current);mismatched.models.anima=mismatched.models['moss-image'];accepts(mismatched,false);
 const mixed=structuredClone(current);mixed.models['moss-image'].target.base.processor=mixed.models['moss-image'].target.base.tokenizer;accepts(mixed,false);
 const wrongStorage=structuredClone(current);wrongStorage.models['moss-image'].target.base.dit.relative_path='diffusion_models/moss/';accepts(wrongStorage,false);
});

test('共享素材及独立打标集 Schema 与当前持久化字段一致',async()=>{
 const ajv=new Ajv2020({strict:true,allErrors:true});
 const dataset=ajv.compile(await readSchema('lora-training-dataset'));
 const doc={version:6,name:'共享',description:'',activation_terms:[],groups:[],items:[]};
 assert.equal(dataset(doc),true,JSON.stringify(dataset.errors));
 assert.equal(dataset({...doc,version:5}),true);
 assert.equal(dataset({...doc,caption_set_id:'caption-set-123456abcdef'}),false);
 const captions=ajv.compile(await readSchema('lora-caption-sets'));
 const set={id:'caption-set-123456abcdef',name:'自然语言',format:'prose'};
 assert.equal(captions({version:1,sets:[set]}),true);
 assert.equal(captions({version:1,sets:[{...set,format:'tags'}]}),true);
 for(const sets of [[],[set,set],[{...set,family:'moss-image'}],[{...set,format:'moss'}],[{...set,name:' '}],[{...set,id:'default'}]]) assert.equal(captions({version:1,sets}),false);
});
