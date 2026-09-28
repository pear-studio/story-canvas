import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ModelPromptEditor} from '../../src/models/registry';
import type {PagePrompt,WorkbenchPage,WorkbenchCharacter} from '../../src/project-workbench-client';
import '../../src/styles.css';
const empty=()=>({population:[],person:[],setting:[],camera:[],avoid:[]});
function App(){
 const [prompt,setPrompt]=useState<PagePrompt>({...empty(),population:[{id:'token-111111111111',tag:'1girl'}],person:[{id:'token-222222222222',tag:'on_stomach'},{id:'token-333333333333',tag:'couch'},{id:'token-444444444444',tag:'thighs',enabled:false}],loras:[],scene_id:'room',scene_variant_id:'default'}),[weight,setWeight]=useState(.7);
 const lora={filename:'character.safetensors',sha256:'a'.repeat(64),weight,trigger:'character_trigger'};
 const native={identity:{prompt:empty(),lora},variants:{default:{prompt:empty(),loras:[],identity_disabled:[]}}};
 const character={id:'alice',name:'测试角色',model_id:'anima',description:'',profile_sha256:'p',prompt_sha256:String(weight),visual_sha256:'v',visual:{variants:[{id:'default',name:'默认'}]},prompt:native,model_prompts:{models:{anima:native}},pages:[]} as unknown as WorkbenchCharacter;
 const page={page_id:'page-001',model_id:'anima',prompt_sha256:'p',render:{profile_id:'anima-base-v1'},project_loras:[{...lora,filename:'project.safetensors',sha256:'b'.repeat(64),weight:.9}]} as WorkbenchPage;
 const sceneNative={...native,identity:{...native.identity,lora:{...lora,filename:'room.safetensors'}}};
 const scene={...character,id:'room',name:'测试场景',model_prompts:{models:{anima:sceneNative}}};
 return <main style={{maxWidth:1000,margin:'auto'}}><button onClick={()=>setWeight(1.1)}>修改上游权重</button><ModelPromptEditor projectId="demo" page={page} prompt={prompt} onChange={setPrompt} characters={[character]} scenes={[scene]} references={[{character_id:'alice',variant_id:'default'}]} onReferencesChange={()=>{}} disabled={false}/><output id="draft">{JSON.stringify(prompt)}</output></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
