import { Popover } from "./Popover";
import type { ActiveTab } from "./workbench-navigation";
import type { RegisteredProject } from "./ProjectDirectoryDialog";
export type ProjectAction = "copy" | "promote" | "forget" | "delete";

const entries: [ActiveTab, string][] = [
  ["project-settings", "基本信息"],
  ["project-render-profile", "生成设置"],
  ["project-materials", "参考材料"],
  ["project-tasks", "任务历史"],
];

export function ProjectMenu({ activeTab, onOpen, project, busy, onManage }: { activeTab: ActiveTab; onOpen: (tab: ActiveTab) => void; project?: RegisteredProject; busy?: boolean; onManage: (action: ProjectAction) => void }) {
  const current = entries.find(([tab]) => tab === activeTab);
  return <div className="navigation-project-entry">
    <Popover className="project-settings-menu">{close => <>
      <summary className={current ? "is-active" : ""} aria-label="项目选项"><span>项目</span>{current && <small>{current[1]}</small>}</summary>
      <div className="project-settings-menu__options" aria-label="项目选项列表">
        {project?.type !== "training" && entries.map(([tab, label]) => <button type="button" key={tab} disabled={busy} aria-current={activeTab === tab ? "page" : undefined} onClick={() => { close(); onOpen(tab); }}><span>{label}</span>{activeTab === tab && <span aria-hidden="true">✓</span>}</button>)}
        {project && <><hr />{([["copy", "创建临时副本"], ...(project.temporary ? [["promote", "保留为正式项目"]] : []), ["forget", "从列表移除"], ...(project.temporary ? [["delete", "删除临时项目"]] : [])] as [ProjectAction, string][]).map(([action, label]) => <button key={action} type="button" disabled={busy || (!project.available && action !== "forget")} onClick={() => { close(); onManage(action); }}>{label}</button>)}</>}
      </div>
    </>}</Popover>
  </div>;
}
