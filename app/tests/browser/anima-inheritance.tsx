import { StoryCandidateRefresh } from '../../src/StoryCandidateRefresh';
import type { WorkbenchPage } from '../../src/project-workbench-client';
import { SceneReferenceEditor } from '../../src/SceneReferenceEditor';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InheritedPromptEditor } from '../../src/InheritedPromptEditor';
import { AnimaSettingView } from '../../src/models/anima/SettingView';
import { PromptFragmentEditor } from '../../src/PromptFragmentEditor';
import { displayPromptDraft, createPromptDraftFragment, persistPromptDraft } from '../../src/prompt-fragment-draft';
import type { InheritedAdjustments, PagePrompt } from '../../src/models/anima/types';
import type { CharacterPromptDocument } from '../../src/models/anima/types';
import type { WorkbenchCharacter } from '../../src/project-workbench-client';
import '../../src/styles.css';
import { FeedbackProvider, useFeedback } from '../../src/feedback';
const prompt: PagePrompt = { population: [], person: [{ id: 'token-111111111111', description: 'long blue hair', weight: 1.2 }],  setting: [], camera: [], avoid: [] };
function Harness() {
 const [adjustments, setAdjustments] = useState<InheritedAdjustments>({ 'identity:token-111111111111': { enabled: false } });
 const [sourcePrompt, setSourcePrompt] = useState(prompt);
 const [scene, setScene] = useState<string | undefined>('steel');
 const [variant, setVariant] = useState<string | undefined>('default');
 const [local,setLocal] = useState(() => displayPromptDraft({...prompt, person: [{description:'local prompt'}]}));
 return <main style={{ width: 900, margin: '40px auto' }}>
 <div className="participant-editor"><span>场景设定</span><SceneReferenceEditor scenes={[{id:'steel',name:'冷蓝灰钢墙'},{id:'space',name:'暗紫星空'}].map(scene=>({...scene,description:'',profile_sha256:'profile',visual_sha256:'visual',prompt_sha256:'prompt',style:null,pages:[],visual:{variants:[{id:'default',name:'默认'}]},prompt:{prompt_name:scene.name,variants:{default:{text:''}}}}))} value={scene} variantId={variant} onChange={(id,variantId)=>{setScene(id);setVariant(variantId);}} /></div>
 <h2>子设定 · 继承基础 Prompt</h2>
 <button onClick={() => setSourcePrompt({...prompt, person: [{...prompt.person[0], description: 'short green hair', weight: 0.8, enabled:false}]})}>修改上游</button>
 <button onClick={() => setAdjustments(current => ({...current, 'identity:token-999999999999':{enabled:false}}))}>添加失效调整</button>
 <button onClick={() => setSourcePrompt({...prompt, person:[prompt.person[0],{...prompt.person[0],inheritance_key:'variant:token-111111111111',description:'variant hat'}]})}>加入同 ID 子设定词</button>
 <InheritedPromptEditor title="基础 Prompt" source="base" prompt={sourcePrompt} adjustments={adjustments} defaultOpen onChange={setAdjustments} />
 <div id="local"><PromptFragmentEditor categories={[{ id: 'person', label: '人物' }]} scope="character" fragments={local} onChange={setLocal} createFragment={createPromptDraftFragment} /></div>
 <h2>剧情页 · 引用角色</h2><InheritedPromptEditor title="Alice · 外套" source="page" prompt={prompt} onChange={() => {}} />
 <output>{JSON.stringify(adjustments)}</output>
 <pre id="persisted-local">{JSON.stringify(persistPromptDraft(local))}</pre>
 </main>;
}
function FeedbackHarness() {
 const { notify } = useFeedback();
 return <><button onClick={() => notify({kind:'error', message:'重复词：hair_over_one_eye。请删除本地重复词，在继承区调整权重和开关。'})}>触发错误</button>
 <button onClick={() => notify({kind:'info', message:'第一项详细结果\n第二项详细结果'})}>触发复杂信息</button>
 <button onClick={() => notify({kind:'success', message:'已保存'})}>触发成功</button></>;
}
function ScopeHarness() {
 const variant = {prompt:{...prompt,person:[{id:'token-222222222222',description:'variant clothing'}]},loras:[],identity_overrides:{}};
 const [character,setCharacter] = useState<WorkbenchCharacter<CharacterPromptDocument>>({id:'alice',name:'Alice',description:'',model_id:'anima',profile_sha256:'profile',visual_sha256:'visual',prompt_sha256:'prompt-v1',style:null,pages:[],visual:{variants:[{id:'day',name:'日常'}]},prompt_scope_versions:{anima:{base:'base-v1',variants:{day:'day-v1'}}},prompt:{identity:{prompt,lora:null},variants:{day:variant}}});
 const [selected,setSelected] = useState('profile');
 return <main>
 <button onClick={()=>setSelected('profile')}>打开基础</button><button onClick={()=>setSelected('day')}>打开日常</button>
 <button onClick={()=>setCharacter(current=>({...current,prompt_sha256:'prompt-v2',prompt_scope_versions:{anima:{base:'base-v1',variants:{day:'day-v2'}}},prompt:{...current.prompt,variants:{day:{...variant,prompt:{...prompt,person:[{id:'token-222222222222',description:'updated variant'}]}}}}}))}>更新未编辑子设定</button>
 <button onClick={()=>setCharacter(current=>({...current,prompt_sha256:'prompt-v3',prompt_scope_versions:{anima:{base:'base-v2',variants:{day:'day-v2'}}},prompt:{...current.prompt,identity:{prompt:{...prompt,person:[{id:'token-111111111111',description:'updated base'}]},lora:null}}}))}>更新基础版本</button>
 <AnimaSettingView projectId="demo" character={{...character,model_prompts:{models:{anima:character.prompt}}}} initialSettingId={selected} busy={false} onSaved={()=>{}} />
 </main>;
}
createRoot(document.getElementById('root')!).render(<FeedbackProvider>{location.search.includes('scopes') ? <ScopeHarness /> : location.search.includes('candidates') ? <StoryCandidateRefresh projectId="demo" busy={false} pages={['empty','changed'].map(id => ({page_id:id,title:id==='empty'?'没有候选的页面':'有变化的页面',page_key:{page_id:id}} as WorkbenchPage))} /> : location.search.includes('feedback') ? <FeedbackHarness /> : <Harness />}</FeedbackProvider>);
