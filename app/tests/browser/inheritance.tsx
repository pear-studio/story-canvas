import { StoryCandidateRefresh } from '../../src/StoryCandidateRefresh';
import type { WorkbenchPage } from '../../src/project-workbench-client';
import { SceneReferenceEditor } from '../../src/SceneReferenceEditor';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InheritedPromptEditor } from '../../src/InheritedPromptEditor';
import { PromptFragmentEditor } from '../../src/PromptFragmentEditor';
import { displayPromptDraft, createPromptDraftFragment } from '../../src/prompt-fragment-draft';
import type { InheritedAdjustments, PagePrompt } from '../../src/project-workbench-client';
import '../../src/styles.css';
import { FeedbackProvider, useFeedback } from '../../src/feedback';
const prompt: PagePrompt = { subject: [], person: [{ id: 'token-111111111111', description: 'long blue hair', weight: 1.2 }],  setting: [], camera: [], avoid: [] };
function Harness() {
 const [adjustments, setAdjustments] = useState<InheritedAdjustments>({ 'long blue hair': { enabled: false } });
 const [scene, setScene] = useState<string | undefined>('steel');
 const [variant, setVariant] = useState<string | undefined>('default');
 const [local,setLocal] = useState(displayPromptDraft(prompt));
 return <main style={{ width: 900, margin: '40px auto' }}>
 <div className="participant-editor"><span>场景设定</span><SceneReferenceEditor scenes={[{id:'steel',name:'冷蓝灰钢墙'},{id:'space',name:'暗紫星空'}].map(scene=>({...scene,description:'',profile_sha256:'profile',visual_sha256:'visual',prompt_sha256:'prompt',style:null,pages:[],visual:{variants:[{id:'default',name:'默认'}]},prompt:{identity:{prompt,lora:null},variants:{default:{prompt,loras:[]}}}}))} value={scene} variantId={variant} onChange={(id,variantId)=>{setScene(id);setVariant(variantId);}} /></div>
 <h2>子设定 · 继承基础 Prompt</h2>
 <InheritedPromptEditor title="基础 Prompt" source="base" prompt={prompt} adjustments={adjustments} defaultOpen onChange={setAdjustments} />
 <div id="local"><PromptFragmentEditor categories={[{ id: 'person', label: '人物' }]} scope="character" fragments={local} onChange={setLocal} createFragment={createPromptDraftFragment} /></div>
 <h2>剧情页 · 引用角色</h2><InheritedPromptEditor title="Alice · 外套" source="page" prompt={prompt} onChange={() => {}} />
 <output>{JSON.stringify(adjustments)}</output>
 </main>;
}
function FeedbackHarness() {
 const { notify } = useFeedback();
 return <><button onClick={() => notify({kind:'error', message:'重复词：hair_over_one_eye。请删除本地重复词，在继承区调整权重和开关。'})}>触发错误</button>
 <button onClick={() => notify({kind:'info', message:'第一项详细结果\n第二项详细结果'})}>触发复杂信息</button>
 <button onClick={() => notify({kind:'success', message:'已保存'})}>触发成功</button></>;
}
createRoot(document.getElementById('root')!).render(<FeedbackProvider>{location.search.includes('candidates') ? <StoryCandidateRefresh projectId="demo" busy={false} pages={['empty','changed'].map(id => ({page_id:id,title:id==='empty'?'没有候选的页面':'有变化的页面',page_key:{page_id:id}} as WorkbenchPage))} /> : location.search.includes('feedback') ? <FeedbackHarness /> : <Harness />}</FeedbackProvider>);
