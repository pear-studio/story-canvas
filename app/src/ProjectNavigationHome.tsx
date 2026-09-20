import type { ActiveTab } from './workbench-navigation';
export function ProjectNavigationHome({ onOpen }: { onOpen: (tab: ActiveTab) => void }) {
  const groups: { title: string; entries: [ActiveTab, string, string][] }[] = [
    { title: '设置', entries: [['project-settings', '基础设置', '名称、画布与项目基本信息'], ['project-render-profile', '生成设置', '生成模型与默认配置']] },
    { title: '参考材料', entries: [['project-materials', '参考材料', '原文、参考图与创作约定']] },
    { title: '记录', entries: [['project-tasks', '任务历史', '查询以往的生成任务']] },
  ];
  return <section className="utility-page project-navigation-home"><h2>项目</h2>{groups.map(group => <section key={group.title}><h3>{group.title}</h3>{group.entries.map(([tab, title, description]) => <button type="button" key={tab} onClick={() => onOpen(tab)}><span><b>{title}</b><small>{description}</small></span><span aria-hidden="true">›</span></button>)}</section>)}</section>;
}
