import { FeedbackProvider } from '../../src/feedback';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkbenchPageEditor from '../../src/WorkbenchPageEditor';
import { PageWorkspace } from '../../src/App';
import type { WorkbenchCharacter, WorkbenchPage } from '../../src/project-workbench-client';
import '../../src/styles.css';
const setting = (id: string, name: string): WorkbenchCharacter => ({
  id, name, description: '', profile_sha256: 'profile', visual_sha256: 'visual', prompt_sha256: 'prompt', style: null, pages: [],
  visual: { variants: [{id:'day',name:'白天'},{id:'night',name:'夜晚'}] },
  prompt: { prompt_name: name, variants: {
    day: { text: `${name}白天的完整描述`, reference_images: [{id:'ref-11111111-1111-4111-8111-111111111111',file:'reference-11111111.png',title:'正面'},{id:'ref-22222222-2222-4222-8222-222222222222',file:'reference-22222222.png',title:'侧面'}] },
    night: { text: `${name}夜晚的完整描述` },
  } },
});
const characters = [setting('alice','艾莲'),setting('bob','鲍勃')];
const scenes = [setting('room','房间'),setting('street','街道')];
if (new URLSearchParams(location.search).has('lazy-reference')) { delete characters[1].prompt; delete characters[1].prompt_sha256; }
const kind = new URLSearchParams(location.search).get('kind') as WorkbenchPage['kind'] ?? 'story';
const initial: WorkbenchPage = {
  kind, page_id:'page-fixture', page_key:{page_id:'page-fixture'}, character_id:kind==='character'?'alice':undefined,
  scene_id:kind==='scene'?'room':undefined, variant_id:'day', title:'统一视觉页', scene_description:'窗边休息',
  characters:[{character_id:'alice',variant_id:'day'}], dialogue:[], content_sha256:'content', prompt_sha256:'prompt', prompt_context_sha256:'context', layout_sha256:'layout',
  prompt:{ text:'', scene_id:'room', scene_variant_id:'day', text_overrides:{}, reference_overrides:{} },
} as WorkbenchPage;
if (new URLSearchParams(location.search).has('empty')) { initial.characters=[]; initial.prompt={ text:'' }; }
if (new URLSearchParams(location.search).has('extra')) initial.prompt.reference_images=[{id:'ref-33333333-3333-4333-8333-333333333333',file:'reference-extra.png',title:'附加图'}];
function Harness() {
 const [page,setPage] = useState(initial);
 if (new URLSearchParams(location.search).has('workspace')) return <PageWorkspace projectId="test" location={{page,key:page.page_id,breadcrumb:['测试',page.title]}} ownerPages={[]} characters={characters} scenes={scenes} renderCapabilities={{candidates:{available:true,counts:[1,3]}}} defaultRenderProfile="qwen" canvas="2:3" letteringStyle={null} taskCollection={{tasks:[],history:[]}} busy={false} editorWidth={600} candidateWidth={200} pageOrder={1} onEditorTabChange={()=>{}} onOpenLetteringSettings={()=>{}} onOpenPromptOverview={()=>{}} onEditorWidthChange={()=>{}} onCandidateWidthChange={()=>{}} onPageChanged={(_target,patch)=>setPage(current=>({...current,...patch}))} onReload={async()=>{}} onTrackedTasksChange={()=>{}} />;
 return <div style={{maxWidth:1000,padding:24}}><button onClick={()=>setPage(current=>({...current,scene_description:'外部改写的内容',characters:[],prompt:{ text:'', scene_id:'room', scene_variant_id:'night' },content_sha256:'external-content',prompt_sha256:'external-prompt',prompt_context_sha256:'external-context',layout_sha256:'external-layout'}))}>模拟外部刷新</button><WorkbenchPageEditor projectId="test" page={page} characters={characters} scenes={scenes} letteringStyle={{font_family:"Microsoft YaHei",font_size:28,character_speech:{direction:"horizontal",kind:"balloon"},character_thought:{direction:"horizontal",kind:"plain"},npc_speech:{direction:"horizontal",kind:"balloon"}}}
   onSavePage={async(content,prompt,items,baseline,sourceVersions)=>{
     localStorage.setItem('submitted-sources',JSON.stringify(sourceVersions));
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
createRoot(document.getElementById('root')!).render(<FeedbackProvider><Harness /></FeedbackProvider>);
