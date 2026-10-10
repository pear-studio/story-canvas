import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cameraPromptEntries,cameraPromptPreview,normalizeCameraSettings} from '../shared/camera-prompt.mjs';
import {compileCurrentPagePrompt} from '../server/models/anima/current-page-prompt.mjs';
import {migrateCameraDocument} from '../server/camera-migration.mjs';
import {validateStoryPagePromptDocument,preparePromptForPersistence} from '../server/models/anima/story-files.mjs';
const empty=()=>({population:[],person:[],setting:[],camera:[],avoid:[]});
test('机位参数稀疏保存、清除、非法旧字段与生成标签',async()=>{
 assert.deepEqual(normalizeCameraSettings({direction:'side',shot:null,motionLines:false}),{direction:'side'});
 for(const settings of [{shot:'中景'},{view:'over_shoulder'},{perspective:true},{hands:true},{motionLines:'yes'}])assert.throws(()=>normalizeCameraSettings(settings));
 assert.deepEqual(cameraPromptPreview({direction:'side',shot:'full_body',motionLines:true}),['from_side','full_body','motion_lines']);
 const csv=await readFile(new URL('../../library/prompt-dictionaries/danbooru.csv',import.meta.url),'utf8');
 const tags=new Set(csv.split('\n').map(x=>x.split(',')[0]));
 for(const settings of [{direction:'front',height:'above',shot:'close_up',view:'pov',backgroundBlur:true,foregroundBlur:true,motionLines:true},{direction:'back',height:'below',shot:'wide_shot'},{direction:'side',shot:'full_body'}])for(const {fragment} of cameraPromptEntries(settings))if(fragment.tag)assert.ok(tags.has(fragment.tag),fragment.tag);
 const p=preparePromptForPersistence({...empty(),camera_settings:{direction:null,motionLines:false}});
 assert.equal(p.camera_settings,undefined);
 assert.ok(validateStoryPagePromptDocument({$schema:'https://storyvisualizer.local/schemas/story-page-prompt.schema.json',...empty(),camera:[{description:'old',camera_settings:{}}]}).some(x=>x.includes('camera_settings')));
});
test('编译真实消费独立参数、保留自由镜头词且标记参数来源',()=>{
 const pagePrompt={...empty(),camera:[{description:'through the window'}],camera_settings:{direction:'side',shot:'full_body',motionLines:true}};
 const before=structuredClone(pagePrompt);
 const result=compileCurrentPagePrompt({pageId:'page-001',pageKey:{page_id:'page-001'},pagePrompt,participantIds:[],dictionaryEntries:[{prompt_text:'from_side'},{prompt_text:'full_body'},{prompt_text:'motion_lines'}],profile:{id:'test',family:'anima',prompt:{separator:', ',avoidance_strategy:'negative_prompt',category_order:['population','person','setting','camera'],fragments:[]}}});
 assert.match(result.positive_prompt,/through the window/);assert.match(result.positive_prompt,/from_side, full_body, motion_lines/);
 assert.deepEqual(pagePrompt,before);
 const generated=result.prompt_parts.positive.filter(x=>x.origin_detail?.field?.startsWith('camera_settings.'));
 assert.equal(generated.length,3);assert.equal(generated.at(-1).origin_detail.field,'camera_settings.motionLines');
});
test('迁移提取对应参数；取消选项、自由描述和加权关闭项保持；可重复预览',()=>{
 const old={direction:'side',shot:'中景',view:'over_shoulder',perspective:true};
 const d={models:{anima:{...empty(),camera:[{description:'from side, medium shot, over-the-shoulder shot, perspective',camera_settings:old},{description:'from below',camera_settings:old},{description:'from side',weight:2,camera_settings:old},{description:'from side',enabled:false,camera_settings:old}]},qwen:{text:'unchanged'}}};
 const result=migrateCameraDocument(d);
 assert.deepEqual(result.models.anima.camera_settings,{direction:'side'});
 assert.deepEqual(result.models.anima.camera.map(x=>x.description),['medium shot, over-the-shoulder shot, perspective','from below','from side','from side']);
 assert.equal(result.models.anima.camera[2].weight,2);assert.equal(result.models.anima.camera[3].enabled,false);
 assert.deepEqual(result.models.qwen,d.models.qwen);assert.deepEqual(migrateCameraDocument(result),result);
 assert.ok(d.models.anima.camera[0].camera_settings);
});

test('显式迁移先预览校验指纹，保存留备份，重复执行无变更',async t=>{
 const {mkdir,mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
 const {fileURLToPath}=await import('node:url');const path=await import('node:path');
 const {migrateProjectCamera}=await import('../server/camera-migration.mjs');
 const base=fileURLToPath(new URL('../../Saved/Tests/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(path.join(base,'camera-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['pages','characters','scenes'])await mkdir(path.join(root,dir));
 const target=path.join(root,'pages/page-001.prompt.json');
 const doc={$schema:'https://storyvisualizer.local/schemas/story-page-prompt.schema.json',models:{anima:{...empty(),camera:[{description:'from side, medium shot',camera_settings:{direction:'side',shot:'中景'}}]}}};
 const raw=JSON.stringify(doc);await writeFile(target,raw);
 const plan=await migrateProjectCamera(root,{});assert.equal(plan.files,1);assert.equal(await readFile(target,'utf8'),raw);
 await assert.rejects(migrateProjectCamera(root,{apply:true,fingerprint:'wrong'}),{code:'camera_migration_conflict'});
 const r=await migrateProjectCamera(root,{apply:true,fingerprint:plan.fingerprint});assert.equal(r.migrated,1);
 assert.equal(await readFile(path.join(r.backup,'pages/page-001.prompt.json'),'utf8'),raw);
 assert.deepEqual(JSON.parse(await readFile(target,'utf8')).models.anima.camera_settings,{direction:'side'});
 assert.equal((await migrateProjectCamera(root,{})).files,0);
});
