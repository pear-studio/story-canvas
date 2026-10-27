import assert from "node:assert/strict";
import {before,after,test} from "node:test";
import {fileURLToPath} from "node:url";
import {createServer} from "vite";
import {chromium} from "playwright";

const ID="dataset-111111111111",OTHER_ID="dataset-222222222222";
const TAGS="caption-set-111111111111",PROSE="caption-set-222222222222",ITEM="item-111111111111";
const semantic={max_pixels:1048576,network_dim:32,network_alpha:32,learning_rate:0.0001,gradient_accumulation_steps:2,micro_batch_size:1,optimizer:{type:"AdamW",betas:[0.9,0.999],eps:1e-8,weight_decay:0.01},scheduler:{type:"constant"},precision:{base:"bf16",lora:"bf16",optimizer_state:"bf16"},gradient_checkpointing:true,lora_target_modules:["to_q"]};
const families=["qwen-image-2-1","anima","moss-image"];
const target=family=>({family,base:{dit:{relative_path:`${family}/model.safetensors`},text_encoder:{relative_path:`${family}/text.safetensors`},vae:{relative_path:`${family}/vae.safetensors`}},prompt_family:family,usage_defaults:{clip_skip:null,sampler:"euler",scheduler:"simple",steps:20,cfg:4}});
const recipes=families.map(family=>({id:`${family}-lora-v1`,version:1,name:`${family} defaults`,family,description:"",semantic_config:semantic,default_target:target(family)}));
const task=(family,captionSetId=TAGS)=>({version:6,name:`${family} 训练设置`,dataset_id:ID,caption_set_id:captionSetId,target:target(family),training_recipe:{id:`${family}-lora-v1`,overrides:{network_dim:32,learning_rate:0.0001,gradient_accumulation_steps:2}},run_defaults:{max_train_steps:family==="moss-image"?4000:2000,save_every_n_steps:500,seed:42}});
let server,browser,origin;
before(async()=>{
  server=await createServer({root:fileURLToPath(new URL("../../",import.meta.url)),cacheDir:"../Saved/Tests/lora-multimodel-vite",server:{host:"127.0.0.1",port:0},logLevel:"error"});
  await server.listen();origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==="win32"?"msedge":undefined)});
});
after(async()=>{await browser?.close();await server?.close();});

