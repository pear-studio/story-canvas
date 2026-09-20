import { ProjectGitStatus } from "./ProjectGitStatus";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { responseJson } from "./api-response";
import { useFeedback } from "./feedback";
import { darkenDisplayColor, defaultCharacterDisplayColor, letteringLogicalCanvasWidth, letteringTypographyVariables, lightenDisplayColor, neutralLetteringColor, type LetteringDirection, type LetteringKind, type LetteringPreset, type LetteringSettings, type LetteringStyle } from "./lettering";
import { Modal } from "./Modal";
import { mutateFacts, readFacts } from "./project-write-client";
import { useProjectSnapshotReader } from "./use-project-snapshot-reader";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { HeartLettering, DiceIcon, resolveHeart, useHeartFont } from "./HeartLettering";
// @ts-expect-error 与服务端共用的默认爱心参数。
import { heartDefaults } from "../shared/heart-lettering.mjs";

export type ProjectSettings = {
  id: string;
  title: string;
  canvas: string | null;
  default_render_profile: string;
};

type CreativeAgreementItem = { id: string; text: string; strength: "hard" | "preference" };
type ProjectMaterial = { file: string; title: string; available: boolean; kind: "text" | "image" | "file"; size_bytes: number | null; text: string | null; url: string | null };
type ProjectMaterials = {
  agreement: { items: CreativeAgreementItem[] };
  materials: ProjectMaterial[];
};

