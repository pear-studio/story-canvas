import {useState} from 'react';
import {readFacts,mutateTargetFacts} from '../project-write-client';
import {workbenchResponseJson} from '../api-response';
import type {WorkbenchPage} from '../project-workbench-client';
import {modelChoices} from './registry';
export function PageGenerationSettings({projectId,page,disabled,beforeChange,onSaved}:{projectId:string;page:WorkbenchPage;disabled:boolean;beforeChange:()=>Promise<boolean>;onSaved:()=>Promise<void>|void}) {
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  if(!page.render)return null;
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
  return <div className="page-generation-settings"><label>生成模型 <select aria-label="本页生成模型" disabled={disabled||saving} value={page.render.model_id??'qwen'} onChange={event=>{const choice=modelChoices.find(c=>c.id===event.target.value)!;void change({model_id:choice.id,profile_id:choice.profileId});}}>{modelChoices.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label><label>画幅 <select aria-label="本页画幅" disabled={disabled||saving} value={page.render.canvas} onChange={event=>void change({canvas:event.target.value})}>{['2:3','3:4','9:16','4:3'].map(c=><option key={c}>{c}</option>)}</select></label>{page.model_id==='qwen'&&page.model_prompts?.models?.anima&&<button type="button" className="button button--quiet" disabled={disabled||saving} onClick={()=>void reimport()}>从 Anima 重新带入文字</button>}{saving&&<small>保存中…</small>}{error&&<p role="alert">{error}</p>}</div>;
}