async function settleResponse(page,response){
  await response.finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

async function fixture(t,{legacy=false,gate}={}){
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  page.setDefaultTimeout(8000);
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});
  const state={writes:[],reads:[],sets:[{id:TAGS,name:"原有标签",format:"tags"},{id:PROSE,name:"自然语言复核",format:"prose"}],captions:{[TAGS]:"1girl, apron",[PROSE]:"A woman in an apron.\nSoft light falls on the fabric."},confirmed:new Set(),configs:{"qwen-image-2-1":task("qwen-image-2-1"),anima:task("anima")},name:"共用素材"};
  const summary=id=>({id,name:id===ID?state.name:"另一个项目",item_count:1,enabled_item_count:1,effective_item_count:1,activation_terms:[]});
  const detail=(id,setId=null)=>{
    const caption=id===ID?(state.captions[setId]??""):"This belongs to the second project.";
    const confirmed=state.confirmed.has(setId);
    const item={id:ITEM,asset_id:"asset-111111111111",group_id:"group-111111111111",enabled:true,file:"assets/example.png",caption,caption_sha256:"a".repeat(64),image_width:768,image_height:1024,image_bytes:512,image_version:"b".repeat(64),media_url:"lora-training/example.png",preparation:{resolution:1024,target:{width:768,height:1024},before_score:75,after_score:null,decision:"already_good",baseline_file:"assets/example.png",enhanced_file:null}};
    return {id,read_only:legacy,migration_required:legacy,caption_sets:legacy?[]:state.sets,caption_set_id:legacy?null:setId,dataset:{version:legacy?5:6,name:summary(id).name,description:"共享图片与处理",activation_terms:[],groups:[{id:item.group_id,name:"素材",enabled:true,repeats:1}],items:[{id:item.id,asset_id:item.asset_id,group_id:item.group_id,enabled:true}]},items:[{...item,caption:legacy?"original legacy caption":caption}],captioning:setId||legacy?{version:1,latest:null,summary:{total:1,with_base:0,confirmed:confirmed?1:0,unconfirmed:confirmed?0:1},items:[{item_id:ITEM,current_prompt:caption,base_prompt:null,image_sha256:"b".repeat(64),caption_sha256:"a".repeat(64),raw_tags:[],state:confirmed?"confirmed":"unconfirmed",confirmed}]}:null};
  };
  await page.route("**/api/**",async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.replace("/api/lora-training","");
    const send=(value,status=200)=>route.fulfill({json:value,status,headers:{etag:'"training-test"'}});
    if(url.pathname.includes("/media/"))return route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="1024" fill="#62958a"/></svg>'});
    if(url.pathname.includes("prompt-dictionary"))return send({available:true,matches:[],suggestions:[]});
    const body=req.method()==="GET"?null:req.postDataJSON();
    const call={path,method:req.method(),body,query:Object.fromEntries(url.searchParams),headers:req.headers()};
    (req.method()==="GET"?state.reads:state.writes).push(call);
    if(gate)await gate(call);
    if(path==="/datasets")return send({datasets:[summary(ID),summary(OTHER_ID)]});
    if(path==="/recipes")return send({recipes});
    if(path==="/environment")return send({available:true,runtime:null,checks:[],captioning:{configured:true,ready:true,id:"tagger",manifest:{name:"WD14"}}});
    if(path==="/tasks")return send({tasks:[ID,OTHER_ID].map(id=>({...summary(id),families:Object.keys(state.configs),dataset:summary(id),runs:[]}))});
    const datasetMatch=/^\/datasets\/(dataset-[a-f0-9]{12})$/.exec(path);
    if(datasetMatch){if(req.method()==="PUT")state.name=body.name;return send(detail(datasetMatch[1],url.searchParams.get("caption_set_id")));}
    if(path===`/datasets/${ID}/caption-sets`&&req.method()==="POST"){
      const id=`caption-set-${String(state.sets.length+1).repeat(12)}`;
      state.sets.push({id,name:body.name,format:body.format});state.captions[id]=body.source_id?state.captions[body.source_id]:"";
      return send(detail(ID,id));
    }
    if(path.startsWith(`/datasets/${ID}/caption-sets/`)&&req.method()==="PUT"){
      const id=path.split("/").at(-1);state.sets.find(set=>set.id===id).name=body.name;return send(detail(ID,id));
    }
    if(path===`/datasets/${ID}/captions/${ITEM}`){assert.ok(body.caption_set_id);state.captions[body.caption_set_id]=body.caption;state.confirmed.delete(body.caption_set_id);return send({saved:true,item_id:ITEM,caption:body.caption});}
    if(path===`/datasets/${ID}/captioning/items/${ITEM}`){assert.ok(body.caption_set_id);state.confirmed.add(body.caption_set_id);return send({saved:true,confirmed:true});}
    if(path===`/tasks/${ID}/models`){state.configs[body.family]=task(body.family,body.caption_set_id);return send({id:ID,family:body.family,families:Object.keys(state.configs),task:state.configs[body.family],dataset:summary(ID),runs:[]});}
    const taskMatch=/^\/tasks\/(dataset-[a-f0-9]{12})$/.exec(path);
    if(taskMatch){
      const family=req.method()==="PUT"?body.target.family:url.searchParams.get("family");assert.ok(families.includes(family),"task GET must identify a model");
      if(req.method()==="PUT")state.configs[family]=body;
      const current=state.configs[family]??null;
      const selected=current&&taskMatch[1]===OTHER_ID?{...current,dataset_id:OTHER_ID,name:"另一个项目的设置",run_defaults:{...current.run_defaults,max_train_steps:3000}}:current;
      return send({id:taskMatch[1],family,families:Object.keys(state.configs),task:selected,dataset:summary(taskMatch[1]),runs:[],read_only:legacy,migration_required:legacy});
    }
    if(path.endsWith("/run-settings")){
      const family=url.searchParams.get("family");assert.ok(families.includes(family));const config=state.configs[family];
      return send({recipe:{id:config.training_recipe.id,version:1,name:"默认配置"},semantic_config:semantic,values:config.run_defaults,last_run:null});
    }
    if(path.endsWith("/preflight")){assert.ok(families.includes(body.family));return send({ready:true,blockers:[],warnings:[],models:[]});}
    if(path==="/runs")return send({runs:[]});
    return send({error:`Unexpected test endpoint ${path}`},400);
  });
  return {page,state,go:section=>page.goto(`${origin}/tests/browser/fixtures/lora-multimodel.html?section=${section??"datasets"}`)};
}

