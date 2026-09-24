import canvasChoices from "../shared/canvas-presets.json";
import { useEffect, useState } from "react";
import { PromptTextField } from "./SourcePromptEditor";
import { responseJson } from "./api-response";
import { pageKeyId } from "./page-key";
import type { ProjectWorkbenchView, WorkbenchPage } from "./project-workbench-client";
import "./comparison-input-editor.css";
import { Modal } from "./Modal";
import { ResourcePicker } from "./ResourceCatalog";
import { loraResourceItem, loraMatchesProfile, type GlobalModelResource } from "./global-resource-catalog";

export type ComparisonInput = {
  id: string; label: string; prompt: { positive: string; negative: string };
  loras: Array<{ filename: string; sha256: string; weight: number; kind?: string; owner?: string }>;
  reference_images?: Array<{ material_file: string; sha256: string; source_sha256: string; width: number; height: number }>;
  reference_import_id?: string;
  render: { canvas: string; profile: { id: string; architecture_family?: string; prompt?: { family: string } }; workflows: Record<string, unknown> };
  source: { project_id: string; imported_at: string } | null;
};
const base = "/api/comparison-experiments";
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function ComparisonInputEditor({ value, onChange, disabled, models }: { value: ComparisonInput[]; onChange: (value: ComparisonInput[]) => void; disabled: boolean; models: GlobalModelResource[] }) {
  const [loraPickerInputId, setLoraPickerInputId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([]);
  const [project, setProject] = useState("");
  const [pages, setPages] = useState<WorkbenchPage[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetch("/api/projects", { signal: controller.signal }).then(response => responseJson<{ projects: typeof projects }>(response)), fetch(`${base}/input-options`, { signal: controller.signal }).then(response => responseJson<{ profiles: string[] }>(response))])
      .then(([p, r]) => { setProjects(p.projects); setProfiles(r.profiles); setProfile(r.profiles.includes("anima-base-v1") ? "anima-base-v1" : r.profiles[0] ?? ""); })
      .catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setPages([]); setSelected([]);
    if (!project) return;
    const controller = new AbortController();
    void fetch(`/api/projects/${encodeURIComponent(project)}/workbench`, { signal: controller.signal }).then(response => responseJson<ProjectWorkbenchView>(response)).then(view => {
      setPages([...view.outline.chapters.flatMap(chapter => chapter.sequences.flatMap(sequence => sequence.pages)), ...view.characters.flatMap(character => character.pages)].filter(page => page.page_kind !== "text"));
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [project]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }
  const locked = disabled || busy;
  function update(id: string, changes: Partial<ComparisonInput>) { onChange(value.map(input => input.id === id ? { ...input, ...changes } : input)); }
  return <fieldset className="comparison-input-editor" disabled={locked}><legend>测试输入</legend>
    <div className="comparison-form-grid">
      <label>来源项目<select aria-label="来源项目" value={project} onChange={event => setProject(event.target.value)}><option value="">选择项目页面导入</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
      <label>生成配置<select aria-label="新输入生成配置" value={profile} onChange={event => setProfile(event.target.value)}>{profiles.map(id => <option key={id}>{id}</option>)}</select></label>
      <button type="button" className="button" disabled={!profile} onClick={() => void perform(async () => { const result = await responseJson<{ input: ComparisonInput }>(await post(`${base}/blank-input`, { profile_id: profile })); onChange([...value, result.input]); })}>新增空白输入</button>
    </div>
    {project && <div className="comparison-page-options">{pages.map(page => <label key={pageKeyId(page.page_key)}><input type="checkbox" checked={selected.includes(pageKeyId(page.page_key))} onChange={event => setSelected(current => event.target.checked ? [...current, pageKeyId(page.page_key)] : current.filter(id => id !== pageKeyId(page.page_key)))} />{page.title || page.page_id}</label>)}</div>}
    {project && <button type="button" className="button" disabled={!selected.length} onClick={() => void perform(async () => {
      const result = await responseJson<{ inputs: ComparisonInput[] }>(await post(`${base}/import`, { project_id: project, page_keys: pages.filter(page => selected.includes(pageKeyId(page.page_key))).map(page => page.page_key) }));
      onChange([...value, ...result.inputs]); setSelected([]);
    })}>导入所选页面（{selected.length}）</button>}
    <p>导入后独立保存，来源页面的后续修改不会影响实验。</p>
    {value.map(input => <details className="settings-card comparison-input-card" key={input.id} open={value.length === 1 || undefined}>
      <summary>{input.label} · {input.render.profile.id} · {input.render.canvas}{input.reference_images?.length ? ` · ${input.reference_images.length} 张参考图` : ""}</summary>
      <label>名称<input value={input.label} onChange={event => update(input.id, { label: event.target.value })} /></label>
      {input.source && <small>导入来源：{input.source.project_id} · {new Date(input.source.imported_at).toLocaleString()}</small>}
      {Boolean(input.reference_images?.length) && <small>参考图：{input.reference_images?.map(image => image.material_file).join("、")}</small>}
      <PromptTextField label="正向 Prompt" ariaLabel={`${input.label} 正向 Prompt`} value={input.prompt.positive} disabled={locked} onChange={positive => update(input.id, { prompt: { ...input.prompt, positive } })} />
      <PromptTextField label="负向 Prompt" ariaLabel={`${input.label} 负向 Prompt`} rows={4} value={input.prompt.negative} disabled={locked} onChange={negative => update(input.id, { prompt: { ...input.prompt, negative } })} />
      <label>画幅<select value={input.render.canvas} onChange={event => update(input.id, { render: { ...input.render, canvas: event.target.value } })}>{!canvasChoices.some(c => c.value === input.render.canvas) && <option value={input.render.canvas} disabled>原画幅 {input.render.canvas}</option>}{canvasChoices.map(c => <option key={c.value} value={c.value}>{c.label} {c.value} · {c.width}×{c.height}</option>)}</select></label>
      {input.loras.map((lora, index) => <div className="free-lora-row" key={index}><span>{lora.filename}</span><label>权重<input type="number" min={-2} max={2} step={0.05} value={lora.weight} onChange={event => update(input.id, { loras: input.loras.map((entry, i) => i === index ? { ...entry, weight: event.target.valueAsNumber } : entry) })} /></label><button type="button" onClick={() => update(input.id, { loras: input.loras.filter((_, i) => i !== index) })}>移除 LoRA</button></div>)}
      <button type="button" className="button" onClick={() => setLoraPickerInputId(input.id)}>添加基础 LoRA</button>
      {loraPickerInputId === input.id && <Modal size="workspace" title="选择 LoRA" subtitle={input.render.profile.id} busy={locked} onClose={() => setLoraPickerInputId(null)}><div className="lora-picker-body"><ResourcePicker items={models.filter(model => loraMatchesProfile(model, input.render.profile)).map(loraResourceItem)} busy={locked} onSelect={item => { const model = models.find(model => model.id === item.id); if (model) void perform(async () => {
        const source = model.repository_record || model.local_record ? { id: model.id, kind: "resource", resource_id: model.id } : { id: model.id, kind: "raw", relative_path: model.relative_path };
        const result = await responseJson<{ lora: ComparisonInput["loras"][number] }>(await post(`${base}/input-lora`, { source })); update(input.id, { loras: [...input.loras, result.lora] });
        setLoraPickerInputId(null);
      }); }} />{error && <p role="alert">{error}</p>}</div></Modal>}
      <button type="button" className="button" onClick={() => onChange([...value, { ...structuredClone(input), id: `input-${crypto.randomUUID()}`, label: `${input.label}（副本）` }])}>复制输入</button>
      <button type="button" className="button" onClick={() => onChange(value.filter(item => item.id !== input.id))}>移除输入</button>
    </details>)}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
