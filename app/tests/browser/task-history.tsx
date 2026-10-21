import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TaskCard,TaskResultViewer,type TaskPreview } from '../../src/TaskViews';
import type { GlobalTask } from '../../src/runtime-status';
import '../../src/styles.css';

function Fixture() {
  const [enabled, setEnabled] = useState(true);
  const [identity, setIdentity] = useState('');
  const [preview,setPreview]=useState<TaskPreview|null>(null);
  const tasks: GlobalTask[] = Array.from({ length: 30 }, (_, i) => ({
    id: i === 0 ? `task-0${identity}` : `task-${i}`, project_id: 'demo', project_title: '测试项目', purpose: 'candidate',
    status: 'completed', created_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:01:00Z',
    item_counts: { total: 1, available: 1, discarded: 0, skipped: 0, queued: 0, running: 0, failed: 0 },
    progress: null, pages: [],
  }));
  return <>
    <div style={{ position: 'fixed', top: 0, left: 0, zIndex: 1, background: 'white' }}>
      <button onClick={() => setEnabled(value => !value)}>开关结果</button>
      <button onClick={() => setIdentity('-changed')}>更换任务身份</button>
    </div>
    <div style={{ paddingTop: 60, maxWidth: 650 }} className="task-history-list">
      {tasks.map((task, i) => <TaskCard key={i} task={task} onOpen={() => {}} onPreview={setPreview} previewsEnabled={enabled} />)}
    </div>
    {preview&&<TaskResultViewer preview={preview} onClose={()=>setPreview(null)}/>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
