import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MossEntriesEditor} from '../../src/models/moss/EntriesEditor';
import {MossLayoutModal} from '../../src/models/moss/LayoutModal';
import {MossPageEditor} from '../../src/models/moss/PageEditor';
import type {MossLayout,PagePromptDraft,CharacterPromptDocument} from '../../src/models/moss/types';
import type {WorkbenchPage,WorkbenchCharacter} from '../../src/project-workbench-client';
import {FeedbackProvider} from '../../src/feedback';
import type {MossEntry} from '../../shared/moss-prompt.mjs';
import '../../src/styles.css';
import '../../src/WorkbenchPageEditor.css';

function PageHarness(){
  const [prompt,setPrompt]=useState<PagePromptDraft>({composition:[{id:'composition',description:'Two people in a quiet room.'}],person:[],setting:[],camera:[],extra:[]});
  const [references,setReferences]=useState([{character_id:'alice',variant_id:'day'}]);
  const [characterText,setCharacterText]=useState('A woman in a blue coat.');
  const character:WorkbenchCharacter<CharacterPromptDocument>={model_id:'moss',id:'alice',name:'艾莲',visual:{variants:[{id:'day',name:'日常'}]},style:null,pages:[],profile_sha256:'profile',visual_sha256:'visual',prompt_sha256:'setting',prompt:{prompt_name:'Alice',identity:{lora:null},variants:{day:{entries:[{id:'appearance',description:characterText}],loras:[]}}}};
  const page:WorkbenchPage={model_id:'moss',kind:'story',page_id:'moss-fixture',page_key:{page_id:'moss-fixture'},title:'测试',prompt,characters:references,generation_dimensions:{width:960,height:1280},model_project_prompt:{style:[{id:'project-style',description:'Detailed watercolor.'}],lighting:[{id:'project-light',description:'Soft window light.'}],avoid:[{description:'watermark, logo'}]}};
  return <FeedbackProvider><main id="host" style={{maxWidth:1000,width:'100%',padding:8,boxSizing:'border-box'}}><MossPageEditor projectId="test" page={page} prompt={prompt} onChange={setPrompt} characters={[character]} scenes={[]} references={references} onReferencesChange={setReferences} disabled={false}/><button onClick={()=>setCharacterText('A woman in a red coat.')} type="button">更新来源设定</button><output id="page-prompt" hidden>{JSON.stringify(prompt)}</output></main></FeedbackProvider>;
}
function Harness(){
  const [entries,setEntries]=useState<MossEntry[]>([{id:'one',description:'A sunlit room.'},{id:'two',description:'Curtains sway near the window.'}]);
  const [layout,setLayout]=useState<MossLayout>({enabled:true,items:[{id:'alice-box',character_id:'alice',bbox:[.15,.15,.3,.65]}]});
  const [open,setOpen]=useState(false),[landscape,setLandscape]=useState(false);
  return <main id="host" style={{maxWidth:1000,width:'100%',padding:8,boxSizing:'border-box'}}>
    <MossEntriesEditor label="场景" value={entries} scopeKey="moss-fixture" onChange={setEntries}/>
    <button type="button" onClick={()=>setOpen(true)}>编辑 Layout</button>
    <button type="button" onClick={()=>setLandscape(current=>!current)}>切换画幅</button>
    {open&&<MossLayoutModal value={layout} characters={[{id:'alice',name:'艾莲',description:'A woman in a blue coat.'},{id:'bob',name:'鲍勃',description:'A man wearing a hat.'}]} dimensions={landscape?{width:1280,height:960}:{width:960,height:1280}} onClose={()=>setOpen(false)} onApply={next=>{setLayout(next);setOpen(false);}}/>}
    <output id="entries" hidden>{JSON.stringify(entries)}</output><output id="layout" hidden>{JSON.stringify(layout)}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('page')?<PageHarness/>:<Harness/>);
