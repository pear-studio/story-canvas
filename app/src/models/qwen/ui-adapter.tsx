import type {EditableWorkbenchCharacter,WorkbenchCharacter} from '../../project-workbench-client';
import type {ModelPageEditorProps,ModelSettingEditorProps,SettingModelUiAdapter} from '../types';
import {QwenPageEditor} from './PageEditor';
import {QwenSettingView} from './SettingView';
import type {CharacterPromptDocument,PagePromptDraft} from './types';

function projectSetting(value:WorkbenchCharacter):WorkbenchCharacter<CharacterPromptDocument> {
  return {...value,prompt:value.model_prompts?.models?.qwen};
}
function PageEditor(props:ModelPageEditorProps) {
  return <QwenPageEditor {...props} prompt={props.prompt as PagePromptDraft} characters={props.characters.map(projectSetting)} scenes={props.scenes.map(projectSetting)}/>;
}
function SettingEditor(props:ModelSettingEditorProps) {
  return <QwenSettingView {...props} character={props.character as EditableWorkbenchCharacter<CharacterPromptDocument>}/>;
}
export const qwenUiAdapter = {
  id:'qwen',label:'Qwen-Image-2.1',profileId:'qwen-image-2-1',PageEditor,
  pageFrame:{header:true},
  setting:{
    label:'Qwen',Editor:SettingEditor,
    createPrompt(name:string,variantIds:string[]):CharacterPromptDocument {
      return {prompt_name:name,variants:Object.fromEntries(variantIds.map(id=>[id,{text:'',reference_images:[]}]))};
    },
  },
} satisfies SettingModelUiAdapter;
