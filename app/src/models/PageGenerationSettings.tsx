import {useState} from 'react';
import {readFacts,mutateTargetFacts} from '../project-write-client';
import {workbenchResponseJson} from '../api-response';
import type {WorkbenchPage} from '../project-workbench-client';
import {modelChoices} from './registry';
import canvasChoices from '../../shared/canvas-presets.json';
export function PageGenerationSettings({projectId,page,disabled,beforeChange,onSaved,compact=false}:{compact?:boolean;projectId:string;page:WorkbenchPage;disabled:boolean;beforeChange:()=>Promise<boolean>;onSaved:()=>Promise<void>|void}) {
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  if(!page.render)return null;
  const [width,height]=page.render.canvas.split(':').map(Number);
  const scale=24/Math.max(width,height);
  async function reimport() {
    setSaving(true);setError('');
    try {
      if(!await beforeChange())return;
      const [render,prompt]=await Promise.all(['render','prompt'].map(async kind=>workbenchResponseJson<{expected_sha256:string}>(await readFacts(`/api/agent/facts/page/${kind}/read`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:projectId,target_id:page.page_id})}))));
      await workbenchResponseJson(await mutateTargetFacts(`/api/projects/${encodeURIComponent(projectId)}/workbench/qwen-import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page_key:page.page_key,expected_prompt_sha256:prompt.expected_sha256,expected_render_sha256:render.expected_sha256})}));
      await onSaved();
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}
  }
  async function change(patch:Partial<NonNullable<WorkbenchPage['render']>>) {
    setSaving(true);setError('');
    try {
      if(!await beforeChange())return;
      const draft=await workbenchResponseJson<{project_id:string;target_id:string;document:NonNullable<WorkbenchPage['render']>;expected_sha256:string;expected_context_sha256:string}>(await readFacts('/api/agent/facts/page/render/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:projectId,target_id:page.page_id})}));
      await workbenchResponseJson(await mutateTargetFacts('/api/agent/facts/page/render/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...draft,document:{...draft.document,...patch}})}));
      await onSaved();
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}
  }
  return <div className={`page-generation-settings${compact?" page-generation-settings--compact":""}`}>
    <label><span className="generation-setting-label">生成模型</span> <select aria-label="本页生成模型" disabled={disabled||saving} value={page.render.model_id} onChange={event=>{const choice=modelChoices.find(c=>c.id===event.target.value)!;void change({model_id:choice.id,profile_id:choice.profileId});}}>{modelChoices.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
    <label className="page-canvas-control" title={`画幅：${page.render.canvas} · ${canvasChoices.find(c=>c.value===page.render!.canvas)?.label??''}`}><span className="generation-setting-label">画幅</span>
      <svg className="page-canvas-preview" width="30" height="30" viewBox="0 0 30 30" role="img" aria-label={`画幅示意：${page.render.canvas} · ${canvasChoices.find(c=>c.value===page.render!.canvas)?.label??''}`}>
        <rect x={(30-width*scale)/2} y={(30-height*scale)/2} width={width*scale} height={height*scale} rx="1"/>
      </svg>
      <select aria-label="本页画幅" disabled={disabled||saving} value={page.render.canvas} onChange={event=>void change({canvas:event.target.value})}>
        {!canvasChoices.some(c=>c.value===page.render!.canvas)&&<option value={page.render.canvas} disabled>原画幅 {page.render.canvas}</option>}
        {canvasChoices.map(c=><option key={c.value} value={c.value}>{c.label} {c.value} · {c.width}×{c.height}</option>)}
      </select>
    </label>
    {page.model_id==='qwen'&&page.model_prompts?.models?.anima&&<button type="button" className="button button--quiet" disabled={disabled||saving} onClick={()=>void reimport()}>从 Anima 重新带入文字</button>}
    {saving&&<small>保存中…</small>}{error&&<p role="alert">{error}</p>}
  </div>;
}
