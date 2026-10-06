// 网页显示编号只统计正式剧情顺序，不能从混合页面索引或分页 offset 推算。
export function storyPageNumbers(chapters) {
  return new Map(chapters.flatMap(c => c.sequences.flatMap(s => s.pages)).map((page, index) => [page.page_id, index + 1]));
}
