import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkbenchPageEditor from '../../src/WorkbenchPageEditor';
import type { WorkbenchCharacter, WorkbenchPage } from '../../src/project-workbench-client';
import '../../src/styles.css';
const blank = () => ({ subject: [], person: [], setting: [], camera: [], avoid: [] });
const setting = (id: string, name: string): WorkbenchCharacter => ({
  id, name, description: '', profile_sha256: 'profile', visual_sha256: 'visual', prompt_sha256: 'prompt', style: null, pages: [],
  visual: { variants: [{id:'day',name:'白天'},{id:'night',name:'夜晚'}] },
  prompt: { identity: {prompt:blank(),lora:null}, variants: {day:{prompt:blank(),loras:[]},night:{prompt:blank(),loras:[]}} },
});
const characters = [setting('alice','艾莲'),setting('bob','鲍勃')];
const scenes = [setting('room','房间')];
const kind = new URLSearchParams(location.search).get('kind') as WorkbenchPage['kind'] ?? 'story';
const initial: WorkbenchPage = {
  kind, page_id:'page-fixture', page_key:{page_id:'page-fixture'}, character_id:kind==='character'?'alice':undefined,
  scene_id:kind==='scene'?'room':undefined, variant_id:'day', title:'统一视觉页', scene_description:'窗边休息',
  characters:[{character_id:'alice',variant_id:'day'}], dialogue:[], content_sha256:'content', prompt_sha256:'prompt', prompt_context_sha256:'context', layout_sha256:'layout',
  prompt:{...blank(),scene_id:'room',scene_variant_id:'day',inheritance:{'scene:room:day':{}}},
} as WorkbenchPage;
function Harness() {
 const [page,setPage] = useState(initial);
 return <div style={{maxWidth:1000,padding:24}}><button onClick={()=>setPage(current=>({...current,scene_description:'外部改写的内容',characters:[],prompt:{...blank(),scene_id:'room',scene_variant_id:'night'},content_sha256:'external-content',prompt_sha256:'external-prompt',prompt_context_sha256:'external-context',layout_sha256:'external-layout'}))}>模拟外部刷新</button><WorkbenchPageEditor projectId="test" page={page} characters={characters} scenes={scenes} letteringStyle={{font_family:"Microsoft YaHei",font_size:28,character_speech:{direction:"horizontal",kind:"balloon"},character_thought:{direction:"horizontal",kind:"plain"},npc_speech:{direction:"horizontal",kind:"balloon"}}}
   onSavePage={async(content,prompt,items,baseline)=>{
     localStorage.setItem('submitted-baseline',JSON.stringify(baseline));
     if(baseline.content_sha256!==page.content_sha256)throw new Error('page_content_target_conflict');
     if(new URLSearchParams(location.search).has('fail-once')&&!sessionStorage.getItem('failed')){sessionStorage.setItem('failed','true');throw new Error('模拟写入冲突');}
     const savedContent={...content,dialogue:(content.dialogue??[]).map((line,index)=>({...line,id:line.id?.startsWith("dialogue-")?line.id:`dialogue-${String(index).padStart(12,"0")}`}))};
     const savedPage={...page,...savedContent,prompt,content_sha256:crypto.randomUUID(),prompt_sha256:crypto.randomUUID()} as WorkbenchPage;
     const result={page:savedPage,content:savedContent,prompt,items};localStorage.setItem('saved-page',JSON.stringify(result));
     setPage(savedPage);
     return result;
   }} /></div>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

