import type { NavigationState } from './workbench-navigation';
import type { WorkbenchScope } from './project-workbench-client';

export function workbenchScope(navigation: NavigationState): WorkbenchScope {
  if (navigation.activeTab === 'project-story') {
    const target = navigation.overviewTarget;
    return { kind: 'story', ...(target?.kind === 'chapter' ? {chapter_id: target.id} : target?.kind === 'sequence' ? {sequence_id: target.id} : {}) };
  }
  if (navigation.activeTab === 'prompt-overview') return {kind: 'prompts'};
  if (navigation.activeTab === 'project-lettering') return {kind: 'lettering'};
  if (['story', 'characters', 'scenes', 'orphan-pages'].includes(navigation.activeTab) && navigation.activePageKey) return {kind:'page',page_id:navigation.activePageKey.page_id};
  if (navigation.activeTab === 'characters' && navigation.activeCharacterId) return {kind:'setting',setting_kind:'character',setting_id:navigation.activeCharacterId};
  if (navigation.activeTab === 'scenes' && navigation.sceneId) return {kind:'setting',setting_kind:'scene',setting_id:navigation.sceneId};
  return {kind:'directory'};
}
