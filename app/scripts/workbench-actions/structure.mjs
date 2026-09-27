import { directory, navigationAction as action, id } from './navigation.mjs';
import { readFactDraft, saveFactDraft } from '../workbench-client.mjs';
import { schema, string, textValue } from './contract.mjs';
const chapter = { chapter_id: id('章节 ID') }, sequence = { sequence_id: id('单元 ID') }, title = { title: id('已确认的标题') };
// 语义入口复用事实草稿及其并发校验，不另设梗概保存实现。
function outlineEditor(kind, label) {
  const prefix = kind === 'synopsis' ? 'story.synopsis' : kind;
  const target = kind === 'synopsis' ? {} : { [`${kind}_id`]: string(`${label} ID`) };
  const identity = { project_id: string('项目 ID'), ...target };
  const document = kind === 'synopsis' ? { synopsis: textValue('完整故事梗概') }
    : { title: string('标题'), summary: textValue('完整梗概') };
  return {
    [`${prefix}.read`]: {
      summary: `读取${label}正文与保存凭据`, parameters: schema(identity),
      details: '只读取此目标，不展开全故事；返回 document 和 save。编辑 document 后按 save.args 保存，不需要 facts 或文件写工具。',
      execute: async args => {
        const draft = await readFactDraft('story', kind, args.project_id, args[`${kind}_id`]);
        return { document: draft.document, save: { operation: `${prefix}.save`, args: {
          ...args, expected_sha256: draft.expected_sha256, expected_context_sha256: draft.expected_context_sha256,
        }, document_parameter: 'document' } };
      },
    },
    [`${prefix}.save`]: {
      summary: kind === 'synopsis' ? '保存故事梗概' : `保存${label}标题与梗概`,
      parameters: schema({ ...identity, expected_sha256: string('读取返回的目标指纹'), expected_context_sha256: string('读取返回的上游指纹'), document: schema(document) }),
      details: '使用 read 返回的 save.args，加完整 document；只修改当前梗概或标题，保留其他章节、单元和页面顺序。冲突先重读判断，不替换指纹强行覆盖。成功回执 value 是已保存正文。',
      execute: args => saveFactDraft('story', kind, { project_id: args.project_id,
        ...(kind === 'synopsis' ? {} : { target_id: args[`${kind}_id`] }), document: args.document,
        expected_sha256: args.expected_sha256, expected_context_sha256: args.expected_context_sha256 }),
    },
  };
}
export const structureActions = {
  ...outlineEditor('synopsis', '故事梗概'),
  ...outlineEditor('chapter', '章节'),
  ...outlineEditor('sequence', '单元'),
  'chapter.list': directory('分页查询章节和单元数量', 'chapter'),
  'chapter.create': action('创建章节', 'create-chapter', { ...title, after_chapter_id: id('可选：插在此章节后；省略则追加') }, ['title']),
  'chapter.rename': action('修改章节标题', 'rename-chapter', { ...chapter, ...title }),
  'chapter.move': action('调整章节顺序', 'move-chapter', { ...chapter, before_chapter_id: id('可选：移到此章节前；省略则末尾') }, ['chapter_id']),
  'chapter.delete': action('删除空章节', 'delete-chapter', chapter, undefined, '章节必须没有单元，且至少保留一个章节。'),
  'sequence.list': directory('分页查询单元及所属章节', 'sequence', chapter),
  'sequence.create': action('在章节内创建单元', 'create-sequence', { ...chapter, ...title, after_sequence_id: id('可选：插在此单元后；省略则追加') }, ['chapter_id', 'title']),
  'sequence.rename': action('修改单元标题', 'rename-sequence', { ...sequence, ...title }),
  'sequence.move': action('移动单元到章节内指定位置', 'move-sequence', { ...sequence, ...chapter, before_sequence_id: id('可选：插在此单元前；省略则追加') }, ['sequence_id', 'chapter_id']),
  'sequence.delete': action('删除空单元', 'delete-sequence', sequence, undefined, '单元必须没有剧情页面。'),
};
