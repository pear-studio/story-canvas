import type {ModelOverviewEditorProps,ModelUiAdapter} from '../types';
import {H3OverviewEditor} from './OverviewEditor';
import type {PagePromptDraft} from './types';

function OverviewEditor(props:ModelOverviewEditorProps) {
  return <H3OverviewEditor {...props} prompt={props.prompt as PagePromptDraft}/>;
}
export const h3UiAdapter = {
  id:'h3',label:'MiniMax H3',profileId:'minimax-h3',PageEditor:OverviewEditor,OverviewEditor,pageFrame:null,
} satisfies ModelUiAdapter;
