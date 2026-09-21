import { FeedbackProvider } from '../../src/feedback';
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import WorkbenchPageEditor from '../../src/WorkbenchPageEditor';
import '../../src/styles.css';
const style={font_family:'Microsoft YaHei',font_size:28,character_speech:{direction:'horizontal',kind:'balloon'},character_thought:{direction:'horizontal',kind:'plain'},npc_speech:{direction:'horizontal',kind:'balloon'}};
const initial={kind:'story',page_id:'page-001',page_key:{page_id:'page-001'},title:'爱心嵌字',scene_description:'',characters:[],content_sha256:'a',prompt_sha256:'b',prompt:{subject:[],person: [],setting:[],camera:[],avoid:[]},dialogue:[{id:'dialogue-111111111111',mode:'heart',text:'呜呜呜'},{id:'dialogue-222222222222',mode:'heart',text:'嗯嗯'},{id:'dialogue-333333333333',mode:'speech',speaker:'npc',text:'普通对白'}]};
function Harness(){
 const [page,setPage]=useState(()=>JSON.parse(localStorage.getItem('heart-page')||'null')||initial);
 const [items,setItems]=useState(()=>JSON.parse(localStorage.getItem('heart-items')||'null')||initial.dialogue.map((d,i)=>({dialogue_id:d.id,box:{x:.15,y:.12+i*.23,w:.4,h:.1},...(i<2?{heart:{font_size:48,rotation:-8,seed:703+i}}:{})})));
 const [target,setTarget]=useState<HTMLSpanElement|null>(null);
 return <div style={{display:'grid',gridTemplateColumns:'480px 640px',gap:24,padding:24}}>
  <WorkbenchPageEditor projectId="test" page={page} characters={[]} letteringStyle={style as any} letteringItems={items} letteringTarget={target}
   onSavePage={async (content,prompt,layout)=>{
    localStorage.setItem('content-saves',String(Number(localStorage.getItem('content-saves')||0)+1));
    if((new URLSearchParams(location.search).has('fail-content')||new URLSearchParams(location.search).has('fail-layout'))&&!localStorage.getItem('failed-once')){localStorage.setItem('failed-once','yes');throw new Error('整页写入暂时失败');}
    const idMap=new Map<string,string>();
    const saved={...content,dialogue:content.dialogue?.map(line=>{
      const id=line.id?.startsWith('dialogue-')?line.id:'dialogue-'+crypto.randomUUID().replaceAll('-','').slice(0,12);
      if(line.id)idMap.set(line.id,id);return {...line,id};
    })};
    const savedItems=layout.map(item=>({...item,dialogue_id:idMap.get(item.dialogue_id)??item.dialogue_id}));
    if(savedItems.some(item=>!saved.dialogue?.some(line=>line.id===item.dialogue_id)))throw new Error('布局引用了不存在的文案');
    const next={...page,...saved,prompt};setPage(next);setItems(savedItems);
    localStorage.setItem('heart-page',JSON.stringify(next));localStorage.setItem('heart-items',JSON.stringify(savedItems));
    return {page:next,content:saved,prompt,items:savedItems};
   }} />
  <div style={{position:'relative',width:640,height:960,background:'linear-gradient(135deg,#b0a0b8,#675e80)'}}><span ref={setTarget} style={{position:'absolute',inset:0}} /></div>
 </div>;
}
createRoot(document.getElementById('root')!).render(<FeedbackProvider><Harness /></FeedbackProvider>);
