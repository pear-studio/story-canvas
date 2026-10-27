import {settingLoras} from '../../../shared/lora-inheritance.mjs';
import type {EditableWorkbenchCharacter,WorkbenchCharacter} from '../../project-workbench-client';
import type {ModelPageEditorProps,ModelSettingEditorProps,SettingModelUiAdapter} from '../types';
import {AnimaPageEditor} from './PageEditor';
import {AnimaSettingView} from './SettingView';
import type {CharacterPromptDocument,PagePrompt,PagePromptDraft} from './types';

function projectSetting(value:WorkbenchCharacter):WorkbenchCharacter<CharacterPromptDocument> {
  return {...value,prompt:value.model_prompts?.models?.anima};
}
function settingLoraFilenames(props:ModelPageEditorProps) {
  const prompt=props.prompt as PagePromptDraft;
  return [
    ...props.references.flatMap(ref=>{const input=props.characters.find(c=>c.id===ref.character_id)?.model_prompts?.models?.anima;return input?settingLoras(input.identity,input.variants[ref.variant_id]).map(lora=>lora.filename):[];}),
    ...props.scenes.filter(c=>c.id===prompt.scene_id).flatMap(c=>{const input=c.model_prompts?.models?.anima;return input?settingLoras(input.identity,input.variants[prompt.scene_variant_id??'']).map(lora=>lora.filename):[];}),
  ];
}
function PageEditor(props:ModelPageEditorProps) {
  return <AnimaPageEditor {...props} prompt={props.prompt as PagePromptDraft} characters={props.characters.map(projectSetting)} scenes={props.scenes.map(projectSetting)}/>;
}
function SettingEditor(props:ModelSettingEditorProps) {
  return <AnimaSettingView {...props} character={props.character as EditableWorkbenchCharacter<CharacterPromptDocument>}/>;
}
function emptyPrompt():PagePrompt {
  return {population:[],person:[],setting:[],camera:[],avoid:[]};
}
export const animaUiAdapter = {
  id:'anima',label:'Anima Basic',profileId:'anima-base-v1',PageEditor,
  pageFrame:{header:false,settingLoraFilenames},
  setting:{
    label:'Anima',Editor:SettingEditor,
    createPrompt(_name:string,variantIds:string[]):CharacterPromptDocument {
      return {identity:{prompt:emptyPrompt(),lora:null},variants:Object.fromEntries(variantIds.map(id=>[id,{prompt:emptyPrompt(),loras:[]}]))};
    },
  },
} satisfies SettingModelUiAdapter;
