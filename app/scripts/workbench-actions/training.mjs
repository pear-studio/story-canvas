import { endpoint, encode, localImage, downloadArtifact } from './http-action.mjs';
import { loadWorkbenchConfig } from '../workbench-client.mjs';
import { schema, string, object, array, boolean, textValue } from './contract.mjs';
const root='/api/lora-training';
const dataset={dataset_id:string('training.dataset.list 返回的 ID')}, task={task_id:string('训练任务 ID，与数据集 ID 相同')}, run={...task,run_id:string('run ID')};
const ds=(a,suffix='')=>`${root}/datasets/${encode(a.dataset_id)}${suffix}`;
const ts=(a,suffix='')=>`${root}/tasks/${encode(a.task_id)}${suffix}`;
const endpointRead=(summary,route,fields={},options={})=>endpoint(summary,'GET',route,fields,{details:'返回 {value,etag}；事实写入必须带同一目标读取时的 etag，不使用项目 revision。',...options});
const dsWrite=(summary,suffix,fields,body,options={})=>endpoint(summary,'POST',a=>ds(a,suffix),{...dataset,...fields},{credential:'etag',body,...options});
export const trainingActions={
  'training.environment':endpointRead('查询训练环境，不运行模型',`${root}/environment`),
  'training.recipes':endpointRead('查询训练配方',`${root}/recipes`),
  'training.activation-guide':endpointRead('读取训练激活词规范',`${root}/guides/activation-tags`),
  'training.dataset.list':endpointRead('查询训练数据集目录',`${root}/datasets`),
  'training.dataset.read':endpointRead('读取数据集事实、素材与 ETag',a=>ds(a),dataset,{details:'返回 value.dataset 为可写文档；value.items/ captioning 是投影，不写回。保存完整 dataset，可调整 groups、items enabled/group_id，删除条目会删除不再引用的素材。'}),
  'training.dataset.create':endpoint('创建训练数据集与默认任务','POST',`${root}/datasets`,{name:string('名称'),description:textValue('说明'),activation_terms:array('激活词'),path:string('可选不存在的外部正式目录')},{required:['name'],credential:'etag',body:({etag,...a})=>a,details:'先 training.dataset.list 取得集合 ETag。省略 path 建立临时项目，自动创建默认训练设置，不启动训练。'}),
  'training.dataset.save':endpoint('保存完整数据集文档','PUT',a=>ds(a),{...dataset,document:object('read 的 value.dataset，保留版本、groups、items 身份')},{credential:'etag',body:a=>a.document,details:'增删分组、调整 repeats、启用状态和删除条目通过该文档；新增素材用 import，不捏造 items。'}),
  'training.item.copy':dsWrite('复制训练素材条目','/copies',{source_item_id:string('源条目'),group_id:string('目标分组，可省略'),asset_id:string('可选新素材 ID')},a=>({source_item_id:a.source_item_id,group_id:a.group_id,asset_id:a.asset_id}),{required:['dataset_id','source_item_id'],details:'复制图像和 Caption，不加载模型；写入带数据集 ETag。'}),
  'training.caption.read':endpointRead('查询 Caption 状态',a=>ds(a,'/captioning'),dataset),
  'training.caption.save':endpoint('保存人工 Caption','PUT',a=>ds(a,`/captions/${encode(a.item_id)}`),{...dataset,item_id:string('素材条目 ID'),caption:textValue('完整 Caption')},{credential:'etag',body:a=>({caption:a.caption})}),
  'training.caption.confirm':endpoint('确认或保存模型 Caption','PUT',a=>ds(a,`/captioning/items/${encode(a.item_id)}`),{...dataset,item_id:string('素材条目 ID'),prompt:textValue('完整文本'),confirm:boolean('是否标记确认')},{credential:'etag',body:a=>({prompt:a.prompt,confirm:a.confirm})}),
  'training.caption.run.read':endpointRead('读取自动 Caption 任务',a=>ds(a,`/caption-runs/${encode(a.run_id)}`),{...dataset,run_id:string('Caption run ID')}),
  'training.audit.read':endpointRead('读取 Caption 审计状态',a=>ds(a,'/caption-audit'),dataset),
  'training.audit.save':dsWrite('记录已检查图片的 Caption 审计','/caption-audit',{image_sha256:array('已核查图片 SHA256'),prompt_family:{...string('审计 Prompt 家族'),enum:['anima']}},a=>({image_sha256:a.image_sha256,prompt_family:a.prompt_family})),
  'training.task.list':endpointRead('查看训练任务目录',`${root}/tasks`),
  'training.task.read':endpointRead('读取训练任务和运行记录',a=>ts(a),task,{details:'返回 value.task 为可写设置；保存仅修改 task，运行历史不写回。dataset_id 固定不变。'}),
  'training.task.save':endpoint('保存训练设置','PUT',a=>ts(a),{...task,document:object('task.read 的 value.task 完整文档')},{credential:'etag',body:a=>a.document,details:'保留 dataset_id、版本和配方结构；训练参数的字段与范围由读取结果及 training.recipes 给出。'}),
  'training.run.settings':endpointRead('读取本次训练参数默认值和范围',a=>ts(a,'/run-settings'),task),
  'training.preflight':endpoint('训练预检，不启动训练','POST',a=>ts(a,'/preflight'),{...task,run_settings:object('run.settings 返回 values：note、max_train_steps、save_every_n_steps、seed、gradient_accumulation_steps')},{body:a=>({run_settings:a.run_settings}),details:'检查模型、数据、参数和磁盘。只有 ready=true 才可运行；预检结果不等于训练已启动。'}),
  'training.run.list':endpointRead('查询所有训练运行',`${root}/runs`),
  'training.run.stop':endpoint('停止已有训练运行','POST',a=>ts(a,`/runs/${encode(a.run_id)}/stop`),run,{details:'极简模式允许停止现有运行，不启动模型。'}),
  'training.run.delete':endpoint('删除已停止运行的派生记录','DELETE',a=>ts(a,`/runs/${encode(a.run_id)}`),run,{details:'仅按用户明确授权删除；正式 checkpoint 权重不随运行记录自动删除。'}),
  'training.image.restore':dsWrite('恢复素材原图，不运行模型','/postprocess/restore',{item_id:string('素材 ID')},a=>({item_id:a.item_id,prepare:false})),
  'training.image.apply':dsWrite('应用已有处理预览，不运行模型','/postprocess/apply',{item_id:string('素材 ID'),preview_id:string('预览返回的 fingerprint'),crop:object('原预览的裁剪 {x,y,width,height}'),upscale:boolean('必须与预览一致'),output_scale:{type:'integer',enum:[1,2,4],description:'若预览超分则携带原倍率'}},a=>({item_id:a.item_id,preview_id:a.preview_id,crop:a.crop,upscale:a.upscale,output_scale:a.output_scale,prepare:false}),{required:['dataset_id','item_id','preview_id','crop','upscale'],details:'使用已生成的预览，校验图像和预览指纹。不自动触发质量评分/超分；需要时另调用 training.image.prepare。'}),
  'training.image.crop':dsWrite('生成纯裁剪预览，不加载模型','/postprocess/preview',{item_id:string('素材 ID'),crop:object('像素坐标 {x,y,width,height}')},a=>({item_id:a.item_id,crop:a.crop,upscale:false})),
  'training.image.preview':{summary:'下载已存在的处理预览',parameters:schema({...dataset,preview_id:string('预览 fingerprint')}),details:'下载 PNG 到本机审阅目录。',execute:a=>downloadArtifact(ds(a,`/postprocess/preview/${encode(a.preview_id)}`))},
  'training.image.read':{summary:'下载训练素材或结果媒体',parameters:schema({relative_path:string('接口返回媒体 URL 中 /api/lora-training/media/ 之后的相对路径')}),details:'仅读取已存在文件，返回本机绝对路径。',execute:a=>downloadArtifact(`${root}/media/${a.relative_path.split('/').map(encode).join('/')}`)},
};
trainingActions['training.asset.import']={summary:'导入本地图片，不自动运行图像准备模型',parameters:schema({...dataset,group_id:string('数据集现有分组 ID'),files:array('PNG/JPEG/WebP 本机绝对路径',string('图片路径'),16),etag:string('数据集读取的 ETag')}),details:'最多16张，每张最多32MB；使用 multipart 上传，图片不进入模型上下文。导入后可人工编辑 Caption。模型图像准备必须单独调用。',async execute(a){
  const form=new FormData();form.set('group_id',a.group_id);form.set('prepare','false');
  for(const file of a.files){const image=await localImage(file);form.append('files',new Blob([Buffer.from(image.content,'base64')]),image.filename);}
  const {port=3000}=await loadWorkbenchConfig();const response=await fetch(`http://127.0.0.1:${port}${ds(a,'/assets')}`,{method:'POST',headers:{'if-match':a.etag},body:form});
  const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.message??value.error),{status:response.status,code:value.error,details:value.details});return{value,etag:response.headers.get('etag')};
}};
// 所有能力属于同一完整工具；仅执行类有 capability 标记，供限制插件统一禁止。
trainingActions['training.run.start']=endpoint('启动一轮训练','POST',a=>ts(a,'/runs'),{...task,run_settings:object('预检使用的完整 run_settings')},{credential:'etag',capability:'training',body:a=>({run_settings:a.run_settings}),details:'须用户授权且 training.preflight ready=true；先保存参数，携带任务 ETag，返回运行身份。'});
trainingActions['training.run.resume']=endpoint('从完整快照继续训练','POST',a=>ts(a,`/runs/${encode(a.run_id)}/resume`),{...run,source_snapshot_id:string('任务记录的 step-XXXXXX'),source_sha256:string('来源快照 SHA'),max_train_steps:{type:'integer',minimum:1,description:'目标总步数'},note:textValue('可选说明')},{required:['task_id','run_id','source_snapshot_id','source_sha256','max_train_steps'],credential:'etag',capability:'training',body:({task_id,run_id,etag,...body})=>body,details:'冻结最新来源身份；陈旧快照拒绝。只能在用户授权范围内启动。'});
trainingActions['training.caption.run']=dsWrite('运行自动 Caption 模型','/caption-runs',{mode:{...string('打标范围'),enum:['missing','single']},item_id:string('可选单条目'),confirm_overwrite:boolean('覆盖时显式true')},a=>({mode:a.mode,item_id:a.item_id,confirm_overwrite:a.confirm_overwrite}),{required:['dataset_id','mode'],capability:'training'});
trainingActions['training.image.prepare']=dsWrite('运行图像质量评估和自动增强','/postprocess/prepare',{item_ids:array('可选条目ID')},a=>({item_ids:a.item_ids}),{required:['dataset_id'],capability:'training'});
trainingActions['training.image.upscale']=dsWrite('运行超分并生成处理预览','/postprocess/preview',{item_id:string('素材 ID'),crop:object('裁剪 {x,y,width,height}'),output_scale:{type:'integer',enum:[1,2,4],description:'倍率'}},a=>({item_id:a.item_id,crop:a.crop,upscale:true,output_scale:a.output_scale}),{capability:'training'});
trainingActions['training.image.bulk-upscale']=dsWrite('批量运行素材超分','/postprocess/bulk-upscale',{},()=>({}),{capability:'training',details:'须用户明确批量授权，可能加载模型且耗时；完成后重读数据集。'});


