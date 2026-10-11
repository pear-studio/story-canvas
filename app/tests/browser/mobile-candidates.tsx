import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FeedbackProvider} from '../../src/feedback';
import {WorkbenchCandidateWorkspace} from '../../src/WorkbenchCandidateWorkspace';
import type {PageMedia} from '../../src/project-workbench-client';
import '../../src/styles.css';
function Harness(){
 const params=new URLSearchParams(location.search);
 const thumbnails=params.has('thumbnails');
 const [count,setCount]=useState(thumbnails?9:1);
 const [version,setVersion]=useState(0);
 const media:PageMedia={candidates:Array.from({length:params.has('empty')?0:count},(_,i)=>({candidate_id:`candidate-${i}`,task_id:'test',generated_at:thumbnails?`2026-10-10T00:00:${String(59-i).padStart(2,'0')}Z`:null,file:`candidate-${i}.png`,url:thumbnails?`/candidate-${i}.svg?v=${version}`:'/candidate.svg',seed:i,generation_signature:'current'}))};
 return <main className={`workbench-shell workbench-shell--page is-full-layout ${thumbnails?'':'is-drawer-navigation'}`}><div className="current-workbench-page"><p>页面编辑区</p>{thumbnails&&<button onClick={()=>setVersion(v=>v+1)}>更新缩略图地址</button>}<WorkbenchCandidateWorkspace pageIdentity="test" pageTitle="测试页" media={media} candidateWidth={160} canvas={params.get('canvas')??'2:3'} factReady generationReady currentGenerationSignature="current" onPreviewCanvasChange={()=>{}} onLetteringTarget={()=>{}} onCandidateWidthChange={()=>{}} onGenerate={()=>{}} pageDirty onSaveAll={()=>{}} onDiscardAll={()=>{}} onDeleteCandidates={async()=>true} onReloadMedia={()=>setCount(c=>c+1)} mediaStatus={params.has('error')?'error':'ready'} mediaError="媒体读取失败" finishedOutput={{projectId:'test',pageId:'test',onOutput:async()=>null}} generationProblems={params.has('issue')?[{severity:'error',message:'测试问题'}]:[]} /></div></main>;
}
createRoot(document.getElementById('root')!).render(<FeedbackProvider><Harness/></FeedbackProvider>);
