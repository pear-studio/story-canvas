import { directory, navigationAction as action, id } from './navigation.mjs';
import { pageKey } from './http-action.mjs';
import { object } from './contract.mjs';
const owner = { ...object('归属：剧情 {owner_kind:"story",sequence_id}；角色 {owner_kind:"character",character_id,variant_id}；场景 {owner_kind:"scene",scene_id,variant_id}'),
  examples: [{ owner_kind: 'story', sequence_id: 'unit-1' }, { owner_kind: 'character', character_id: 'alice', variant_id: 'default' }, { owner_kind: 'scene', scene_id: 'station', variant_id: 'default' }] };
const page = { page_key: pageKey };
function pageAction(...parameters) {
  const definition = action(...parameters);
  const execute = definition.execute;
  return {...definition, execute: args => {
    const mapped = {...args};
    for (const name of ['page','before_page','after_page']) {
      if (mapped[name+'_key']) { mapped[name+'_id'] = mapped[name+'_key'].page_id; delete mapped[name+'_key']; }
    }
    return execute(mapped);
  }};
}
const owners = { owner_kind: { ...id('可选归属类型'), enum: ['story', 'character', 'scene'] }, sequence_id: id('可选剧情单元'), character_id: id('可选角色'), scene_id: id('可选场景'), variant_id: id('可选子设定') };
export const pageActions = {
  'page.list': directory('分页查询剧情、角色和场景页面目录', 'page', owners),
  'page.templates': directory('查询可用页面模板摘要', 'template', { owner_kind: owners.owner_kind }),
  'page.create': pageAction('创建插画页或纯文字页（字幕、时间过渡）', 'create-page', {
    owner, template_id: id('可选模板 ID，先查 page.templates；只在创建时展开一次'),
    page_kind: { ...id('可选：text 为纯文字剧情页；插画页省略'), enum: ['text'] },
    after_page_key: {...pageKey,description:'可选：同一归属内插在此页后；省略追加'},
    character_id: id('可选：模板引用角色 ID'), variant_id: id('可选：模板引用角色的子设定 ID'),
  }, ['owner'], '先确认分页草案。黑底字幕、时间过渡等纯文字内容使用 page_kind:"text"，无需扩散模型生成背景图。文字页仅限 story 归属且不能使用模板；创建后 page.editor.read section:content 修改 body（正文）、display_title（显示标题）和 text_layout（排版），finished.output 直接制作成品。插画页省略 page_kind。owner 与模板范围必须一致；不要传旧式顶层 sequence_id。'),
  'page.copy': pageAction('复制任意归属页面，保留归属与设置', 'duplicate-page', page),
  'page.delete': pageAction('删除任意归属页面并归档', 'delete-page', page, undefined, '有活动生成或成品任务时拒绝删除。'),
  'page.move': pageAction('移动页面到指定归属和位置', 'move-page', { ...page, owner, before_page_key: {...pageKey,description:'可选：同一目标归属内移到此页前；省略末尾'} }, ['page_key', 'owner'], '支持剧情、角色和场景；文字页不能移到角色或场景。移动只改归属和位置，不重写页面正文。'),
};
