import { pageKeyId } from './page-key.ts';
import type { NavigationState } from './workbench-navigation.ts';

export type NavigationHistory = { entries: NavigationState[]; index: number };
export function navigationIdentity(state: NavigationState) {
  return JSON.stringify([state.projectId, state.activeTab, state.activePageKey && pageKeyId(state.activePageKey), state.activeCharacterId, state.activeCharacterSettingId,
    state.activeTab === 'scenes' ? state.sceneId : null, state.activeTab === 'scenes' ? state.sceneSettingId : null,
    state.activeTab === 'project-story' ? state.overviewTarget?.kind : null,
    state.activeTab === 'project-story' && state.overviewTarget?.kind !== 'overview' ? state.overviewTarget?.id : null]);
}
export function rememberNavigation(history: NavigationHistory, next: NavigationState, replace = false): NavigationHistory {
  if (next.activeTab === 'comparison' || next.activeTab.startsWith('lora-') || next.activeTab.startsWith('resource-')) return history;
  const current = history.entries[history.index];
  if (!current || current.projectId !== next.projectId) return { entries: [next], index: 0 };
  if (replace || navigationIdentity(current) === navigationIdentity(next)) {
    const entries = [...history.entries]; entries[history.index] = next;
    return { entries, index: history.index };
  }
  return { entries: [...history.entries.slice(0, history.index + 1), next], index: history.index + 1 };
}

export type NavigationSection = 'settings' | 'story' | 'output' | 'auxiliary';
export function navigationSection(tab: string): NavigationSection | null {
  if (tab === 'characters' || tab === 'scenes' || tab === 'orphan-pages') return 'settings';
  if (['story', 'project-story', 'prompt-overview'].includes(tab)) return 'story';
  if (['finished', 'project-lettering'].includes(tab)) return 'output';
  return null;
}
