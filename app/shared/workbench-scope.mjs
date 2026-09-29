// 浏览器明确声明当前视图；未打开的编辑内容不参与工作台读取。
export function parseWorkbenchScope(value) {
  const scope = value ?? { kind: 'directory' };
  const fields = { directory: [], page: ['page_id'], setting: ['setting_kind', 'setting_id'], story: ['chapter_id', 'sequence_id'], prompts: [], lettering: [] };
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !Object.hasOwn(fields, scope.kind)
    || Object.keys(scope).some(key => key !== 'kind' && !fields[scope.kind].includes(key))
    || Object.entries(scope).some(([key, value]) => key !== 'kind' && (typeof value !== 'string' || !value))) throw new TypeError('无效工作台读取范围');
  if (scope.kind === 'page' && !/^page-(?:\d{3}|[a-f0-9]{12})$/.test(scope.page_id ?? '')) throw new TypeError('无效页面 ID');
  if (scope.kind === 'setting' && (!['character', 'scene'].includes(scope.setting_kind) || !scope.setting_id)) throw new TypeError('无效设定范围');
  if (scope.kind === 'story' && scope.chapter_id && scope.sequence_id) throw new TypeError('总览只能指定一个范围');
  return scope;
}
