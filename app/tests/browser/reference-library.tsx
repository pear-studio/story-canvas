import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReferenceLibrary } from '../../src/ReferenceLibrary';
import { FeedbackProvider } from '../../src/feedback';
import type { WorkbenchPage } from '../../src/project-workbench-client';
import '../../src/styles.css';
const pages = ['a','b'].map(page_id => ({page_id,title:page_id,variant_id:'day'} as WorkbenchPage));
function Harness(){ const [version,setVersion]=useState(0); return <FeedbackProvider><main style={{padding:20,maxWidth:900}}><button onClick={()=>setVersion(value=>value+1)}>模拟参考图外部更新</button><ReferenceLibrary sourceVersion={String(version)} projectId="test" target={location.search.includes('page') ? {kind:'page',id:'page-one'} : {kind:'character',id:'alice',variant_id:'day'}} pages={pages} onChanged={() => {}} /></main></FeedbackProvider>; }
createRoot(document.getElementById('root')!).render(<Harness />);
