import {useState} from 'react';
import {Modal} from './Modal';
import {comicAction,planComicMerge} from './comic-client';
export function ComicMergeDialog({projectId,pageId,title,choices,beforeSave,onMerged,onClose}:{projectId:string;pageId:string;title:string;choices:{page_id:string;title:string}[];beforeSave:()=>Promise<boolean>;onMerged:()=>Promise<void>;onClose:()=>void}){
  const [other,setOther]=useState(choices[0]?.page_id??''),[axis,setAxis]=useState<'x'|'y'>('x'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function merge(){
    setBusy(true);setError('');
    try{if(!await beforeSave())return;const args={page_keys:[{page_id:pageId},{page_id:other}],axis};const plan=await planComicMerge(projectId,pageId,args);await comicAction(projectId,pageId,'merge',{...args,expected_sha256:plan.sha256});await onMerged();onClose();}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}
  }
  return <Modal title="与现有页合并" busy={busy} onClose={onClose} footer={<button className="button button--primary" disabled={busy||!other} onClick={()=>void merge()}>{busy?'合并中…':'合并为分镜页'}</button>}>
    <p>第一格：{title}</p><label>第二格<select aria-label="要合并的页面" disabled={busy} value={other} onChange={event=>setOther(event.target.value)}>{choices.map(page=><option key={page.page_id} value={page.page_id}>{page.title}</option>)}</select></label>
    <label>版式<select aria-label="合并版式" value={axis} disabled={busy} onChange={event=>setAxis(event.target.value as 'x'|'y')}><option value="x">左右并排</option><option value="y">上下排列</option></select></label>
    <p>目录保留当前页；两页的文案、Prompt 和所有候选分别保留。可从“裁切与版式设置”拆回独立页。</p>{error&&<p role="alert">{error}</p>}
  </Modal>;
}
