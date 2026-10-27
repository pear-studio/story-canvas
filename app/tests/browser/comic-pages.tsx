import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PageWorkspace} from '../../src/App';
import {FeedbackProvider} from '../../src/feedback';
const defaultLetteringSettings=()=>({font_family:'Microsoft YaHei',font_size:28,character_colors:{},character_speech:{direction:'horizontal' as const,kind:'balloon' as const},character_thought:{direction:'horizontal' as const,kind:'plain' as const},npc_speech:{direction:'horizontal' as const,kind:'balloon' as const}});
import type {EditableWorkbenchPage} from '../../src/project-workbench-client';
import '../../src/styles.css';
const ids=['page-001','page-002'];
const panels=ids.map((id,index)=>({page_id:id,page_key:{page_id:id},kind:'story',title:`镜头 ${index+1}`,scene_description:`画面 ${index+1}`,model_id:'qwen',render:{version:1,model_id:'qwen',profile_id:'qwen-image-2-1',canvas:'2:3'},render_sha256:'render',characters:[],dialogue:[{id:`dialogue-${String(index+1).padStart(12,'0')}`,mode:'speech',speaker:'npc',text:`对白 ${index+1}`}],content_sha256:`content-${id}`,prompt:{text:`Prompt ${index+1}`},prompt_sha256:`prompt-${id}`,prompt_context_sha256:'context',layout_sha256:'layout',lettering:{page:id,items:[{dialogue_id:`dialogue-${String(index+1).padStart(12,'0')}`,box:{x:.1,y:index===0?.85:.1,w:.5,h:.2}}]},...(index?{parent_page_id:ids[0]}:{})})) as EditableWorkbenchPage[];
const initial={...panels[0],comic:{document:{version:1,canvas:'2:3',margin:16,gutter:12,layout:{id:'split-123456789abc',axis:'y',ratio:.5,first:{page_id:ids[0]},second:{page_id:ids[1]}},order:ids,panels:Object.fromEntries(ids.map(id=>[id,{candidate_id:'candidate-11111111-1111-4111-8111-111111111111',crop:{x:.5,y:.5,zoom:1},size_mode:'panel'}]))},sha256:'comic-version',panels}} as EditableWorkbenchPage;
if(new URLSearchParams(location.search).has('landscape'))initial.comic!.document.canvas='4:3';
if(new URLSearchParams(location.search).has('hearts'))for(const [index,panel] of initial.comic!.panels.entries()){
   panel.dialogue=[...panel.dialogue!,{id:'dialogue-'+String(index+10).padStart(12,'0'),mode:'heart',text:'爱心'}];
   panel.lettering!.items.push({dialogue_id:panel.dialogue[1].id,box:{x:.4,y:.4,w:.2,h:.1},heart:{font_size:48,seed:123,rotation:0}});
 }
function Harness(){
  const [page,setPage]=useState(initial),[tab,setTab]=useState<'visual'|'lettering'|'flow'>('visual');
  return <div className="workbench-shell--page" style={{height:'100dvh','--story-editor-width':'44%'} as React.CSSProperties}><main className="project-main" style={{height:'100dvh'}}> <PageWorkspace projectId="test" location={{page,key:page.page_id,breadcrumb:['测试',page.title]}} ownerPages={[]} characters={[]} scenes={[]} renderCapabilities={{candidates:{available:true,counts:[1,3]}}} defaultRenderProfile="qwen-image-2-1" canvas="2:3" letteringStyle={defaultLetteringSettings()} taskCollection={{tasks:[],history:[]}} busy={false} editorWidth={44} candidateWidth={200} pageOrder={1} editorTab={tab} onEditorTabChange={setTab} onOpenLetteringSettings={()=>{}} onEditorWidthChange={()=>{}} onCandidateWidthChange={()=>{}} onPageChanged={(_source,patch)=>setPage(value=>({...value,...patch}))} onReload={async()=>{}} onTrackedTasksChange={()=>{}}/></main></div>;
}
createRoot(document.getElementById('root')!).render(<FeedbackProvider><Harness/></FeedbackProvider>);
