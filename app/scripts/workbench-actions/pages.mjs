import { directory, navigationAction as action, id } from './navigation.mjs';
import { pageKey,endpoint,projectPath } from './http-action.mjs';
import { schema, validate, invalid, object } from './contract.mjs';
const owner = { ...schema({owner_kind:{...id('归属类型'),enum:['story','character','scene']},sequence_id:id('story 必填'),character_id:id('character 必填'),scene_id:id('scene 必填'),variant_id:id('character/scene 必填')},['owner_kind']),
  description:'只放归属；before_page_key/after_page_key 放 args 顶层，不放 owner 内',
  examples: [{ owner_kind: 'story', sequence_id: 'unit-1' }, { owner_kind: 'character', character_id: 'alice', variant_id: 'default' }, { owner_kind: 'scene', scene_id: 'station', variant_id: 'default' }] };
const page = { page_key: pageKey };
const position = {before_page_key:{...pageKey,description:'插入此页前，与 after_page_key 二选一；放 args 顶层'},after_page_key:{...pageKey,description:'插入此页后，与 before_page_key 二选一；均省略则追加到归属末尾'}};
function pageAction(...parameters) {
  const definition = action(...parameters);
  const execute = definition.execute;
  return {...definition, execute: async args => {
    if(args.before_page_key && args.after_page_key) throw invalid('before_page_key 与 after_page_key 只能提供一个');
    if(args.owner) {
      const fields=args.owner.owner_kind==='story'?['owner_kind','sequence_id']:['owner_kind',`${args.owner.owner_kind}_id`,'variant_id'];
      validate(schema(Object.fromEntries(fields.map(key=>[key,owner.properties[key]]))),args.owner,'owner.');
    }
    const mapped = {...args};
    for (const name of ['page','before_page','after_page']) {
      if (mapped[name+'_key']) { mapped[name+'_id'] = mapped[name+'_key'].page_id; delete mapped[name+'_key']; }
    }
    const result=await execute(mapped);
    return parameters[1]==='create-page'&&args.page_kind==='collage'?{...result,next:{operation:'page.collage.read',args:{project_id:args.project_id,page_key:result.page_key}},next_hint:'组图页已创建，用 page.collage.sources 选图，read/save 编辑，preview 验证，finished.output 输出。'}:parameters[1]==='create-page'&&!result.edit_error?{...result,next:{operation:'help',target:'prompt.batch.read'},next_hint:'正文已创建；多页汇总 page_id 后用 prompt.batch.read/save，避免逐页重复展开继承。继续改正文用 edit.save；多页正文用 page.editor.batch.read/save。'}:result;
  }};
}
const owners = { page_number:{type:'integer',minimum:1,description:'网页剧情显示页码，1起始；返回稳定 page_id，不能用 offset 换算'}, owner_kind: { ...id('可选归属类型'), enum: ['story', 'character', 'scene'] }, sequence_id: id('可选剧情单元'), character_id: id('可选角色'), scene_id: id('可选场景'), variant_id: id('可选子设定') };
export const pageActions = {
  'page.comic.restore':endpoint('恢复单页，或按阅读顺序拆回独立页','POST',args=>projectPath(args,'workbench/comic/restore'),{page_key:pageKey,expected_sha256:id('page.comic.read 返回的 sha256')},{project:true,body:({project_id,...args})=>args,details:'移除根页分镜布局，将各格恢复为同单元独立页；保留全部 page_id、文案、Prompt、候选和译文。单格误转换可直接恢复。活动生成或成品任务期间拒绝。'}),
  'page.comic.merge.plan':endpoint('预览把同单元独立页合并为分镜页','POST',args=>projectPath(args,'workbench/comic/merge-plan'),{page_key:pageKey,page_keys:{type:'array',items:pageKey,minItems:2,maxItems:12},axis:{type:'string',enum:['x','y']}},{project:true,body:({project_id,...args})=>args,details:'page_keys 第一项必须是 page_key，保留为目录页；x 左右，y 上下；返回 sources 与 sha256。支持单页和单格分镜页；多格页请先 restore。不会生成图片。'}),
  'page.comic.merge':endpoint('按已预览的计划合并独立页','POST',args=>projectPath(args,'workbench/comic/merge'),{page_key:pageKey,page_keys:{type:'array',items:pageKey,minItems:2,maxItems:12},axis:{type:'string',enum:['x','y']},expected_sha256:id('merge.plan 的 sha256')},{project:true,body:({project_id,...args})=>args,details:'保留每页全部文件和身份，第一项为目录根页，其余成为独立分镜；默认零留白、均匀分格。仅有一张候选时自动选用，多候选需 page.comic.save 显式选图。返回 undo：page.comic.restore 可拆回。冲突时重读计划。'}),
  'page.comic.read':endpoint('读取分镜切分树、阅读顺序和逐格选图','POST',args=>projectPath(args,'workbench/comic/read'),{page_key:pageKey},{project:true,body:args=>({page_key:args.page_key}),details:'未转换时 document 为 null；分镜格式见 comic-page.schema.json。返回 sha256 供 save/split 使用。'}),
  'page.comic.convert':endpoint('把单个插画剧情页转换为分镜页','POST',args=>projectPath(args,'workbench/comic/convert'),{page_key:pageKey},{project:true,body:args=>({page_key:args.page_key}),details:'原页面成为第一格，保留正文、Prompt、候选与目录位置；仅支持单页转换。不会生成图片；文字页、动态页和页内分镜不能转换。'}),
  'page.comic.save':endpoint('保存整页分镜布局、裁切和选图','POST',args=>projectPath(args,'workbench/comic/save'),{page_key:pageKey,document:object('comic-page.schema.json 定义的完整文档'),expected_sha256:id('读取时的 sha256')},{project:true,body:({project_id,...args})=>args,details:'不触发生成。必须保留全部分镜；order 管阅读顺序，切分树管几何位置。每格可保留多个候选，但 candidate_id 明确选择用于整页的一张。size_mode:panel 按格子比例冻结生成尺寸，preset 使用现有画幅。409 重读后判断。'}),
  'page.comic.split':endpoint('横向或纵向切分一个分镜并创建空格','POST',args=>projectPath(args,'workbench/comic/split'),{page_key:pageKey,panel_id:id('待切分的分镜 ID'),axis:{type:'string',enum:['x','y'],description:'x 左右切分；y 上下切分'},expected_sha256:id('读取时的 sha256')},{project:true,body:({project_id,...args})=>args,details:'原内容留在第一格，新格为空，继承被切格的模型和生成设置；阅读顺序插入其后。最多12格。切分与新格事实原子保存，不触发生成。逐格 Prompt 与文案沿用 page.editor/prompt 操作，page_key 使用分镜 ID。'}),
  'page.list': directory('分页查询剧情、角色和场景页面目录', 'page', owners),
  'page.templates': directory('查询可用页面模板摘要', 'template', { owner_kind: owners.owner_kind }),
  'page.create': pageAction('创建页面，可同时填写正文、角色引用和对白', 'create-page', {
    content:object('可选初始正文：title、scene_description、characters、dialogue；文字页可用 body、display_title、text_layout。新增对白不填 id；未传字段沿用模板/默认值。'),
    owner, template_id: id('可选模板 ID，先查 page.templates；只在创建时展开一次'),
    page_kind: { ...id('可选：text 文字页，video 动态页，collage 组图页；插画页省略'), enum: ['text','video','collage'] },
    ...position,
    character_id: id('可选：模板引用角色 ID'), variant_id: id('可选：模板引用角色的子设定 ID'),
  }, ['owner'], '先确认分页草案。可用 content 一次创建初始正文（不含 Prompt），新增对白不填 id；返回 edit.document 与 edit.save 可继续编辑，不能跨页复用凭据。多页正文用 page.editor.batch.read/save；正文完成后 prompt.batch.read/save 一次处理最多16页，共享继承来源去重。page_kind:video 创建 H3 动态页；prompt.read/save 编辑 text、duration（3–15秒）、loop、quality（preview/standard）、steps；reference.save 导入一张候选图，generation.run 默认生成一个视频。黑底字幕、时间过渡等纯文字内容使用 page_kind:"text"，无需扩散模型生成背景图。文字页仅限 story 归属且不能使用模板；创建后 page.editor.read section:content 修改 body（正文）、display_title（显示标题）和 text_layout（排版），finished.output 直接制作成品。page_kind:collage 创建自由组图页，用 page.collage.read/sources/save/arrange/preview 编辑与预览；finished.output 无需 candidate_id 直接合成。插画页省略 page_kind。owner 与模板范围必须一致；不要传旧式顶层 sequence_id。'),
  'page.copy': pageAction('复制任意归属页面，保留归属与设置', 'duplicate-page', page, undefined, '副本（含分镜各格）生成新的页面和对白 ID，同步转换嵌字、译文及原文出处引用，保留对白内容与顺序。源页不变；返回后读取副本再编辑，不复用源页对白 ID 或保存凭据。已有页面不会批量重编号。'),
  'page.delete': pageAction('删除任意归属页面并归档', 'delete-page', page, undefined, '有活动生成或成品任务时拒绝删除。'),
  'page.move': pageAction('移动页面到指定归属和位置', 'move-page', { ...page, owner, ...position }, ['page_key', 'owner'], '支持剧情、角色和场景；文字页不能移到角色或场景。移动只改归属和位置，不重写页面正文。'),
};
for(const operation of ['page.create','page.move']) pageActions[operation].example={project_id:'demo',...(operation==='page.move'?{page_key:{page_id:'page-002'}}:{}),owner:{owner_kind:'story',sequence_id:'unit-1'},after_page_key:{page_id:'page-001'}};
