import { requestWorkbench } from '../workbench-client.mjs';
import { schema, string, object, array, boolean } from './contract.mjs';
import { endpoint, projectId, pageKey, projectPath, encode, localImage, downloadArtifact } from './http-action.mjs';
const post = (summary, suffix, fields, options = {}) => endpoint(summary, 'POST', a => projectPath(a, `workbench/${suffix}`), fields, { project: true, ...options });
const target = { ...schema({ kind: { ...string('归属'), enum: ['character','scene','page'] }, id: string('角色/场景/页面 ID'), variant_id: string('角色和场景需要子设定 ID'), model_id: string('模型分支，默认 qwen') }, ['kind','id']), description: '参考图归属；角色和场景必须给 variant_id' };
const reference = (summary, action, fields, required, body) => post(summary, 'reference-library', { target, ...fields }, { required: ['target', ...required], details: '先 reference.list 取得 entries 与 sha256；修改传 expected_sha256。参考图最多十张，候选提升后保存到 materials，不依赖临时输出。', body: a => ({ target:a.target, action, ...body(a) }) });
export const mediaActions = {
  'page.render.read': endpoint('读取单页模型、画幅及可选值','POST','/api/agent/page-render/read',{page_key:pageKey},
    {project:true,body:a=>a,transform:r=>r.value,details:'返回该页完整 render 文件、模型/画幅选项及 page.render.set 保存参数。只影响当前页；项目默认设置用于新页。无需读取组装后的 Prompt。'}),
  'page.render.set': endpoint('独立设置单页模型或画幅','POST','/api/agent/page-render/set',{
    page_key:pageKey,expected_sha256:string('page.render.read 返回的版本'),model_id:string('可选模型 ID，见 read.options.models'),
    canvas:string('可选画幅，见 read.options.canvases'),profile_id:string('可选显式生成配置；通常省略'),
  },{project:true,required:['page_key','expected_sha256'],body:a=>a,transform:r=>r.value,
    recover:(error,a)=>({message:error.status===409?'页面设置或 Prompt 已变化；重读并判断，不直接换指纹覆盖。':'重读当前设置和选项；核对模型与配置是否匹配、画幅是否受支持。',next:{operation:'page.render.read',args:{project_id:a.project_id,page_key:a.page_key}}}),
    details:'先 page.render.read 核验，再带 save.args 和要改的 model_id、canvas 或 profile_id，至少一项。仅改画幅保留模型和配置；切换模型时省略 profile_id 自动配对该模型默认配置，未提供字段保留。配置必须匹配模型并支持画幅。保留已有各模型 Prompt；首次切换按模型规则初始化缺失分支（Anima 转 Qwen 会导入有效文本），之后可用 page.editor.read 核验。只保存，不加载模型、不出图，不改其他页或项目默认值。409 重读判断，不能直接换新指纹覆盖。'}),
  'page.editor.read': endpoint('读取相关页面文件全文，不展开引用','POST','/api/agent/page-editor',{
    page_key:pageKey,section:{type:'string',enum:['prompt','content','render'],description:'默认 prompt；content 是页面标题、画面和对白；render 是模型与画幅'},
  },{project:true,required:['page_key'],body:a=>a,details:'只返回所选文件的完整 document 和 save，不加载组装后的 Prompt。核验该文件后按 save.args 提交 changes；只发修改字段，无需抄回全文。引用展开或最终输入仅在需要时另查 prompt.context。布局使用 lettering.page.read/save。',transform:r=>r.value}),
  'page.editor.save': endpoint('局部修改页面文件，保留未涉及字段','POST','/api/agent/page-editor/save',{
    page_key:pageKey,section:{type:'string',enum:['prompt','content','render'],description:'读取回执中的 section'},
    expected_sha256:string('读取回执中的版本；页面或上游变化时409，必须重读判断'),changes:object('仅修改字段；对象递归合并，数组整项替换，null删除键'),
  },{project:true,body:a=>a,recover:(error,a)=>({message:error.status===409?'相关文件或上游已变化；重新核验后再决定修改，不直接换指纹覆盖。':'重读本次相关文件核实结果，按该文件格式修改。',next:{operation:'page.editor.read',args:{project_id:a.project_id,page_key:a.page_key,section:a.section}}}),details:'使用 page.editor.read 返回的 save.args，加 changes。对象递归合并；数组整项替换，空数组清空；null 删除对应键以恢复继承，不表示写入空值。保留已有词条 id，新增词条省略 id。成功返回完整更新文件用于核验及新的 save；失败不自动重试，未涉及模型分支保持原样；改变角色引用时沿用领域规则清理失效引用。例：content 的 changes:{title:"新标题"}；Prompt 按读取文件的 models 结构填写 changes。单独设置模型和画幅优先 page.render.read/set。',transform:r=>r.value}),
  'reference.list': reference('读取角色、场景或页面参考图', 'read', {}, [], () => ({})),
  'reference.save': reference('导入/替换本地图片、材料或候选为参考图', 'save', { expected_sha256: string('reference.list 的 sha256'), id: string('替换已有参考图时提供'), title: string('图片标题'), file: string('本机 PNG/JPEG/WebP 绝对路径'), material_file: string('已有材料文件名'), candidate_id: string('已有候选 ID'), page_key: pageKey }, ['expected_sha256'], a => ({ expected_sha256:a.expected_sha256, id:a.id, title:a.title, material_file:a.material_file, candidate_id:a.candidate_id, page_key:a.page_key })),
  'reference.delete': reference('删除指定参考图引用', 'delete', { expected_sha256:string('读取时 sha256'), id:string('参考图 ID') }, ['expected_sha256','id'], a=>({expected_sha256:a.expected_sha256,id:a.id})),
  'reference.reorder': reference('调整参考图顺序', 'reorder', { expected_sha256:string('读取时 sha256'), ids:array('全部参考图 ID，不能缺项或重复') }, ['expected_sha256','ids'], a=>({expected_sha256:a.expected_sha256,ids:a.ids})),
  'candidate.list': post('读取一个页面候选与媒体', 'page-media', { page_key:pageKey }, { body:a=>({page_key:a.page_key}), details:'返回页面媒体与候选 ID；只读，不生成、不选优。' }),
  'candidate.counts': endpoint('读取各页面候选数量','GET',a=>projectPath(a,'workbench/candidate-counts'),{}, {project:true}),
  'candidate.inspect': post('查看一个候选的生成详情','candidate-detail',{page_key:pageKey,candidate_id:string('候选 ID')},{body:a=>({page_key:a.page_key,candidate_id:a.candidate_id}),details:'candidate.list 取得真实候选 ID；返回冻结的生成记录。'}),
  'candidate.delete': endpoint('删除指定候选','DELETE',a=>projectPath(a,'workbench/candidates'),{page_key:pageKey,candidate_ids:array('明确授权删除的候选 ID')},{project:true,body:a=>({page_key:a.page_key,candidate_ids:a.candidate_ids}),details:'不可恢复；只删除用户授权的候选，不自动挑选。'}),
  'candidate.scan': post('检查最多八页的候选是否符合当前生成条件','story-candidate-refresh',{page_keys:array('剧情页面身份',pageKey,8)},{body:a=>({action:'inspect',page_keys:a.page_keys})}),
  'candidate.clean': post('清理已确认的候选集合','story-candidate-refresh',{page_key:pageKey,scope:{...string('清理范围'),enum:['mismatch','all']},candidate_ids:array('扫描后确认的候选 ID'),expected_signature:string('mismatch 必须提供 scan 的 signature')},{required:['page_key','scope','candidate_ids'],body:a=>({action:'clean',page_key:a.page_key,scope:a.scope,candidate_ids:a.candidate_ids,expected_signature:a.expected_signature}),details:'仅删除确认集合与当前扫描集合的交集。mismatch 必须携带 expected_signature，变化返回409。'}),
  'generation.page.inspect': post('检查页面最终模型输入与依赖，不运行模型','page-render-inspection',{page_key:pageKey},{body:a=>({page_key:a.page_key})}),
  'generation.rewrite.read': endpoint('读取页面 Prompt 重写结果与进度','GET',a=>projectPath(a,'workbench/page-rewrite'),{page_key:pageKey},{project:true,query:a=>({page_key:JSON.stringify(a.page_key)}),details:'只读取已有结果；启动重写由生成插件提供。'}),
  'lettering.settings.read': endpoint('读取项目文字样式和指纹','GET',a=>projectPath(a,'workbench'),{}, {project:true,transform:r=>({settings:r.value.project.lettering_settings,expected_sha256:r.value.project.lettering_settings_sha256}),details:'返回可编辑 settings 与 expected_sha256；只修改 settings。'}),
  'lettering.settings.save': endpoint('保存项目文字样式','PUT',a=>projectPath(a,'workbench/lettering-settings'),{settings:object('read 返回的完整 settings'),expected_sha256:string('读取时指纹')},{project:true,body:a=>({settings:a.settings,expected_sha256:a.expected_sha256})}),
  'lettering.page.read': endpoint('读取页面文字布局和指纹','GET',a=>projectPath(a,'workbench'),{page_key:pageKey},{project:true,details:'返回 lettering 与整份布局文件的 expected_sha256。items 的字段以读取结果为准；保存仅传 {items}，不把 page 写回。',transform:(r,a)=>{const page=r.value.pages.find(p=>p.page_key.page_id===a.page_key.page_id);if(!page)throw new Error('页面不存在');return {lettering:page.lettering,expected_sha256:page.layout_sha256};}}),
  'lettering.page.save': endpoint('保存一个页面文字布局','PUT',a=>projectPath(a,'workbench/page-lettering'),{page_key:pageKey,lettering:object('仅 {items:[...]}，来自 read，保留每项身份'),expected_sha256:string('读取时布局指纹')},{project:true,body:a=>({page_key:a.page_key,lettering:a.lettering,expected_sha256:a.expected_sha256})}),
  'finished.list': endpoint('查看成品和当前状态','GET',a=>projectPath(a,'finished'),{page_id:string('可选页面筛选')},{project:true,required:[],query:a=>({page_id:a.page_id})}),
  'finished.jobs': endpoint('查看成品输出任务','GET',a=>projectPath(a,'finished/jobs'),{}, {project:true}),
  'finished.delete': endpoint('删除一个成品记录','DELETE',a=>projectPath(a,'finished'),{page_key:pageKey,expected_sha256:string('finished.list 返回的 record.sha256')},{project:true,body:a=>({page_key:a.page_key,expected_sha256:a.expected_sha256}),details:'删除成品需用户授权，不删除源候选。'}),
  'finished.export': {summary:'导出已有成品 ZIP 或 HTML 阅读页',parameters:schema({...projectId,variant:{...string('导出版本'),enum:['lettered','clean','both']},chapter_id:string('可选章节'),preview:boolean('true 导出HTML，否则ZIP')},['project_id','variant']),details:'只导出已完成的成品，不生成或超分。文件放 Saved/Agent/workbench-artifacts，返回绝对路径。',execute:a=>downloadArtifact(projectPath(a,'finished/export'),{method:'POST',body:{variant:a.variant,chapter_id:a.chapter_id,preview:a.preview},extension:a.preview?'html':'zip'})},
  'media.download': {summary:'将项目媒体下载为本地审阅文件',parameters:schema({...projectId,relative_path:string('工作台媒体返回的项目相对路径，不猜测') }),details:'下载现有图片到 Saved/Agent/workbench-artifacts 后可用 read_image 查看；不改项目文件。',execute:a=>downloadArtifact(projectPath(a,`media/${a.relative_path.split('/').map(encode).join('/')}`))},
};
mediaActions['reference.save'].execute = async a => {
  if ([a.file,a.material_file,a.candidate_id].filter(Boolean).length !== 1) throw new Error('file、material_file、candidate_id 必须且只能提供一项');
  if (a.candidate_id && !a.page_key) throw new Error('候选来源必须提供 page_key');
  return requestWorkbench(projectPath(a,'workbench/reference-library'),{method:'POST',body:{action:'save',target:a.target,expected_sha256:a.expected_sha256,id:a.id,title:a.title,material_file:a.material_file,candidate_id:a.candidate_id,page_key:a.page_key,...(a.file?{content:(await localImage(a.file)).content}:{})}});
};