export function UtilityPage({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="utility-page"><WorkspaceHeader title={title} description={description} actions={actions} />{children}</section>;
}

function recordId(prefix: string) {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function readableBytes(value: number | null) {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export function LetteringSample({ text, color, style, preset, canvasWidth }: { text: string; color: string; style: LetteringStyle; preset: LetteringPreset; canvasWidth?: number | null }) {
  const scale = (canvasWidth ?? 0) / letteringLogicalCanvasWidth;
  return <span className="lettering-sample" style={{ "--lettering-color": preset.kind === "caption" ? lightenDisplayColor(color) : color, visibility: canvasWidth && canvasWidth > 0 ? undefined : "hidden", ...letteringTypographyVariables(style, scale) } as CSSProperties}>
    <span className={`lettering-sample__frame lettering-object--${preset.kind} lettering-object--${preset.direction}`}><span className="lettering-text">{text}</span></span>
  </span>;
}

function NarrationSample({ style, canvasWidth }: { style: LetteringStyle; canvasWidth?: number | null }) {
  const scale = (canvasWidth ?? 0) / letteringLogicalCanvasWidth;
  return <article aria-label="旁白样式预览">
    <div className="lettering-style-preset-controls"><b>旁白</b><span>固定底部字幕条 · 每页一条 · 100 字以内</span></div>
    <div className="lettering-style-preview">{canvasWidth && canvasWidth > 0
      ? <span className="narration-sample" style={letteringTypographyVariables(style, scale) as CSSProperties}><span className="narration-bar"><span className="narration-bar__text">晨雾越过屋檐，漫进长街。</span></span></span>
      : null}</div>
  </article>;
}

export function ProjectSettingsView({ projectId, project, busy, onSave, directory }: {
  projectId: string;
  project: ProjectSettings;
  busy: boolean;
  onSave: (settings: ProjectSettings) => Promise<void>;
  directory?: string;
}) {
  const [titleDraft, setTitleDraft] = useState(project.title);
  useEffect(() => setTitleDraft(project.title), [projectId, project.title]);
  const dirty = titleDraft !== project.title;
  return <UtilityPage title="基本信息" description="项目名称与目录">
    <section className="settings-card" data-project-fact-dirty={dirty ? "true" : undefined}><div className="settings-grid">
      <label><span>项目名称</span><input value={titleDraft} disabled={busy} onChange={(event) => setTitleDraft(event.target.value)} /></label>
      <label className="settings-readonly"><span>项目 ID</span><input value={projectId} readOnly /></label>
      <label className="settings-readonly"><span>项目目录</span><input value={directory ?? "正在读取登记路径…"} readOnly /></label>
    </div><footer><button className="button button--primary" type="button" disabled={busy || !dirty || !titleDraft.trim()} onClick={() => void onSave({ ...project, title: titleDraft })}>{busy ? "正在保存…" : "保存基础设置"}</button>{dirty && <span>有未保存修改</span>}</footer></section>
    {directory && <section className="settings-card"><ProjectGitStatus id={projectId} path={directory} /></section>}
  </UtilityPage>;
}

export function ProjectLetteringSettingsView({ projectId, settings, settingsSha256, characters, previewCanvasWidth, busy, onSave }: {
  projectId: string;
  settings: LetteringSettings;
  settingsSha256: string;
  characters: Array<{ id: string; name: string }>;
  previewCanvasWidth?: number | null;
  busy: boolean;
  onSave: (settings: LetteringSettings, expectedSha256: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [fontSizeDraft, setFontSizeDraft] = useState(String(settings.font_size));
  const [selectedCharacterId, setSelectedCharacterId] = useState(characters[0]?.id ?? "");
  useEffect(() => {
    setDraft(settings);
    setFontSizeDraft(String(settings.font_size));
  }, [projectId, JSON.stringify(settings)]);
  useEffect(() => {
    setSelectedCharacterId((current) => characters.some((character) => character.id === current) ? current : characters[0]?.id ?? "");
  }, [projectId, JSON.stringify(characters.map((character) => character.id))]);
  const selectedColorDraft = draft.character_colors[selectedCharacterId] ?? defaultCharacterDisplayColor;
  const selectedPreviewColor = /^#[0-9A-Fa-f]{6}$/.test(selectedColorDraft) ? selectedColorDraft : defaultCharacterDisplayColor;
  const presets: Array<{ key: "character_speech" | "character_thought" | "npc_speech"; label: string; text: string; color: string }> = [
    { key: "character_speech", label: "角色对白", text: "我们走吧，天快亮了。", color: darkenDisplayColor(selectedPreviewColor) },
    { key: "character_thought", label: "角色心理", text: "奇怪……这里安静得过分。", color: darkenDisplayColor(selectedPreviewColor) },
    { key: "npc_speech", label: "NPC 对白", text: "前面的路，今天不能走。", color: neutralLetteringColor },
  ];
  const parsedFontSize = Number(fontSizeDraft);
  const fontSizeValid = fontSizeDraft.trim() !== "" && Number.isInteger(parsedFontSize) && parsedFontSize >= 12 && parsedFontSize <= 96;
  const colorsValid = Object.values(draft.character_colors).every((color) => /^#[0-9A-Fa-f]{6}$/.test(color));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  function patchStyle(patch: Partial<LetteringStyle>) { setDraft((current) => ({ ...current, ...patch })); }
  function updateCharacterColor(characterId: string, color: string) {
    setSelectedCharacterId(characterId);
    setDraft((current) => ({ ...current, character_colors: { ...current.character_colors, [characterId]: color.toUpperCase() } }));
  }
  function resetCharacterColor(characterId: string) {
    setSelectedCharacterId(characterId);
    setDraft((current) => {
      const characterColors = { ...current.character_colors };
      delete characterColors[characterId];
      return { ...current, character_colors: characterColors };
    });
  }
  function updateFontSize(value: string) {
    setFontSizeDraft(value);
    const parsed = Number(value);
    if (value.trim() && Number.isInteger(parsed) && parsed >= 12 && parsed <= 96) patchStyle({ font_size: parsed });
  }
  const saveDisabled = busy || !dirty || !fontSizeValid || !colorsValid;
  return <UtilityPage title="嵌字设置" description="项目文案的排版与角色颜色" actions={<button className="button button--primary" type="button" disabled={saveDisabled} onClick={() => void onSave({ ...draft, character_colors: Object.fromEntries(Object.entries(draft.character_colors).map(([id, color]) => [id, color.toUpperCase()])) }, settingsSha256)}>{busy ? "正在保存…" : "保存"}</button>}>
    <section className="settings-card" data-project-fact-dirty={dirty ? "true" : undefined}><section className="lettering-style-settings lettering-style-settings--standalone">
      <div className="lettering-style-main"><label><span>字体</span><select value={draft.font_family} disabled={busy} onChange={(event) => patchStyle({ font_family: event.target.value })}><option value="LXGW WenKai">霞鹜文楷</option><option value="Microsoft YaHei">微软雅黑</option><option value="SimHei">黑体</option><option value="Noto Sans CJK SC">Noto Sans CJK</option><option value="PingFang SC">苹方</option></select></label><label><span>字号</span><input type="number" min="12" max="96" step="1" value={fontSizeDraft} disabled={busy} aria-invalid={!fontSizeValid} onChange={(event) => updateFontSize(event.target.value)} onBlur={() => { if (!fontSizeValid) setFontSizeDraft(String(draft.font_size)); }} /></label></div>
      <div className="lettering-style-presets">{presets.map((row) => { const preset = draft[row.key]; const update = (patch: Partial<LetteringPreset>) => patchStyle({ [row.key]: { ...preset, ...patch } } as Partial<LetteringStyle>); return <article key={row.key}><div className="lettering-style-preset-controls"><b>{row.label}</b><label><span>方向</span><select value={preset.direction} disabled={busy} onChange={(event) => update({ direction: event.target.value as LetteringDirection })}><option value="horizontal">横排</option><option value="vertical">竖排</option></select></label><label><span>框</span><select value={preset.kind} disabled={busy} onChange={(event) => update({ kind: event.target.value as LetteringKind })}><option value="plain">无框</option><option value="balloon">对话框</option><option value="caption">叙述框</option><option value="float">浮字</option></select></label></div><div className="lettering-style-preview"><LetteringSample text={row.text} color={row.color} style={draft} preset={preset} canvasWidth={previewCanvasWidth} /></div></article>; })}<HeartLetteringSample style={draft} canvasWidth={previewCanvasWidth} /><NarrationSample style={draft} canvasWidth={previewCanvasWidth} /></div>
      {characters.length > 0 && <section className="lettering-character-colors"><header><h3>角色颜色</h3></header><div className="lettering-character-color-list">{characters.map((character) => {
        const custom = Object.hasOwn(draft.character_colors, character.id);
        const color = draft.character_colors[character.id] ?? defaultCharacterDisplayColor;
        const valid = /^#[0-9A-Fa-f]{6}$/.test(color);
        const selected = character.id === selectedCharacterId;
        return <article key={character.id} className={selected ? "is-selected" : ""} role="button" tabIndex={0} aria-pressed={selected} onClick={() => setSelectedCharacterId(character.id)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelectedCharacterId(character.id); } }}>
          <strong><i style={{ backgroundColor: valid ? color : defaultCharacterDisplayColor }} />{character.name}</strong>
          <div className="lettering-character-color-controls"><input type="color" aria-label={`${character.name}颜色`} value={valid ? color : defaultCharacterDisplayColor} disabled={busy} onFocus={() => setSelectedCharacterId(character.id)} onChange={(event) => updateCharacterColor(character.id, event.target.value)} /><input className={`mono-input ${valid ? "" : "is-missing"}`.trim()} aria-label={`${character.name}颜色值`} value={color} disabled={busy} onFocus={() => setSelectedCharacterId(character.id)} onChange={(event) => updateCharacterColor(character.id, event.target.value)} /><button type="button" className="button button--quiet" disabled={busy || !custom} onClick={() => resetCharacterColor(character.id)}>恢复默认</button></div>
        </article>;
      })}</div></section>}
    </section></section>
  </UtilityPage>;
}

function HeartLetteringSample({ style, canvasWidth }: { style: LetteringStyle; canvasWidth?: number | null }) {
  const ready = useHeartFont();
  const [seed, setSeed] = useState(703);
  const text = "呜呜呜～";
  const heartDefaultsForPreview = heartDefaults("heart-preview", style.font_size);
  const layout = ready ? resolveHeart(text, { dialogue_id: "heart-preview", box: { x: 0, y: 0, w: .4, h: .1 }, heart: { ...heartDefaultsForPreview, seed } }, { width: letteringLogicalCanvasWidth, height: letteringLogicalCanvasWidth }) : null;
  return <article aria-label="爱心样式预览">
    <div className="lettering-style-preset-controls heart-preview-controls"><b>爱心</b><span>志莽行 · 粉色 · 默认 {heartDefaultsForPreview.font_size}</span><button type="button" title="重新排列" aria-label="重新排列预览爱心" onClick={() => setSeed(current => (current + 1) >>> 0)}><DiceIcon /></button></div>
    <div className="lettering-style-preview">{layout && canvasWidth && canvasWidth > 0 ? <span style={{ display: "block", width: layout.box.w * canvasWidth, height: layout.box.h * canvasWidth, flexShrink: 0 }}><HeartLettering text={text} layout={layout} /></span> : null}</div>
    <p className="heart-preview-note">每条爱心文案可独立调整字号与旋转，不受上方普通文字设置影响。</p>
  </article>;
}

export function ProjectMaterialsView({ projectId }: { projectId: string }) {
  const { confirm, notify } = useFeedback();
  const [data, setData] = useState<ProjectMaterials | null>(null);
  const [selectedFile, setSelectedFile] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const [newTextDraft, setNewTextDraft] = useState<{ file: string; title: string } | null>(null);
  const [agreementEditor, setAgreementEditor] = useState<CreativeAgreementItem | null>(null);
  const [saving, setSaving] = useState(false);
  const loadGeneration = useRef(0);
  useProjectSnapshotReader(projectId, async (read) => {
    const next = await read<ProjectMaterials>(`/api/projects/${encodeURIComponent(projectId)}/materials`);
    return () => {
      loadGeneration.current += 1;
      setData(next);
      setSelectedFile((current) => next.materials.some((item) => item.file === current) ? current : "");
    };
  });
  async function refresh() {
    const generation = ++loadGeneration.current;
    const next = await responseJson<ProjectMaterials>(await readFacts(`/api/projects/${encodeURIComponent(projectId)}/materials`, { headers: { accept: "application/json" } }));
    if (generation !== loadGeneration.current) return next;
    setData(next); setSelectedFile((current) => next.materials.some((item) => item.file === current) ? current : "");
    return next;
  }
  useEffect(() => { setData(null); setSelectedFile(""); setNewTextDraft(null); setAgreementEditor(null); void refresh().catch((error) => notify({ kind: "error", message: `参考材料读取失败：${error instanceof Error ? error.message : String(error)}` })); }, [projectId]);
  const selected = data?.materials.find((item) => item.file === selectedFile) ?? null;
  const materials = data?.materials ?? [];
  const materialDirty = !!selected && (titleDraft !== selected.title || (selected.kind === "text" && selected.text !== null && textDraft !== selected.text));
  const storedAgreement = agreementEditor && data ? data.agreement.items.find((item) => item.id === agreementEditor.id) ?? null : null;
  const agreementDirty = !!agreementEditor && (storedAgreement ? storedAgreement.text !== agreementEditor.text || storedAgreement.strength !== agreementEditor.strength : !!agreementEditor.text.trim() || agreementEditor.strength !== "preference");
  const orderedAgreements = data ? [...data.agreement.items].sort((left, right) => Number(left.strength === "preference") - Number(right.strength === "preference")) : [];
  useEffect(() => { setTitleDraft(selected?.title ?? ""); setTextDraft(selected?.text ?? ""); }, [selected?.file, selected?.title, selected?.text]);
  async function confirmDiscardCurrentMaterial() {
    return !materialDirty || confirm({ kind: "warning", title: "放弃未保存修改", message: `materials/${selected?.file} 尚未保存，关闭后会放弃这些修改。是否继续？`, danger: true });
  }
  async function requestSelectMaterial(file: string) {
    if (file === selectedFile) return;
    if (!await confirmDiscardCurrentMaterial()) return;
    setSelectedFile(file);
  }
  async function requestCloseMaterial() {
    if (!await confirmDiscardCurrentMaterial()) return;
    setSelectedFile("");
  }
  async function requestCloseNewText() {
    const dirty = !!newTextDraft && (newTextDraft.file !== "notes.md" || newTextDraft.title !== "notes");
    if (dirty && !await confirm({ kind: "warning", title: "放弃新建材料", message: "尚未创建这个文本材料，关闭后会放弃已填写的内容。是否继续？", danger: true })) return;
    setNewTextDraft(null);
  }
  async function requestCloseAgreementEditor() {
    if (agreementDirty && !await confirm({ kind: "warning", title: "放弃未保存修改", message: "这条创作约定尚未保存，关闭后会放弃修改。是否继续？", danger: true })) return;
    setAgreementEditor(null);
  }
  async function run(label: string, operation: () => Promise<void>) { if (saving) return; setSaving(true); try { await operation(); } catch (error) { notify({ kind: "error", message: `${label}失败：${error instanceof Error ? error.message : String(error)}` }); } finally { setSaving(false); } }
  async function writeAgreement(items: CreativeAgreementItem[]) { const result = await responseJson<{ agreement: ProjectMaterials["agreement"] }>(await mutateFacts(`/api/projects/${encodeURIComponent(projectId)}/creative-agreement`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) })); setData((current) => current ? { ...current, agreement: result.agreement } : current); }
  async function createTextMaterial() { if (!newTextDraft) return; const file = newTextDraft.file.trim(); const title = newTextDraft.title.trim(); if (!file || !title) return; const exists = materials.some((item) => item.file === file); if (exists && !await confirm({ kind: "warning", title: "覆盖同名材料", message: `materials/${file} 已存在，将清空并覆盖，是否继续？`, danger: true })) return; await run("添加材料", async () => { await responseJson(await mutateFacts(`/api/projects/${encodeURIComponent(projectId)}/materials/item`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ file, title, encoding: "utf8", content: "" }) })); await refresh(); setNewTextDraft(null); setSelectedFile(file); }); }
  async function saveSelectedMaterial() { if (!selected) return; const title = titleDraft.trim(); if (!title) return; await run("保存材料", async () => { const content = selected.kind === "text" && selected.text !== null ? { encoding: "utf8", content: textDraft } : {}; await responseJson(await mutateFacts(`/api/projects/${encodeURIComponent(projectId)}/materials/item`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: selected.file, title, ...content }) })); await refresh(); }); }
  async function deleteFile(material: ProjectMaterial) { if (!await confirm({ kind: "warning", title: "删除参考材料", message: `删除 materials/${material.file}？这个操作不能从工作台撤销。`, danger: true })) return; await run("删除材料", async () => { await responseJson(await mutateFacts(`/api/projects/${encodeURIComponent(projectId)}/materials/item?file=${encodeURIComponent(material.file)}`, { method: "DELETE" })); await refresh(); }); }
  async function saveAgreement() { if (!data || !agreementEditor?.text.trim()) return; const item = { ...agreementEditor, id: agreementEditor.id || recordId("agreement"), text: agreementEditor.text.trim() }; const items = data.agreement.items.some((entry) => entry.id === item.id) ? data.agreement.items.map((entry) => entry.id === item.id ? item : entry) : [...data.agreement.items, item]; await run("保存创作约定", async () => { await writeAgreement(items); setAgreementEditor(null); }); }
  async function deleteAgreement() { if (!data || !agreementEditor?.id) return; if (!await confirm({ kind: "warning", title: "删除创作约定", message: "删除这条创作约定？这个操作不能从工作台撤销。", danger: true })) return; await run("删除创作约定", async () => { await writeAgreement(data.agreement.items.filter((item) => item.id !== agreementEditor.id)); setAgreementEditor(null); }); }
  if (!data) return <UtilityPage title="参考材料" description="正在读取参考材料和创作约定。"><div className="empty-card">正在读取…</div></UtilityPage>;
  return <UtilityPage title="参考材料"><div data-project-fact-dirty={materialDirty || agreementDirty ? "true" : undefined}>
    <section className="materials-card materials-list-card"><header><div><h3>参考材料</h3><p>提供材料供 Agent 参考</p></div><button className="button button--primary" disabled={saving} onClick={() => setNewTextDraft({ file: "notes.md", title: "notes" })}>添加材料</button></header>
      {!materials.length && <div className="empty-card material-list-empty">当前没有参考材料。</div>}
      <div className="material-entries">{materials.map((material) => <article key={material.file}><button className="material-entry-main" disabled={saving} onClick={() => void requestSelectMaterial(material.file)}><b>{material.title}</b><small>materials/{material.file} · {material.available ? readableBytes(material.size_bytes) : "文件缺失"}</small></button><button className="button button--small button--danger" disabled={saving} onClick={() => void deleteFile(material)}>删除</button></article>)}</div>
    </section>
    {selected && <Modal size="workspace" className="material-editor-modal" title={selected.title} subtitle={`materials/${selected.file} · ${selected.available ? readableBytes(selected.size_bytes) : "文件缺失"}`} busy={saving} onClose={() => void requestCloseMaterial()} footer={<div className="material-editor-footer"><span>{materialDirty ? "有未保存修改" : ""}</span><div className="inline-actions"><button className="button" disabled={saving} onClick={() => void requestCloseMaterial()}>取消</button><button className="button button--primary" disabled={saving || !materialDirty || !titleDraft.trim()} onClick={() => void saveSelectedMaterial()}>{saving ? "正在保存…" : "保存"}</button></div></div>}>
      <div className="material-editor-dialog"><label className="material-title-field"><span>材料标题</span><input value={titleDraft} disabled={saving} onChange={(event) => setTitleDraft(event.target.value)} /></label>{!selected.available ? <div className="empty-card">这个材料文件已不存在。</div> : selected.kind === "text" && selected.text !== null ? <label className="material-body-field"><span>正文</span><textarea className="material-text-editor" value={textDraft} disabled={saving} onChange={(event) => setTextDraft(event.target.value)} /></label> : selected.kind === "image" && selected.url ? <img className="material-image-preview" src={selected.url} alt={selected.title} /> : <div className="empty-card">此格式暂不支持在工作台中预览或编辑。</div>}</div>
    </Modal>}
    {newTextDraft && <Modal title="添加材料" subtitle="创建文本材料供 Agent 参考" busy={saving} onClose={() => void requestCloseNewText()} footer={<><button className="button" disabled={saving} onClick={() => void requestCloseNewText()}>取消</button><button className="button button--primary" disabled={saving || !newTextDraft.file.trim() || !newTextDraft.title.trim()} onClick={() => void createTextMaterial()}>{saving ? "正在创建…" : "添加"}</button></>}>
      <div className="material-editor-dialog compact-editor-dialog"><label className="material-title-field"><span>文件名</span><input value={newTextDraft.file} disabled={saving} placeholder="例如 notes.md" onChange={(event) => setNewTextDraft({ ...newTextDraft, file: event.target.value })} /></label><label className="material-title-field"><span>材料标题</span><input value={newTextDraft.title} disabled={saving} onChange={(event) => setNewTextDraft({ ...newTextDraft, title: event.target.value })} /></label></div>
    </Modal>}
    <section className="materials-card agreement-card"><header><div><h3>创作约定</h3><p>描述希望 Agent 如何创作</p></div><button className="button button--primary" disabled={saving} onClick={() => setAgreementEditor({ id: "", text: "", strength: "preference" })}>添加约定</button></header>
      {!orderedAgreements.length && <div className="empty-card">当前没有创作约定。</div>}
      <div className="agreement-list">{orderedAgreements.map((item) => <button className="agreement-entry" key={item.id} disabled={saving} onClick={() => setAgreementEditor({ ...item })}><span className={`agreement-strength agreement-strength--${item.strength}`}>{item.strength === "hard" ? "必须遵守" : "创作偏好"}</span><span>{item.text}</span></button>)}</div>
    </section>
    {agreementEditor && <Modal title={agreementEditor.id ? "编辑创作约定" : "添加创作约定"} subtitle="约定会在整个项目中生效" busy={saving} onClose={() => void requestCloseAgreementEditor()} footer={<div className="agreement-editor-footer"><div>{agreementEditor.id && <button className="button button--danger" disabled={saving} onClick={() => void deleteAgreement()}>删除约定</button>}</div><div className="inline-actions"><button className="button" disabled={saving} onClick={() => void requestCloseAgreementEditor()}>取消</button><button className="button button--primary" disabled={saving || !agreementEditor.text.trim() || !agreementDirty} onClick={() => void saveAgreement()}>{saving ? "正在保存…" : agreementEditor.id ? "保存" : "添加"}</button></div></div>}>
      <div className="agreement-editor-dialog"><fieldset><legend>类型</legend><div className="agreement-strength-picker"><button type="button" className={agreementEditor.strength === "hard" ? "is-selected" : ""} aria-pressed={agreementEditor.strength === "hard"} disabled={saving} onClick={() => setAgreementEditor({ ...agreementEditor, strength: "hard" })}><b>必须遵守</b><small>不可违反的项目规则</small></button><button type="button" className={agreementEditor.strength === "preference" ? "is-selected" : ""} aria-pressed={agreementEditor.strength === "preference"} disabled={saving} onClick={() => setAgreementEditor({ ...agreementEditor, strength: "preference" })}><b>创作偏好</b><small>可按具体情境调整</small></button></div></fieldset><label><span>内容</span><textarea value={agreementEditor.text} disabled={saving} placeholder="写清楚希望 Agent 遵守或优先考虑的内容" onChange={(event) => setAgreementEditor({ ...agreementEditor, text: event.target.value })} /></label></div>
    </Modal>}
  </div></UtilityPage>;
}
