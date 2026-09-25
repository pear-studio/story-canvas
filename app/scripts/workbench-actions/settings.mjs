import { directory, navigationAction as action, revisionAction, id } from './navigation.mjs';
import { navigation } from '../workbench-client.mjs';
// 两种设定共享稳定契约；按现有服务端能力声明，未支持的动作不伪装成已有能力。
function settingActions(entity, label) {
  const owner = { [`${entity}_id`]: id(`${label} ID`) };
  const variant = { ...owner, variant_id: id('子设定 ID') };
  const changeId = { ...owner, old_id: id('旧子设定 ID'), new_id: id('新子设定 ID') };
  const renameDetails = '修改子设定的稳定 ID，同时迁移 Prompt 与页面引用；修改显示名请用 facts.read/save 的 visual。内部取最新 revision，不自动重试冲突。';
  return {
    [`${entity}.list`]: directory(`分页查询${label} ID 和显示名`, entity),
    [`${entity}.create`]: action(`创建${label}`, `create-${entity}`, { id: id('新 ID：小写字母、数字与连字符'), name: id('显示名') }),
    [`${entity}.delete`]: action(`删除${label}并处理关联内容`, `delete-${entity}`, owner, undefined, '先查关联页面与引用；以服务端检查、归档和回执为准，不自动删除阻碍操作的其他内容。'),
    [`${entity}.variant.list`]: directory(`分页查询${label}子设定`, `${entity}.variant`, owner, Object.keys(owner)),
    [`${entity}.variant.create`]: action(`创建${label}子设定`, `create-${entity}-variant`, { ...owner, id: id('新子设定 ID'), name: id('显示名'), after_variant_id: id('可选：插在此子设定后') }, [...Object.keys(owner), 'id', 'name'], '新增子设定需先讨论，并在用于正式制作前完成验证和用户验收。'),
    [`${entity}.variant.move`]: action(`调整${label}子设定顺序`, `move-${entity}-variant`, { ...variant, before_variant_id: id('可选：移到此子设定前；省略则末尾') }, Object.keys(variant)),
    [`${entity}.variant.delete`]: action(`删除${label}子设定`, `delete-${entity}-variant`, variant, undefined, '关联引用与页面约束由服务端检查；失败后报告阻碍，不连带删除其他内容。'),
    [`${entity}.variant.rename`]: entity === 'character'
      ? revisionAction('修改角色子设定 ID 并迁移引用', 'character-variant-rename', changeId, renameDetails)
      : action('修改场景子设定 ID 并迁移引用', 'rename-scene-variant', changeId, undefined, renameDetails),
  };
}
export const settingActionsCatalog = {
  ...settingActions('character', '角色'), ...settingActions('scene', '场景'),
  'character.move': action('调整角色顺序', 'move-character', { character_id: id('角色 ID'), before_character_id: id('可选：移到此角色前；省略则末尾') }, ['character_id']),
  'scene.move': {
    ...action('调整场景顺序', 'move-scene', { scene_id: id('场景 ID'), before_scene_id: id('可选：移到此场景前；省略则末尾') }, ['scene_id']),
    execute: ({ project_id, scene_id, before_scene_id = null }) => navigation(project_id, 'move-scene', { scene_id, before_scene_id }),
  },
};
