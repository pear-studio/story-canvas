import type {ModelPageEditorProps,ModelUiAdapter} from '../types';
import {H3PageEditor} from './PageEditor';
import type {PagePromptDraft} from './types';

function PageEditor(props:ModelPageEditorProps) {
  return <H3PageEditor {...props} prompt={props.prompt as PagePromptDraft}/>;
}
export const h3UiAdapter = {
  id:'h3',label:'MiniMax H3',profileId:'minimax-h3',PageEditor,pageFrame:null,
} satisfies ModelUiAdapter;
