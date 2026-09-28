import { requestWorkbench } from '../workbench-client.mjs';
import { pageEditHelp } from './page-edit-help.mjs';
import { schema, string, object, array, boolean, pagination, paginate } from './contract.mjs';
import {saveOperationRecord,readOperationRecord} from './operation-records.mjs';
import { endpoint, projectId, pageKey, projectPath, encode, localImage, downloadArtifact } from './http-action.mjs';
const post = (summary, suffix, fields, options = {}) => endpoint(summary, 'POST', a => projectPath(a, `workbench/${suffix}`), fields, { project: true, ...options });
const target = { ...schema({ kind: { ...string('归属'), enum: ['character','scene','page'] }, id: string('角色/场景/页面 ID'), variant_id: string('角色和场景需要子设定 ID'), model_id: string('模型分支，默认 qwen') }, ['kind','id']), description: '参考图归属；角色和场景必须给 variant_id' };
const reference = (summary, action, fields, required, body) => post(summary, 'reference-library', { target, ...fields }, { required: ['target', ...required], details: '先 reference.list 取得 entries 与 sha256；修改传 expected_sha256。参考图最多十张，候选提升后保存到 materials，不依赖临时输出。', body: a => ({ target:a.target, action, ...body(a) }) });
export const mediaActions = {
  'candidate.sheet': endpoint('按单元或章节顺序查看最新批次的全部画面','POST','/api/agent/candidate-sheet',{
    sequence_id:string('单元 ID；与 chapter_id 恰好提供一个'),chapter_id:string('章节 ID；与 sequence_id 恰好提供一个'),
  },{project:true,required:[],body:a=>a,transform:r=>r.value,
    details:'按正式章节/单元/页面顺序，展示每页最新创建生成任务的全部候选；候选按任务内顺序。不按目录时间挑图，不回退旧批次，不删除或生成图片。失败、未出图、已删除图片原位标注；文字页显示文字卡。每张最多12格，自动覆盖整个范围。返回 sheets 的图片绝对路径，依次用 read_image 查看；manifest 保存完整页序、任务和候选身份。结果是读取时快照，生成变化后重新调用。仅生成本机预览，不加载大模型，极简模式可用。'}),
  'page.render.read': endpoint('读取单页模型、画幅及可选值','POST','/api/agent/page-render/read',{page_key:pageKey},
    {project:true,body:a=>a,transform:r=>r.value,details:'返回该页完整 render 文件、模型/画幅选项及 page.render.set 保存参数。只影响当前页；项目默认设置用于新页。无需读取组装后的 Prompt。'}),
  'page.render.set': endpoint('独立设置单页模型或画幅','POST','/api/agent/page-render/set',{
    page_key:pageKey,expected_sha256:string('page.render.read 返回的版本'),model_id:string('可选模型 ID，见 read.options.models'),
    canvas:string('可选画幅，见 read.options.canvases'),profile_id:string('可选显式生成配置；通常省略'),
  },{project:true,required:['page_key','expected_sha256'],body:a=>a,transform:r=>r.value,
    recover:(error,a)=>({message:error.status===409?'页面设置或 Prompt 已变化；重读并判断，不直接换指纹覆盖。':'重读当前设置和选项；核对模型与配置是否匹配、画幅是否受支持。',next:{operation:'page.render.read',args:{project_id:a.project_id,page_key:a.page_key}}}),
    details:'先 page.render.read 核验，再带 save.args 和要改的 model_id、canvas 或 profile_id，至少一项。仅改画幅保留模型和配置；切换模型时省略 profile_id 自动配对该模型默认配置，未提供字段保留。配置必须匹配模型并支持画幅。保留已有各模型 Prompt；首次切换按模型规则初始化缺失分支（Anima 转 Qwen 会导入有效文本），之后可用 page.editor.read 核验。只保存，不加载模型、不出图，不改其他页或项目默认值。409 重读判断，不能直接换新指纹覆盖。'}),
  'page.editor.read': endpoint('读取相关页面文件全文，不展开引用','POST','/api/agent/page-editor',{
    page_key:pageKey,section:{type:'string',enum:['prompt','content','render'],description:'默认 prompt；content 是页面内容，文字页含正文和排版；render 是模型与画幅'},
  },{project:true,required:['page_key'],body:a=>a,details:'参数例 {project_id:"demo",page_key:{page_id:"page-001"},section:"content"}。只返回所选文件完整 document 和 save。多页同类编辑用 page.editor.batch.read/save（每批最多16页）。先改 content，再重读 prompt 后编辑；content 变化会使之前的 Prompt 指纹失效。按 save.args 提交 changes，无需抄回全文或组装上下文。文字页（page_kind:text）的显示标题用 display_title，正文用 body，排版用 text_layout；title 仅为目录标题，scene_description 不替代正文。插画页对白布局才用 lettering.page.read/save。',transform:r=>r.value}),
  'page.editor.save': endpoint('局部修改页面文件，保留未涉及字段','POST','/api/agent/page-editor/save',{
    page_key:pageKey,section:{type:'string',enum:['prompt','content','render'],description:'读取回执中的 section'},
    expected_sha256:string('读取回执中的版本；页面或上游变化时409，必须重读判断'),changes:object('仅修改字段；对象递归合并，数组整项替换，null删除键'),
  },{project:true,body:a=>a,recover:(error,a)=>({message:error.status===409?'相关文件或上游已变化；重新核验后再决定修改，不直接换指纹覆盖。':'重读本次相关文件核实结果，按该文件格式修改。',next:{operation:'page.editor.read',args:{project_id:a.project_id,page_key:a.page_key,section:a.section}}}),details:'使用 page.editor.read 返回的 save.args，加 changes。对象递归合并；数组整项替换，空数组清空；null 删除对应键以恢复继承，不表示写入空值。保留已有词条 id，新增词条省略 id。成功返回完整更新文件用于核验及新的 save；失败不自动重试，未涉及模型分支保持原样；改变角色引用时沿用领域规则清理失效引用。例：content 的 changes:{title:"新标题"}；Prompt 按读取文件的 models 结构填写 changes。文字页例 changes:{display_title:"次日",body:"新的正文",text_layout:{body_font_size:48}}；清空正文用空字符串。text_layout 字号 title_font_size/body_font_size 为12–192整数，title_align/body_align 为 left/center/right，position 为 upper/center/lower。不得修改 page_kind；本入口保存文字内容与排版，不出图。单独设置模型和画幅优先 page.render.read/set。',transform:r=>r.value}),
  'reference.list': reference('读取角色、场景或页面参考图', 'read', {}, [], () => ({})),
  'reference.save': reference('导入/替换本地图片、材料或候选为参考图', 'save', { expected_sha256: string('reference.list 的 sha256'), id: string('替换已有参考图时提供'), title: string('图片标题'), file: string('本机 PNG/JPEG/WebP 绝对路径'), material_file: string('已有材料文件名'), candidate_id: string('已有候选 ID'), page_key: pageKey }, ['expected_sha256'], a => ({ expected_sha256:a.expected_sha256, id:a.id, title:a.title, material_file:a.material_file, candidate_id:a.candidate_id, page_key:a.page_key })),
  'reference.delete': reference('删除指定参考图引用', 'delete', { expected_sha256:string('读取时 sha256'), id:string('参考图 ID') }, ['expected_sha256','id'], a=>({expected_sha256:a.expected_sha256,id:a.id})),
  'reference.reorder': reference('调整参考图顺序', 'reorder', { expected_sha256:string('读取时 sha256'), ids:array('全部参考图 ID，不能缺项或重复') }, ['expected_sha256','ids'], a=>({expected_sha256:a.expected_sha256,ids:a.ids})),
  'candidate.list': post('分页读取单张候选与可直接读图的路径', 'page-media', { page_key:pageKey,task_id:string('可选：仅某个生成任务的候选'),...pagination }, {required:['page_key'],freshMedia:true,body:a=>({page_key:a.page_key}),
    transform:(r,a)=>({page_key:a.page_key,...paginate(r.value.media.candidates.filter(c=>!a.task_id||c.task_id===a.task_id).map(({candidate_id,task_id,absolute_file,generated_at})=>({candidate_id,task_id,absolute_file,generated_at})),a)}),
    details:'每个 candidate_id/目录只是一张图，不是一批。task_id 相同才是同次生成。用返回的 absolute_file 读图，不猜路径。按批次查询/清理用 candidate.batches 和 candidate.cleanup.preview/apply。'}),
  'candidate.batches': post('按生成任务分组查询一页候选批次','candidate-batches/read',{page_key:pageKey,...pagination},{required:['page_key'],body:a=>({page_key:a.page_key}),
    transform:(r,a)=>({page_key:a.page_key,candidate_count:r.value.groups.reduce((n,g)=>n+g.available_count,0),...paginate(r.value.groups.map(({candidates,...g})=>g),a)}),
    details:'按任务创建时间新到旧排序。每组是同一 task_id 的候选；available_count 是现存图片数，expected_count 是该任务原计划数，complete 表示已成功完成且图片仍齐全。不能按目录时间把一张图当作一批；不足三张不等于必须补图。candidate.list + task_id 查询图片路径。'}),
  'candidate.cleanup.preview': {
    summary:'预览多页保留整批、清理其他候选的数量',
    parameters:schema({project_id:string('项目 ID'),selections:{type:'array',minItems:1,maxItems:32,items:schema({page_key:pageKey,keep_task_id:string('保留的生成任务；省略为最新任务，须已完成')},['page_key'])}}),
    details:'仅预览，需已有候选清理授权再执行 apply。每页保留指定任务的全部现存图片，删除其他任务的候选，不挑图、不出图。回包展示将保留/删除数量及完整性；若只留一张会明确显示 kept:1，不能当成三张。任一已出候选的任务仍活动时拒绝预览。预览后候选集合变化拒绝该页，重新预览；不把新增图片加入删除。最多32页。',
    async execute(a) {
      const plan=(await requestWorkbench(projectPath(a,'workbench/candidate-batches/preview'),{method:'POST',body:{selections:a.selections}})).value;
      const plan_id=await saveOperationRecord('cleanup',plan);
      return {plan_id,pages:plan.plans.map(p=>({page_key:p.page_key,keep_task_id:p.keep_task_id,kept:p.keep_candidate_ids.length,delete_count:p.delete_candidate_ids.length,expected_count:p.expected_count,complete:p.complete})),
        apply:{operation:'candidate.cleanup.apply',args:{plan_id}}};
    },
  },
  'candidate.cleanup.apply': {
    summary:'执行已核验的候选批量清理预览',parameters:schema({plan_id:string('preview 返回的计划 ID')}),
    details:'只执行该预览冻结的删除集合，保留每页完整指定批次；必须符合用户授权。返回逐页成功/失败和数量。部分失败不重放整批，只重查失败页。预览保存在 Saved，清理 Saved 后需重新预览。不生成、不补图。',
    async execute({plan_id}) {const plan=await readOperationRecord('cleanup',plan_id);return (await requestWorkbench(projectPath(plan,'workbench/candidate-batches/apply'),{method:'POST',body:{plans:plan.plans}})).value;},
  },
  'candidate.counts': endpoint('读取各页面候选数量','GET',a=>projectPath(a,'workbench/candidate-counts'),{}, {project:true}),
  'candidate.inspect': post('查看一个候选的生成详情','candidate-detail',{page_key:pageKey,candidate_id:string('候选 ID')},{body:a=>({page_key:a.page_key,candidate_id:a.candidate_id}),details:'candidate.list 取得真实候选 ID；返回冻结的生成记录。'}),
  'candidate.delete': endpoint('删除指定候选','DELETE',a=>projectPath(a,'workbench/candidates'),{page_key:pageKey,candidate_ids:array('明确授权删除的候选 ID')},{project:true,body:a=>({page_key:a.page_key,candidate_ids:a.candidate_ids}),details:'不可恢复；只删除用户授权的候选，不自动挑选。'}),
  'candidate.scan': post('检查最多八页的候选是否符合当前生成条件','story-candidate-refresh',{page_keys:array('剧情页面身份',pageKey,8)},{body:a=>({action:'inspect',page_keys:a.page_keys})}),
  'candidate.clean': post('清理已确认的候选集合','story-candidate-refresh',{page_key:pageKey,scope:{...string('清理范围'),enum:['mismatch','all']},candidate_ids:array('扫描后确认的候选 ID'),expected_signature:string('mismatch 必须提供 scan 的 signature')},{required:['page_key','scope','candidate_ids'],body:a=>({action:'clean',page_key:a.page_key,scope:a.scope,candidate_ids:a.candidate_ids,expected_signature:a.expected_signature}),details:'仅删除确认集合与当前扫描集合的交集。mismatch 必须携带 expected_signature，变化返回409。'}),
  'generation.page.inspect': post('检查页面最终模型输入与依赖，不运行模型','page-render-inspection',{page_key:pageKey},{body:a=>({page_key:a.page_key})}),
  'generation.rewrite.read': endpoint('读取页面 Prompt 重写结果与进度','GET',a=>projectPath(a,'workbench/page-rewrite'),{page_key:pageKey},{project:true,query:a=>({page_key:JSON.stringify(a.page_key)}),details:'只读取已有结果；启动重写由生成插件提供。'}),
  'lettering.settings.read': endpoint('读取项目文字样式和指纹','GET',a=>projectPath(a,'workbench'),{}, {project:true,transform:r=>({settings:r.value.project.lettering_settings,expected_sha256:r.value.project.lettering_settings_sha256}),details:'返回可编辑 settings 与 expected_sha256；只修改 settings。'}),
  'lettering.settings.save': endpoint('保存项目文字样式','PUT',a=>projectPath(a,'workbench/lettering-settings'),{settings:object('read 返回的完整 settings'),expected_sha256:string('读取时指纹')},{project:true,body:a=>({settings:a.settings,expected_sha256:a.expected_sha256})}),
  'lettering.page.read': endpoint('读取页面文字布局和指纹','GET',a=>projectPath(a,'workbench'),{page_key:pageKey},{project:true,details:'本入口仅用于插画页对白布局；纯文字页正文与排版用 page.editor.read/save section:content。返回 lettering 与整份布局文件的 expected_sha256。items 的字段以读取结果为准；保存仅传 {items}，不把 page 写回。',transform:(r,a)=>{const page=r.value.pages.find(p=>p.page_key.page_id===a.page_key.page_id);if(!page)throw new Error('页面不存在');return {lettering:page.lettering,expected_sha256:page.layout_sha256};}}),
  'lettering.page.save': endpoint('保存一个页面文字布局','PUT',a=>projectPath(a,'workbench/page-lettering'),{page_key:pageKey,lettering:object('仅 {items:[...]}，来自 read，保留每项身份'),expected_sha256:string('读取时布局指纹')},{project:true,body:a=>({page_key:a.page_key,lettering:a.lettering,expected_sha256:a.expected_sha256})}),
  'finished.list': endpoint('分页查看成品状态及全量计数','GET',a=>projectPath(a,'finished'),{page_key:pageKey,...pagination},{project:true,required:[],query:a=>({page_id:a.page_key?.page_id}),
    transform:(r,a)=>({summary:r.value.pages.reduce((v,p)=>(v[p.status]=(v[p.status]??0)+1,v),{total:r.value.pages.length}),...paginate(r.value.pages.map(p=>({page_id:p.page_id,title:p.title,status:p.status,candidate_count:p.candidate_count,...(p.batch_skip_reason?{batch_skip_reason:p.batch_skip_reason}:{})})),a)}),
    details:'默认20条；summary 是筛选范围内全量成品状态计数，不含正文、图片链接和记录详情。单页输出/删除前用 finished.inspect 取 record.sha256 等细节。'}),
  'finished.inspect': endpoint('查看单页成品记录、链接与删除指纹','GET',a=>projectPath(a,'finished'),{page_key:pageKey},{project:true,query:a=>({page_id:a.page_key?.page_id}),transform:r=>r.value,details:'仅返回指定页面完整成品信息；列表用 finished.list。'}),
  'finished.jobs': endpoint('查看成品输出任务','GET',a=>projectPath(a,'finished/jobs'),{}, {project:true}),
  'finished.delete': endpoint('删除一个成品记录','DELETE',a=>projectPath(a,'finished'),{page_key:pageKey,expected_sha256:string('finished.inspect 返回的 record.sha256')},{project:true,body:a=>({page_key:a.page_key,expected_sha256:a.expected_sha256}),details:'删除成品需用户授权，不删除源候选。'}),
  'finished.export': {summary:'导出已有成品 ZIP 或 HTML 阅读页',parameters:schema({...projectId,variant:{...string('导出版本'),enum:['lettered','clean','both']},chapter_id:string('可选章节'),preview:boolean('true 导出HTML，否则ZIP')},['project_id','variant']),details:'只导出已完成的成品，不生成或超分。文件放 Saved/Agent/workbench-artifacts，返回绝对路径。',execute:a=>downloadArtifact(projectPath(a,'finished/export'),{method:'POST',body:{variant:a.variant,chapter_id:a.chapter_id,preview:a.preview},extension:a.preview?'html':'zip'})},
  'media.download': {summary:'将项目媒体下载为本地审阅文件',parameters:schema({...projectId,relative_path:string('工作台媒体返回的项目相对路径，不猜测') }),details:'下载现有图片到 Saved/Agent/workbench-artifacts 后可用 read_image 查看；不改项目文件。',execute:a=>downloadArtifact(projectPath(a,`media/${a.relative_path.split('/').map(encode).join('/')}`))},
};
for(const name of ['page.editor.read','page.editor.save'])mediaActions[name].helpTopics=pageEditHelp;
mediaActions['reference.save'].execute = async a => {
  if ([a.file,a.material_file,a.candidate_id].filter(Boolean).length !== 1) throw new Error('file、material_file、candidate_id 必须且只能提供一项');
  if (a.candidate_id && !a.page_key) throw new Error('候选来源必须提供 page_key');
  return requestWorkbench(projectPath(a,'workbench/reference-library'),{method:'POST',body:{action:'save',target:a.target,expected_sha256:a.expected_sha256,id:a.id,title:a.title,material_file:a.material_file,candidate_id:a.candidate_id,page_key:a.page_key,...(a.file?{content:(await localImage(a.file)).content}:{})}});
};