test("独立打标集：自然语言整段保存、确认、复制和重命名；草稿切换须确认",async t=>{
  const {page,state,go}=await fixture(t);await go();
  const selection=page.getByRole("combobox",{name:"当前打标集"});await selection.selectOption(PROSE);
  const caption=page.getByRole("textbox",{name:"自然语言 Caption"});await caption.waitFor();
  assert.equal(await caption.inputValue(),state.captions[PROSE]);
  assert.equal(await page.getByRole("button",{name:"重新打标此图"}).count(),0);
  assert.equal(await page.locator(".lora-caption-tag-list").count(),0);
  const text="A woman, wearing an apron, stands by a window.\nWarm light reveals the woven fabric.";
  await caption.fill(text);await page.getByRole("button",{name:"保存 Caption",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="自然语言 Caption"]')?.value.includes("woven fabric"));
  await page.getByRole("button",{name:"确认当前 Caption",exact:true}).click();
  await page.locator(".lora-caption-confirmation").getByText("已确认",{exact:true}).waitFor();
  assert.equal(state.captions[TAGS],"1girl, apron");
  const captionWrite=state.writes.find(call=>call.path.endsWith(`/captions/${ITEM}`));assert.deepEqual(captionWrite.body,{caption:text,caption_set_id:PROSE});
  const confirmWrite=state.writes.find(call=>call.path.endsWith(`/captioning/items/${ITEM}`));assert.equal(confirmWrite.body.caption_set_id,PROSE);assert.equal(confirmWrite.body.confirm,true);assert.equal(state.writes.some(call=>call.path.includes("audit")),false);
  assert.equal(captionWrite.headers["if-match"],'"training-test"');
  await caption.fill("Unsaved caption");await selection.selectOption(TAGS);
  const discard=page.getByRole("dialog",{name:"切换打标集"});await discard.getByRole("button",{name:"取消",exact:true}).click();
  assert.equal(await selection.inputValue(),PROSE);assert.equal(await caption.inputValue(),"Unsaved caption");
  await selection.selectOption(TAGS);await page.getByRole("button",{name:"放弃并切换",exact:true}).click();
  await page.getByRole("region",{name:"当前 Caption 标签"}).waitFor();assert.equal(state.captions[PROSE],text);
  await selection.selectOption(PROSE);await caption.waitFor();
  await page.getByRole("button",{name:"复制",exact:true}).click();
  await page.getByRole("textbox",{name:"打标集名称"}).fill("独立副本");await page.getByRole("dialog",{name:"复制打标集"}).getByRole("button",{name:"保存",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="当前打标集"]')?.selectedOptions[0].textContent==="独立副本");
  const copiedId=await selection.inputValue();assert.equal(state.captions[copiedId],text);assert.ok(!state.confirmed.has(copiedId));
  await page.getByRole("button",{name:"改名",exact:true}).click();await page.getByRole("textbox",{name:"打标集名称"}).fill("复核版");await page.getByRole("dialog",{name:"重命名打标集"}).getByRole("button",{name:"保存",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="当前打标集"]')?.selectedOptions[0].textContent==="复核版");
  assert.deepEqual(state.writes.find(call=>call.path.endsWith(`/caption-sets/${copiedId}`)).body,{name:"复核版"});
  await page.getByRole("textbox",{name:"名称",exact:true}).fill("共享素材改名");await page.getByRole("button",{name:"保存数据集修改",exact:true}).click();
  await page.getByRole("heading",{name:"共享素材改名",exact:true}).waitFor();assert.equal(await selection.inputValue(),copiedId);assert.equal(await caption.inputValue(),text,"共享素材写入回执不能将编辑器切回默认集");
  await page.getByRole("button",{name:"新建打标集",exact:true}).click();await page.getByRole("textbox",{name:"打标集名称"}).fill("新增标签");await page.getByRole("combobox",{name:"打标集格式"}).selectOption("tags");await page.getByRole("dialog",{name:"新建打标集"}).getByRole("button",{name:"保存",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="当前打标集"]')?.selectedOptions[0].textContent==="新增标签");assert.equal(state.sets.at(-1).format,"tags");
});

test("打标集只控制 Caption 面板，切换保留共用素材草稿和左侧布局",async t=>{
  const {page,state,go}=await fixture(t);await go();
  const dock=page.getByRole("region",{name:"Caption 编辑",exact:true});
  const selection=dock.getByRole("combobox",{name:"当前打标集"});
  await selection.waitFor();
  const materials=page.locator(".lora-material-workspace > .lora-panel").first();
  const autoCaption=page.getByRole("button",{name:"为无标签图片生成基础 Prompt",exact:true});
  assert.equal(await materials.getByRole("button",{name:"为无标签图片生成基础 Prompt",exact:true}).count(),0);
  assert.equal(await dock.getByRole("button",{name:"为无标签图片生成基础 Prompt",exact:true}).count(),1);
  await page.getByRole("textbox",{name:"名称",exact:true}).fill("未保存的共用名称");
  await page.getByRole("textbox",{name:"分组名称",exact:true}).fill("共用分组草稿");
  await page.locator(".lora-group-enabled input").uncheck();
  const before=await materials.boundingBox();
  await selection.selectOption(PROSE);
  await page.getByRole("textbox",{name:"自然语言 Caption"}).waitFor();
  assert.equal(await page.getByRole("dialog").count(),0);
  assert.equal(await page.getByRole("textbox",{name:"名称",exact:true}).inputValue(),"未保存的共用名称");
  assert.equal(await page.getByRole("textbox",{name:"分组名称",exact:true}).inputValue(),"共用分组草稿");
  assert.equal(await page.locator(".lora-group-enabled input").isChecked(),false);
  assert.equal(await autoCaption.count(),0);
  const after=await materials.boundingBox();assert.equal(after.y,before.y);assert.equal(after.height,before.height);
  assert.equal(state.writes.length,0,"切换本身不写共享素材或 Caption");
  await page.getByRole("textbox",{name:"自然语言 Caption"}).fill("尚未保存的文本");
  await selection.selectOption(TAGS);await page.getByRole("button",{name:"放弃并切换",exact:true}).click();
  await page.getByRole("region",{name:"当前 Caption 标签"}).waitFor();
  assert.equal(await page.getByRole("textbox",{name:"名称",exact:true}).inputValue(),"未保存的共用名称");
  await page.getByRole("button",{name:"保存数据集修改",exact:true}).click();
  await page.getByRole("button",{name:"保存数据集修改",exact:true}).waitFor({state:"detached"});
  const save=state.writes.find(call=>call.method==="PUT"&&call.path===`/datasets/${ID}`);
  assert.equal(save.body.name,"未保存的共用名称");assert.equal(save.body.groups[0].name,"共用分组草稿");assert.equal(save.body.groups[0].enabled,false);
});

test("各模型独立配置：MOSS 显式初始化和打标集引用，草稿保护、预检携带 family",async t=>{
  const {page,state,go}=await fixture(t);await go("tasks");
  const models=page.getByRole("combobox",{name:"训练模型"});await models.selectOption("moss-image");
  await page.getByText("MOSS 尚未配置",{exact:true}).waitFor();
  const initialize=page.getByRole("button",{name:"建立模型配置",exact:true});assert.equal(await initialize.isDisabled(),true);
  await page.getByRole("combobox",{name:"初始化使用打标集"}).selectOption(PROSE);await initialize.click();
  const selected=page.getByRole("combobox",{name:"训练使用打标集"});await selected.waitFor();assert.equal(await selected.inputValue(),PROSE);
  const steps=page.locator("label").filter({has:page.locator("span.lora-field-label",{hasText:"总更新步数"})}).locator("input");
  assert.equal(await steps.inputValue(),"4000");await steps.fill("4100");
  await models.selectOption("qwen-image-2-1");await page.getByRole("dialog",{name:"切换训练模型"}).getByRole("button",{name:"取消",exact:true}).click();assert.equal(await models.inputValue(),"moss-image");assert.equal(await steps.inputValue(),"4100");
  await models.selectOption("qwen-image-2-1");await page.getByRole("button",{name:"放弃并切换",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="训练使用打标集"]')?.value==="caption-set-111111111111");assert.equal(await steps.inputValue(),"2000");
  await models.selectOption("moss-image");await selected.waitFor();assert.equal(await steps.inputValue(),"4000");
  await selected.selectOption(TAGS);await page.getByRole("button",{name:"保存配置",exact:true}).click();
  await page.getByRole("button",{name:"执行预检",exact:true}).click();await page.waitForFunction(()=>document.querySelector('.lora-primary-action button.button--primary')?.disabled===false);
  assert.deepEqual(state.writes.find(call=>call.path.endsWith("/models")).body,{family:"moss-image",caption_set_id:PROSE});
  const save=state.writes.find(call=>call.method==="PUT"&&call.path===`/tasks/${ID}`);assert.equal(save.body.target.family,"moss-image");assert.equal(save.body.caption_set_id,TAGS);assert.equal(state.configs["qwen-image-2-1"].run_defaults.max_train_steps,2000);
  assert.equal(state.writes.find(call=>call.path.endsWith("/preflight")).body.family,"moss-image");
});

test("旧版数据集和训练设置只读，仍可浏览原 Caption",async t=>{
  const {page,state,go}=await fixture(t,{legacy:true});await go();
  const caption=page.getByRole("textbox",{name:"旧版 Caption"});await caption.waitFor();assert.equal(await caption.inputValue(),"original legacy caption");assert.equal(await caption.getAttribute("readonly"),"");
  assert.equal(await page.getByRole("combobox",{name:"当前打标集"}).count(),0);assert.equal(await page.getByRole("button",{name:"保存 Caption",exact:true}).count(),0);
  await go("tasks");await page.getByText(/旧版训练配置 · 只读保留/).waitFor();assert.equal(await page.getByRole("button",{name:"保存配置",exact:true}).count(),0);assert.equal(state.writes.length,0);
});

test("切换项目后，较迟的原项目 Caption 回包不会覆盖当前项目",async t=>{
  let release,seen;const arrived=new Promise(resolve=>{seen=resolve;});const blocked=new Promise(resolve=>{release=resolve;});let held=false;
  const {page,go}=await fixture(t,{gate:async call=>{if(!held&&call.path===`/datasets/${ID}`){held=true;seen();await blocked;}}});
  await go();await arrived;await page.getByRole("combobox",{name:"测试项目"}).selectOption(OTHER_ID);
  const selection=page.getByRole("combobox",{name:"当前打标集"});await selection.selectOption(PROSE);
  const caption=page.getByRole("textbox",{name:"自然语言 Caption"});await caption.waitFor();assert.equal(await caption.inputValue(),"This belongs to the second project.");
  const late=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/lora-training/datasets/${ID}`);release();await settleResponse(page,await late);
  assert.equal(await caption.inputValue(),"This belongs to the second project.");assert.equal(await page.getByRole("combobox",{name:"测试项目"}).inputValue(),OTHER_ID);
});

test("切换项目后，较迟的原项目模型配置不会覆盖当前设置",async t=>{
  let release,seen;const arrived=new Promise(resolve=>{seen=resolve;});const blocked=new Promise(resolve=>{release=resolve;});let held=false;
  const {page,go}=await fixture(t,{gate:async call=>{if(!held&&call.path===`/tasks/${ID}`){held=true;seen();await blocked;}}});
  await go("tasks");await arrived;await page.getByRole("combobox",{name:"测试项目"}).selectOption(OTHER_ID);
  const steps=page.locator("label").filter({has:page.locator("span.lora-field-label",{hasText:"总更新步数"})}).locator("input");
  await steps.waitFor();assert.equal(await steps.inputValue(),"3000");
  const late=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/lora-training/tasks/${ID}`);release();await settleResponse(page,await late);
  assert.equal(await steps.inputValue(),"3000");assert.equal(await page.getByRole("combobox",{name:"测试项目"}).inputValue(),OTHER_ID);
});
