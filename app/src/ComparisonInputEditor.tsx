import canvasChoices from "../shared/canvas-presets.json";
import { useEffect, useRef, useState } from "react";
import { PromptTextField } from "./SourcePromptEditor";
import { responseJson } from "./api-response";
import { pageKeyId } from "./page-key";
import type { ProjectWorkbenchView, WorkbenchPage } from "./project-workbench-client";
import "./comparison-input-editor.css";
import { Modal } from "./Modal";
import { ResourcePicker } from "./ResourceCatalog";
import { loraResourceItem, loraMatchesProfile, type GlobalModelResource } from "./global-resource-catalog";
import {MossComparisonEditor,type MossComparisonInput} from './models/moss/ComparisonEditor';
import type {MossProjectPrompt} from './models/moss/types';

type ComparisonRecipe={resolutions:Record<string,{width:number;height:number}>;cfg?:number};
type ComparisonProfile={id:string;architecture_family?:string;prompt?:Partial<MossProjectPrompt>&{family?:string};operations?:{candidates?:{routes?:Record<string,{recipe:ComparisonRecipe;workflow?:string}>}}};

export type ComparisonInput = {
  version?:number;native_input?:MossComparisonInput;
  id: string; label: string; prompt: { positive: string; negative: string };
  loras: Array<{ filename: string; sha256: string; weight: number; kind?: string; owner?: string;trigger_words?:string[];source_identity?:{activation?:{trigger_words:string[]};[key:string]:unknown} }>;
  reference_images?: Array<{ material_file: string; sha256: string; source_sha256: string; width: number; height: number }>;
  reference_import_id?: string;
  render: { canvas: string; profile: ComparisonProfile; workflows: Record<string, unknown>;route?:{input_source:string;operation?:string;workflow_id?:string;recipe_source_id?:string} };
  source: { project_id: string; imported_at: string } | null;
};
export function comparisonInputDimensions(input:ComparisonInput) {
  const route=input.render.route?.input_source??(input.reference_images?.length?'reference_image':'empty_latent');
  return input.render.profile.operations?.candidates?.routes?.[route]?.recipe.resolutions[input.render.canvas]??null;
}
export function comparisonInputFamily(input:ComparisonInput) {return input.render.profile.architecture_family??'';}
const base = "/api/comparison-experiments";
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function ComparisonInputEditor({ value, onChange, disabled, models }: { value: ComparisonInput[]; onChange: (value: ComparisonInput[]) => void; disabled: boolean; models: GlobalModelResource[] }) {
  const currentValue=useRef(value),change=useRef(onChange),mounted=useRef(true),working=useRef(false);
  currentValue.current=value;change.current=onChange;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  function emit(next:ComparisonInput[]){if(!mounted.current)return;currentValue.current=next;change.current(next);}
  function append(inputs:ComparisonInput[]){const next=[...currentValue.current,...inputs],families=new Set(next.map(comparisonInputFamily));if(families.size>1)throw Error('一个实验只能使用同一模型家族；请移除其他模型输入，或另建实验。');emit(next);}
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
      .then(([p, r]) => { if(controller.signal.aborted)return;setProjects(p.projects); setProfiles(r.profiles); setProfile(r.profiles.includes("anima-base-v1") ? "anima-base-v1" : r.profiles[0] ?? ""); })
      .catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setPages([]); setSelected([]);
    if (!project) return;
    const controller = new AbortController();
    void fetch(`/api/projects/${encodeURIComponent(project)}/workbench`, { signal: controller.signal }).then(response => responseJson<ProjectWorkbenchView>(response)).then(view => {
      if(controller.signal.aborted)return;
      setPages([...view.outline.chapters.flatMap(chapter => chapter.sequences.flatMap(sequence => sequence.pages)), ...view.characters.flatMap(character => character.pages)].filter(page => !['text','collage'].includes(page.page_kind??'')));
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [project]);
  async function perform(action: () => Promise<void>) { if(working.current)return;working.current=true;setBusy(true); setError(""); try { await action(); } catch (error) { if(mounted.current)setError(error instanceof Error ? error.message : String(error)); } finally { working.current=false;if(mounted.current)setBusy(false); } }
  const locked = disabled || busy;
  function update(id: string, changes: Partial<ComparisonInput>) { emit(currentValue.current.map(input => input.id === id ? { ...input, ...changes } : input)); }
  function removeLora(input:ComparisonInput,index:number) {
    const loras=input.loras.filter((_,i)=>i!==index);
    update(input.id,{loras,...(input.native_input?{native_input:{...input.native_input,trigger_sources:input.native_input.trigger_sources.filter(source=>loras.some(lora=>lora.sha256===source.lora_sha256))}}:{})});
  }
  return <fieldset className="comparison-input-editor" disabled={locked}><legend>测试输入</legend>
    <div className="comparison-form-grid">
      <label>来源项目<select aria-label="来源项目" value={project} onChange={event => setProject(event.target.value)}><option value="">选择项目页面导入</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
      <label>空白输入生成配置<select aria-label="新输入生成配置" value={profile} onChange={event => setProfile(event.target.value)}>{profiles.map(id => <option key={id}>{id}</option>)}</select><small>只用于空白输入；页面导入使用页面自己的模型与配方。</small></label>
      <button type="button" className="button" disabled={!profile} onClick={() => void perform(async () => { const result = await responseJson<{ input: ComparisonInput }>(await post(`${base}/blank-input`, { profile_id: profile })); append([result.input]); })}>新增空白输入</button>
    </div>
    {project && <div className="comparison-page-options">{pages.map(page => <label key={pageKeyId(page.page_key)}><input type="checkbox" checked={selected.includes(pageKeyId(page.page_key))} onChange={event => setSelected(current => event.target.checked ? [...current, pageKeyId(page.page_key)] : current.filter(id => id !== pageKeyId(page.page_key)))} />{page.title || page.page_id}<small>{page.model_id} · {page.render?.profile_id??'未配置生成模型'}</small></label>)}</div>}
    {project && <button type="button" className="button" disabled={!selected.length} onClick={() => void perform(async () => {
      const result = await responseJson<{ inputs: ComparisonInput[] }>(await post(`${base}/import`, { project_id: project, page_keys: pages.filter(page => selected.includes(pageKeyId(page.page_key))).map(page => page.page_key) }));
      append(result.inputs); if(mounted.current)setSelected([]);
    })}>导入所选页面（{selected.length}）</button>}
    <p>导入后独立保存，来源页面的后续修改不会影响实验。</p>
    {value.length>0&&<p role="status">当前实验模型：{comparisonInputFamily(value[0])} · 仅接纳同家族输入</p>}
    {value.map(input => {const dimensions=comparisonInputDimensions(input);return <details className="settings-card comparison-input-card" key={input.id} open={value.length === 1 || undefined}>
      <summary>{input.label} · {input.render.profile.id} · {input.render.canvas} · {dimensions?`${dimensions.width}×${dimensions.height}`:'尺寸待预检确认'}{input.reference_images?.length ? ` · ${input.reference_images.length} 张参考图` : ""}</summary>
      <label>名称<input value={input.label} onChange={event => update(input.id, { label: event.target.value })} /></label>
      {input.source && <small>导入来源：{input.source.project_id} · {new Date(input.source.imported_at).toLocaleString()}</small>}
      {Boolean(input.reference_images?.length) && <small>参考图：{input.reference_images?.map(image => image.material_file).join("、")}</small>}
      {input.native_input?.model_id==='moss'?<MossComparisonEditor value={input.native_input} inputId={input.id} projectPrompt={input.render.profile.prompt} dimensions={dimensions} disabled={locked} onChange={native_input=>update(input.id,{native_input})}/>:<><PromptTextField label="正向 Prompt" ariaLabel={`${input.label} 正向 Prompt`} value={input.prompt.positive} disabled={locked} onChange={positive => update(input.id, { prompt: { ...input.prompt, positive } })} /><PromptTextField label="负向 Prompt" ariaLabel={`${input.label} 负向 Prompt`} rows={4} value={input.prompt.negative} disabled={locked} onChange={negative => update(input.id, { prompt: { ...input.prompt, negative } })} /></>}
      <label>画幅<select aria-label={`${input.label} 画幅`} value={input.render.canvas} onChange={event => update(input.id, { render: { ...input.render, canvas: event.target.value } })}>{!canvasChoices.some(c => c.value === input.render.canvas) && <option value={input.render.canvas} disabled>原画幅 {input.render.canvas}</option>}{canvasChoices.map(c => {const size=comparisonInputDimensions({...input,render:{...input.render,canvas:c.value}});return <option key={c.value} value={c.value}>{c.label} {c.value}{size?` · ${size.width}×${size.height}`:''}</option>;})}</select></label>
      {input.loras.map((lora, index) => <div className="free-lora-row" key={index}><span>{lora.filename}</span><label>权重<input type="number" min={-2} max={2} step={0.05} value={lora.weight} onChange={event => update(input.id, { loras: input.loras.map((entry, i) => i === index ? { ...entry, weight: event.target.valueAsNumber } : entry) })} /></label><button type="button" onClick={() => removeLora(input,index)}>移除 LoRA</button></div>)}
      <button type="button" className="button" onClick={() => setLoraPickerInputId(input.id)}>添加基础 LoRA</button>
      {loraPickerInputId === input.id && <Modal size="workspace" title="选择 LoRA" subtitle={input.render.profile.id} busy={locked} onClose={() => setLoraPickerInputId(null)}><div className="lora-picker-body"><ResourcePicker items={models.filter(model => loraMatchesProfile(model, input.render.profile)).map(loraResourceItem)} busy={locked} onSelect={item => { const model = models.find(model => model.id === item.id); if (model) void perform(async () => {
        const source = model.repository_record || model.local_record ? { id: model.id, kind: "resource", resource_id: model.id } : { id: model.id, kind: "raw", relative_path: model.relative_path };
        const result = await responseJson<{ lora: ComparisonInput["loras"][number] }>(await post(`${base}/input-lora`, { source }));const current=currentValue.current.find(value=>value.id===input.id);if(!current)return;if(current.loras.some(lora=>lora.sha256===result.lora.sha256))throw Error('该 LoRA 已在输入中，不能重复追加同一文件。');
        let native_input=current.native_input;
        const words=result.lora.trigger_words??result.lora.source_identity?.activation?.trigger_words;
        if(native_input&&words!==undefined)native_input={...native_input,trigger_sources:[...native_input.trigger_sources,{lora_sha256:result.lora.sha256,kind:'page',owner:current.id,words:[...words]}]};
        update(input.id, { loras: [...current.loras, result.lora],...(native_input?{native_input}:{}) });
        if(mounted.current)setLoraPickerInputId(null);
      }); }} />{error && <p role="alert">{error}</p>}</div></Modal>}
      <button type="button" className="button" onClick={() => emit([...currentValue.current, { ...structuredClone(input), id: `input-${crypto.randomUUID()}`, label: `${input.label}（副本）` }])}>复制输入</button>
      <button type="button" className="button" onClick={() => emit(currentValue.current.filter(item => item.id !== input.id))}>移除输入</button>
    </details>;})}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
