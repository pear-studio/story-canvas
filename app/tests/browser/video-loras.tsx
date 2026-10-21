import {createRoot} from 'react-dom/client';
import {VideoPageWorkspace} from '../../src/VideoPageWorkspace';
import {FeedbackProvider} from '../../src/feedback';
import {acceptProjectSnapshot} from '../../src/project-write-client';
import type {WorkbenchPage} from '../../src/project-workbench-client';
import {StoryPagePreview} from '../../src/StoryPagePreview';
import '../../src/styles.css';

acceptProjectSnapshot('demo','revision');
const page={page_id:'page-video',page_key:{page_id:'page-video'},page_kind:'video',title:'树叶微风',model_id:'h3',render:{profile_id:'minimax-h3'},project_loras:[{filename:'motion.safetensors',sha256:'a'.repeat(64),weight:.6,trigger:'gentle_motion'}]} as WorkbenchPage;
const query=new URLSearchParams(location.search);
if(query.has('settings'))page.video_postprocess=JSON.parse(query.get('settings')!);
createRoot(document.getElementById('root')!).render(<FeedbackProvider>{query.has('overview')?<StoryPagePreview projectId="demo" page={page} onMediaChange={()=>{}}/>:<VideoPageWorkspace projectId="demo" page={page} pages={[page]} breadcrumb={['演示']} onReload={async()=>{}}/>}</FeedbackProvider>);
