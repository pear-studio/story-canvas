// 比较实际输出文字，不把片段 ID、继承来源或分类变化当作 Prompt 变化。
export function comparePromptText(before, after, beforeParts = [], afterParts = []) {
  if (before === after) return { kind: 'same', removed: [], added: [] };
  if (before.replace(/\s+/g, ' ').trim() === after.replace(/\s+/g, ' ').trim()) return { kind: 'format', removed: [], added: [] };
  const difference = (left, right) => {
    const remaining = [...right];
    return left.filter(text => {
      const index = remaining.indexOf(text);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
  };
  const oldParts = beforeParts.map(part => part.text), newParts = afterParts.map(part => part.text);
  const removed = difference(oldParts, newParts), added = difference(newParts, oldParts);
  return { kind: oldParts.length && newParts.length && !removed.length && !added.length ? 'order' : 'content', removed, added };
}
