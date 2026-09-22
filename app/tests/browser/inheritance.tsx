import { StoryCandidateRefresh } from '../../src/StoryCandidateRefresh';
import type { WorkbenchCharacter, WorkbenchPage } from '../../src/project-workbench-client';
import { SceneReferenceEditor } from '../../src/SceneReferenceEditor';
import WorkbenchPageEditor from '../../src/WorkbenchPageEditor';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import { FeedbackProvider, useFeedback } from '../../src/feedback';

const sceneSetting = (id: string, name: string): WorkbenchCharacter => ({
  id, name, description: '', profile_sha256: 'profile', visual_sha256: 'visual', prompt_sha256: 'prompt', style: null, pages: [],
  visual: { variants: [{ id: 'default', name: '默认' }] },
  prompt: { prompt_name: name, variants: { default: { text: `${name}的环境描述` } } },
});
const characterSetting = (id: string, name: string, dayText: string): WorkbenchCharacter => ({
  id, name, description: '', profile_sha256: 'profile', visual_sha256: 'visual', prompt_sha256: 'prompt', style: null, pages: [],
  visual: { variants: [{ id: 'day', name: '白天' }, { id: 'night', name: '夜晚' }] },
  prompt: { prompt_name: name, variants: { day: { text: dayText }, night: { text: `${name}夜晚的描述` } } },
});

function SceneHarness() {
  const [scene, setScene] = useState<string | undefined>('steel');
  const [variant, setVariant] = useState<string | undefined>('default');
  return <main style={{ width: 900, margin: '40px auto' }}>
    <div className="participant-editor"><span>场景设定</span><SceneReferenceEditor scenes={[sceneSetting('steel', '冷蓝灰钢墙'), sceneSetting('space', '暗紫星空')]} value={scene} variantId={variant} onChange={(id, variantId) => { setScene(id); setVariant(variantId); }} /></div>
  </main>;
}

/** 整段 override：编辑继承框即成为本页 override，恢复继承删除 key，切换子设定清理。 */
function OverrideHarness() {
  const [upstream, setUpstream] = useState('艾莲白天的上游描述');
  const alice = characterSetting('alice', '艾莲', upstream);
  const initial: WorkbenchPage = {
    kind: 'story', page_id: 'page-fixture', page_key: { page_id: 'page-fixture' }, title: '覆盖验证页', scene_description: '',
    characters: [{ character_id: 'alice', variant_id: 'day' }], dialogue: [], content_sha256: 'content', prompt_sha256: 'prompt', prompt_context_sha256: 'context', layout_sha256: 'layout',
    prompt: { text: '', text_overrides: {}, reference_overrides: {} },
  } as WorkbenchPage;
  const [page, setPage] = useState(initial);
  return <main style={{ width: 900, margin: '40px auto' }}>
    <button onClick={() => setUpstream('艾莲白天的新上游描述')}>模拟上游文字更新</button>
    <WorkbenchPageEditor projectId="test" page={page} characters={[alice]} scenes={[]}
      onSavePage={async (content, prompt, items) => {
        const savedPage = { ...page, ...content, prompt, prompt_sha256: crypto.randomUUID() } as WorkbenchPage;
        const result = { page: savedPage, content, prompt, items };
        localStorage.setItem('saved-page', JSON.stringify(result));
        setPage(savedPage);
        return result;
      }} />
  </main>;
}

function FeedbackHarness() {
  const { notify } = useFeedback();
  return <><button onClick={() => notify({ kind: 'error', message: '重复词：hair_over_one_eye。请删除本地重复词，在继承区调整权重和开关。' })}>触发错误</button>
    <button onClick={() => notify({ kind: 'info', message: '第一项详细结果\n第二项详细结果' })}>触发复杂信息</button>
    <button onClick={() => notify({ kind: 'success', message: '已保存' })}>触发成功</button></>;
}
const query = location.search;
createRoot(document.getElementById('root')!).render(<FeedbackProvider>{query.includes('candidates') ? <StoryCandidateRefresh projectId="demo" busy={false} pages={['empty', 'changed'].map(id => ({ page_id: id, title: id === 'empty' ? '没有候选的页面' : '有变化的页面', page_key: { page_id: id } } as WorkbenchPage))} /> : query.includes('feedback') ? <FeedbackHarness /> : query.includes('override') ? <OverrideHarness /> : <SceneHarness />}</FeedbackProvider>);
