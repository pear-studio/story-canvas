import { endpoint, encode, localImage, downloadArtifact } from './http-action.mjs';
import { loadWorkbenchConfig } from '../workbench-client.mjs';
import { schema, string, object, array, boolean, textValue } from './contract.mjs';
const root='/api/lora-training';
const family={...string('明确选择的训练模型家族'),enum:['anima','qwen-image-2-1','moss-image']};
const captionSet={caption_set_id:string('training.caption.set.list 返回的打标集 ID，不按模型隐式选择')};
const setQuery=a=>({caption_set_id:a.caption_set_id});
const familyQuery=a=>({family:a.family});
const dataset={dataset_id:string('training.dataset.list 返回的 ID')}, task={task_id:string('训练任务 ID，与数据集 ID 相同')}, run={...task,run_id:string('run ID')};
const ds=(a,suffix='')=>`${root}/datasets/${encode(a.dataset_id)}${suffix}`;
const ts=(a,suffix='')=>`${root}/tasks/${encode(a.task_id)}${suffix}`;
const endpointRead=(summary,route,fields={},options={})=>endpoint(summary,'GET',route,fields,{details:'返回 {value,etag}；事实写入必须带同一目标读取时的 etag，不使用项目 revision。',...options});
const dsWrite=(summary,suffix,fields,body,options={})=>endpoint(summary,'POST',a=>ds(a,suffix),{...dataset,...fields},{credential:'etag',body,...options});
export const trainingActions={
  'training.caption.set.list':endpointRead('列举项目内独立打标集',a=>ds(a,'/caption-sets'),dataset),
  'training.caption.set.create':dsWrite('创建独立打标集','/caption-sets',{name:string('打标集名称'),format:{...string('编辑格式'),enum:['tags','prose']}},a=>({name:a.name,format:a.format}),{details:'创建空集，不更改图片、已有打标集或训练配置。自然语言由 Agent 写入，不调用视觉模型。'}),
  'training.caption.set.copy':dsWrite('复制打标文本为独立新集','/caption-sets',{source_id:string('来源打标集 ID'),name:string('新打标集名称'),format:{...string('新集编辑格式'),enum:['tags','prose']}},a=>({source_id:a.source_id,name:a.name,format:a.format}),{details:'复制文本供独立实验；不继承确认和审计，不改变原集或共享素材。'}),
  'training.caption.set.rename':endpoint('重命名打标集','PUT',a=>ds(a,`/caption-sets/${encode(a.caption_set_id)}`),{...dataset,...captionSet,name:string('新名称')},{credential:'etag',body:a=>({name:a.name}),details:'只改名称，ID与引用保持不变，格式不切换。'}),
  'training.caption.set.import':endpoint('按图片哈希批量导入打标文本','POST',a=>ds(a,`/caption-sets/${encode(a.caption_set_id)}/import`),{...dataset,...captionSet,entries:{type:'array',minItems:1,items:schema({item_id:string('现有素材条目 ID'),image_sha256:string('当前图片 SHA256'),caption:textValue('保留的原始文本'),caption_sha256:string('可选文本 UTF-8 SHA256')},['item_id','image_sha256','caption'])}},{credential:'etag',body:a=>({entries:a.entries}),details:'先核对全部图片及可选文本哈希再原子保存；保留原文，清除受影响条目的确认，不增加看图审计。图片须先通过 asset.import 导入。'}),
  'training.task.model.create':endpoint('初始化项目中一个模型的训练配置','POST',a=>ts(a,'/models'),{...task,family,...captionSet},{credential:'etag',body:a=>({family:a.family,caption_set_id:a.caption_set_id}),details:'每模型最多一套配置；使用该模型默认配方，明确引用打标集，不启动训练。'}),
  'training.migration.inspect':endpointRead('检查旧训练项目迁移计划',a=>ds(a,'/migration'),dataset,{details:'只读检查；返回 value.fingerprint 与项目 ETag，执行迁移时将 fingerprint 传入 expected_fingerprint。迁移保持素材身份、图片和历史 run，不重新打标。'}),
  'training.migration.apply':dsWrite('显式迁移旧训练项目','/migration',{expected_fingerprint:string('migration.inspect 的 value.fingerprint')},a=>({expected_fingerprint:a.expected_fingerprint}),{details:'使用 inspect 的 ETag 和 fingerprint，活动训练或事实变化拒绝。先在 Training/migrations 保存可恢复备份；不改图片或历史 run，只在图像和文本哈希一致时保持旧确认。'}),

  'training.environment':endpointRead('查询训练环境，不运行模型',`${root}/environment`,{family},{query:familyQuery,details:'按明确家族检查 Anima、Qwen 或 MOSS 环境；MOSS 使用登记的 SFT BF16 底座，不自动回退。'}),
  'training.recipes':endpointRead('查询训练配方',`${root}/recipes`),
  'training.activation-guide':endpointRead('读取训练激活词规范',`${root}/guides/activation-tags`),
  'training.dataset.list':endpointRead('查询训练数据集目录',`${root}/datasets`),
  'training.dataset.read':endpointRead('读取共享素材或指定打标集',a=>ds(a),{...dataset,...captionSet},{required:['dataset_id'],query:setQuery,details:'不传 caption_set_id 只读共享素材与 caption_sets 目录；指定后返回该集的 items.caption/captioning。value.dataset 是共享可写文档，其余为投影。旧版返回 read_only/migration_required，需显式迁移。'}),
  'training.dataset.create':endpoint('创建训练数据集与默认任务','POST',`${root}/datasets`,{name:string('名称'),description:textValue('说明'),activation_terms:array('激活词'),path:string('可选不存在的外部正式目录')},{required:['name'],credential:'etag',body:({etag,...a})=>a,details:'先 training.dataset.list 取得集合 ETag。省略 path 建立临时项目，自动创建默认训练设置，不启动训练。'}),
  'training.dataset.save':endpoint('保存完整数据集文档','PUT',a=>ds(a),{...dataset,document:object('read 的 value.dataset，保留版本、groups、items 身份')},{credential:'etag',body:a=>a.document,details:'增删分组、调整 repeats、启用状态和删除条目通过该文档；新增素材用 import，不捏造 items。'}),
  'training.item.copy':dsWrite('复制训练素材条目','/copies',{source_item_id:string('源条目'),group_id:string('目标分组，可省略'),asset_id:string('可选新素材 ID')},a=>({source_item_id:a.source_item_id,group_id:a.group_id,asset_id:a.asset_id}),{required:['dataset_id','source_item_id'],details:'复制图像和 Caption，不加载模型；写入带数据集 ETag。'}),
  'training.caption.read':endpointRead('查询指定打标集的 Caption 状态',a=>ds(a,'/captioning'),{...dataset,...captionSet},{query:setQuery}),
  'training.caption.save':endpoint('保存指定打标集的人工 Caption','PUT',a=>ds(a,`/captions/${encode(a.item_id)}`),{...dataset,...captionSet,item_id:string('素材条目 ID'),caption:textValue('完整 Caption，原文保存')},{credential:'etag',body:a=>({caption:a.caption,caption_set_id:a.caption_set_id})}),
  'training.caption.confirm':endpoint('保存并确认指定打标集的 Caption','PUT',a=>ds(a,`/captioning/items/${encode(a.item_id)}`),{...dataset,...captionSet,item_id:string('素材条目 ID'),prompt:textValue('完整文本'),confirm:boolean('是否确认当前图片与文本')},{credential:'etag',body:a=>({prompt:a.prompt,confirm:a.confirm,caption_set_id:a.caption_set_id})}),
  'training.caption.run.read':endpointRead('读取指定打标集的自动 Caption 任务',a=>ds(a,`/caption-runs/${encode(a.run_id)}`),{...dataset,...captionSet,run_id:string('Caption run ID')},{query:setQuery}),
  'training.audit.read':endpointRead('读取指定打标集的图片审计状态',a=>ds(a,'/caption-audit'),{...dataset,...captionSet},{query:setQuery}),
  'training.audit.save':dsWrite('记录指定打标集实际看过的图片','/caption-audit',{...captionSet,image_sha256:array('实际看过的图片 SHA256')},a=>({image_sha256:a.image_sha256,caption_set_id:a.caption_set_id})),
  'training.task.list':endpointRead('查看训练任务目录',`${root}/tasks`),
  'training.task.read':endpointRead('读取指定模型的训练配置和历史',a=>ts(a),{...task,family},{query:familyQuery,details:'返回 value.task 为该模型可写设置；尚未创建时 task=null，通过 training.task.model.create 初始化。模型配置引用 caption_set_id；历史不写回。'}),
  'training.task.save':endpoint('保存一个模型的训练设置','PUT',a=>ts(a),{...task,document:object('task.read 的 value.task，必须含 target.family 与 caption_set_id')},{credential:'etag',body:a=>a.document,details:'只保存 document.target.family 对应的一套配置，不覆盖其他模型；打标集必须真实存在。参数用 training.recipes 与 run.settings 查看，保存不得暗中追加触发词或改写 Caption。'}),
  'training.run.settings':endpointRead('读取指定模型的运行参数默认值和范围',a=>ts(a,'/run-settings'),{...task,family},{query:familyQuery}),
  'training.preflight':endpoint('指定模型训练预检，不启动训练','POST',a=>ts(a,'/preflight'),{...task,family,run_settings:object('同模型 run.settings 返回的完整 values')},{body:a=>({family:a.family,run_settings:a.run_settings}),details:'检查所选模型配置、其引用的打标集、图像/Caption确认、环境和磁盘。只有 ready=true 才可运行；预检结果不等于训练已启动。'}),
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
trainingActions['training.run.start']=endpoint('启动一轮训练','POST',a=>ts(a,'/runs'),{...task,family,run_settings:object('同模型预检使用的完整 run_settings')},{credential:'etag',capability:'training',body:a=>({family:a.family,run_settings:a.run_settings}),details:'须用户授权且 training.preflight ready=true；先保存参数，携带任务 ETag，返回运行身份。'});
trainingActions['training.run.resume']=endpoint('从完整快照继续训练','POST',a=>ts(a,`/runs/${encode(a.run_id)}/resume`),{...run,source_snapshot_id:string('任务记录的 step-XXXXXX'),source_sha256:string('来源快照 SHA'),max_train_steps:{type:'integer',minimum:1,description:'目标总步数'},note:textValue('可选说明')},{required:['task_id','run_id','source_snapshot_id','source_sha256','max_train_steps'],credential:'etag',capability:'training',body:({task_id,run_id,etag,...body})=>body,details:'冻结最新来源身份；陈旧快照拒绝。只能在用户授权范围内启动。'});
trainingActions['training.caption.run']=dsWrite('运行自动 Caption 模型','/caption-runs',{...captionSet,mode:{...string('打标范围'),enum:['missing','single']},item_id:string('可选单条目'),confirm_overwrite:boolean('覆盖时显式true')},a=>({caption_set_id:a.caption_set_id,mode:a.mode,item_id:a.item_id,confirm_overwrite:a.confirm_overwrite}),{required:['dataset_id','caption_set_id','mode'],capability:'training'});
trainingActions['training.image.prepare']=dsWrite('运行图像质量评估和自动增强','/postprocess/prepare',{item_ids:array('可选条目ID')},a=>({item_ids:a.item_ids}),{required:['dataset_id'],capability:'training'});
trainingActions['training.image.upscale']=dsWrite('运行超分并生成处理预览','/postprocess/preview',{item_id:string('素材 ID'),crop:object('裁剪 {x,y,width,height}'),output_scale:{type:'integer',enum:[1,2,4],description:'倍率'}},a=>({item_id:a.item_id,crop:a.crop,upscale:true,output_scale:a.output_scale}),{capability:'training'});
trainingActions['training.image.bulk-upscale']=dsWrite('批量运行素材超分','/postprocess/bulk-upscale',{},()=>({}),{capability:'training',details:'须用户明确批量授权，可能加载模型且耗时；完成后重读数据集。'});

const trainingWriteHelp='写入沿用同一项目最近详情的 ETag；集合创建回执不能代替详情版本，素材与设置共享版本，不用剧情 revision。冲突重新读取并判断，不只换 etag 重放；批量只重查失败项，结果不明先核实。';
for(const name of ['training.dataset.read','training.task.read'])trainingActions[name].details+=' 返回 {value,etag}，素材和设置视图共享项目 ETag。';
for(const name of ['training.dataset.save','training.caption.save','training.caption.confirm','training.audit.save','training.task.save','training.run.start','training.run.resume'])trainingActions[name].details=(trainingActions[name].details??'')+' '+trainingWriteHelp;
trainingActions['training.dataset.read'].details+=' 有效训练集合只包含 item 与所属 group 均启用的图片；group repeats 参与采样。';
trainingActions['training.caption.read'].details+=' unlabeled 为文本为空且无基础 Prompt，unconfirmed 为未绑定当前图片和 Caption 哈希，confirmed 为两者均匹配；所选打标集的 Caption 是唯一训练文本。AnimeTimm raw_tags 保留下划线，rating 仅存原始结果。';
trainingActions['training.caption.save'].details+=' 保存文本清除确认；改图片、裁剪、超分或恢复后也须重新确认。';
trainingActions['training.caption.confirm'].details+=' 确认绑定当前图片与 Caption 两个哈希；启用条目不等于已确认。';
trainingActions['training.audit.save'].details+=' 只登记在该打标集审阅时实际看过的图片；审计与当前文本确认独立，不把复制集或训练确认冒充看图记录。阻断问题不标已审计。';
trainingActions['training.image.restore'].details='恢复原图并失效旧确认，不自动准备训练图；需要时另调用 training.image.prepare。';
trainingActions['training.caption.run'].details='仅支持 tags 打标集；prose 由 Agent 写入，网页不调用模型打标。missing 只处理缺 Caption 的图片；single 指定条目，已有文本覆盖须 confirm_overwrite:true。不支持数据集级覆盖；检查 run.read，不重复提交等待中的运行。';
trainingActions['training.image.prepare'].details='显式准备指定或有效素材，按配方尺寸保留比例，并以 MUSIQ 比较缩放与超分；打开或刷新不触发。失败不删除素材，修复后显式重试。可能加载模型，需 training 能力。';
trainingActions['training.preflight'].details+=' 检查有效集合的准备状态和 Caption 双哈希确认；空文本或未确认阻断。run_settings 从 run.settings 读取，启动沿用同一设置。';
trainingActions['training.run.start'].details+=' 服务重新预检并冻结数据、设置、底座、recipe、训练器和 runner 身份；返回的 run 状态与结构化事件是进度依据。';
trainingActions['training.run.stop'].details+=' 停止不要求 ETag。Qwen 缓存阶段没有恢复点，训练阶段在完整更新边界保存；Anima 与 MOSS 只保留已保存的 checkpoint，不提供精确续训。强制中断可能回退到最近保存状态，重启不自动继续。';
trainingActions['training.run.resume'].details+=' 仅支持 Qwen 最新完整恢复包，Anima 与 MOSS 不支持精确续训；恢复不读取当前模型配置或打标集。创建新 run，沿用父 run 冻结数据、参数和保存间隔；累计目标步数必须增加，只可改预算和备注。来源 ID/SHA 不匹配或活动 run 拒绝；每次成功发布新恢复包后只保留最新包，checkpoint 仍分别保留。';


