import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FeedbackProvider} from '../../src/feedback';
import {WorkbenchCandidateWorkspace} from '../../src/WorkbenchCandidateWorkspace';
import type {PageMedia} from '../../src/project-workbench-client';
import '../../src/styles.css';
function Harness(){
 const [count,setCount]=useState(1);
 const params=new URLSearchParams(location.search);
 const media:PageMedia={candidates:Array.from({length:params.has('empty')?0:count},(_,i)=>({candidate_id:`candidate-${i}`,task_id:'test',generated_at:null,file:`candidate-${i}.png`,url:'/candidate.svg',seed:i,generation_signature:'current'}))};
 return <main className="workbench-shell workbench-shell--page is-full-layout is-drawer-navigation"><div className="current-workbench-page"><p>页面编辑区</p><WorkbenchCandidateWorkspace pageIdentity="test" pageTitle="测试页" media={media} candidateWidth={160} canvas="2:3" factReady generationReady currentGenerationSignature="current" onPreviewCanvasChange={()=>{}} onLetteringTarget={()=>{}} onCandidateWidthChange={()=>{}} onGenerate={()=>{}} pageDirty onSaveAll={()=>{}} onDiscardAll={()=>{}} onDeleteCandidates={async()=>true} onReloadMedia={()=>setCount(c=>c+1)} mediaStatus={params.has('error')?'error':'ready'} mediaError="媒体读取失败" finishedOutput={{projectId:'test',pageId:'test',onOutput:async()=>null}} generationProblems={params.has('issue')?[{severity:'error',message:'测试问题'}]:[]} /></div></main>;
}
createRoot(document.getElementById('root')!).render(<FeedbackProvider><Harness/></FeedbackProvider>);
