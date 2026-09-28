import { useMemo, useState } from "react";

import { Modal } from "./Modal";
import type { WorkbenchCharacter } from "./project-workbench-client";
import type {
  VisualPageTemplate,
  VisualPageTemplateResource,
  VisualPageTemplateSubject,
  VisualPageTemplateTarget,
} from "./visual-page-templates";

function characterSettings(characters: WorkbenchCharacter[]): VisualPageTemplateSubject[] {
  return characters.flatMap((character) => character.visual.variants.map((variant) => ({
    characterId: character.id,
    variantId: variant.id,
    label: `${character.name} · ${variant.name}`,
  })));
}

function subjectKey(population: VisualPageTemplateSubject) {
  return `${population.characterId}/${population.variantId}`;
}

export function VisualPageTemplateDialog({ resource, target, characters, onClose, onCreate }: {
  resource: VisualPageTemplateResource | null;
  target: VisualPageTemplateTarget;
  characters: WorkbenchCharacter[];
  onClose: () => void;
  onCreate: (template: VisualPageTemplate | null, population: VisualPageTemplateSubject | null) => Promise<boolean>;
}) {
  const templates = resource?.templates.filter((template) => template.applies_to.includes(target.ownerKind)) ?? [];
  const subjects = useMemo(() => characterSettings(characters), [characters]);
  const fixedSubject = target.ownerKind === "character"
    ? subjects.find((population) => population.characterId === target.characterId && population.variantId === target.variantId)
    : null;
  const [selectedTemplateId, setSelectedTemplateId] = useState("blank");
  const [selectedSubjectKey, setSelectedSubjectKey] = useState(() => fixedSubject ? subjectKey(fixedSubject) : subjects.length === 1 ? subjectKey(subjects[0]) : "");
  const [busy, setBusy] = useState(false);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedSubject = fixedSubject ?? subjects.find((population) => subjectKey(population) === selectedSubjectKey) ?? null;
  const unavailableReason = selectedTemplate && (!resource
    ? "正在读取模板资源，请稍候。"
    : resource.errors?.length
      ? resource.errors[0]
      : !selectedSubject
        ? target.ownerKind === "character" ? "当前角色设定已不存在。" : "请选择模板要绑定的主体角色设定。"
        : "");

  async function submit() {
    if (unavailableReason || busy || (selectedTemplate && !selectedSubject)) return;
    setBusy(true);
    try {
      if (await onCreate(selectedTemplate, selectedTemplate ? selectedSubject : null)) onClose();
    } finally {
      setBusy(false);
    }
  }

  return <Modal size="content" title={target.ownerKind === "story" ? "新建剧情页" : target.ownerKind === "scene" ? "新建场景视觉页" : "新建角色视觉页"} subtitle={target.targetLabel} onClose={onClose} busy={busy} className="visual-template-dialog" footer={<><button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>取消</button><button type="button" className="button button--primary" onClick={() => void submit()} disabled={busy || Boolean(unavailableReason) || Boolean(selectedTemplate && !selectedSubject)}>{busy ? "创建中…" : "创建页面"}</button></>}>
    <div className="visual-template-dialog__body">
      <section className="visual-template-dialog__templates">
        <header><b>页面起点</b><span>{selectedTemplate ? resource?.categories.find((category) => category.id === selectedTemplate.category)?.name ?? "视觉页面" : "空白页面"}</span></header>
        <div className="visual-template-dialog__cards"><button type="button" className={!selectedTemplate ? "is-active" : ""} aria-pressed={!selectedTemplate} onClick={() => setSelectedTemplateId("blank")}><b>空白页面</b><small>只建立页面事实，内容和 Prompt 由你继续填写。</small></button>{templates.map((template) => <button type="button" key={template.id} className={template.id === selectedTemplate?.id ? "is-active" : ""} aria-pressed={template.id === selectedTemplate?.id} onClick={() => setSelectedTemplateId(template.id)}><b>{template.name}</b><small>{template.description ?? ""}</small></button>)}</div>
        {resource?.errors?.length && !templates.length ? <div className="visual-template-dialog__empty"><b>模板暂不可用</b><p>{resource.errors[0]}</p></div> : null}
      </section>
      {selectedTemplate && <section className="visual-template-dialog__subject">
        <header><b>主体角色设定</b><span>{target.ownerKind === "character" ? "由当前设定固定" : "模板片段将绑定到该角色"}</span></header>
        {target.ownerKind === "character" ? <div className={`visual-template-dialog__fixed-population ${fixedSubject ? "" : "is-disabled"}`}>{fixedSubject?.label ?? "当前角色设定已不存在"}</div> : subjects.length ? <select aria-label="选择主体角色设定" value={selectedSubjectKey} onChange={(event) => setSelectedSubjectKey(event.target.value)}><option value="">请选择角色设定</option>{subjects.map((population) => <option key={subjectKey(population)} value={subjectKey(population)}>{population.label}</option>)}</select> : <div className="visual-template-dialog__fixed-population is-disabled">当前项目没有角色，无法创建模板页。</div>}
        {unavailableReason && <p className="visual-template-dialog__message" role="alert">{unavailableReason}</p>}
        <p className="visual-template-dialog__note">模板只负责建立普通页面事实；创建后仍可继续编辑页面内容与 Prompt。</p>
      </section>}
    </div>
  </Modal>;
}
