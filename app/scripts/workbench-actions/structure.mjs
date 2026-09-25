import { directory, navigationAction as action, id } from './navigation.mjs';
const chapter = { chapter_id: id('章节 ID') }, sequence = { sequence_id: id('单元 ID') }, title = { title: id('已确认的标题') };
export const structureActions = {
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
