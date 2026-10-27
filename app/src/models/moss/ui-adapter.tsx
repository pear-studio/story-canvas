import {settingLoras} from '../../../shared/lora-inheritance.mjs';
import type {EditableWorkbenchCharacter,WorkbenchCharacter} from '../../project-workbench-client';
import type {ModelPageEditorProps,ModelSettingEditorProps,SettingModelUiAdapter} from '../types';
import {MossPageEditor} from './PageEditor';
import {MossSettingView} from './SettingView';
import type {PagePromptDraft,CharacterPromptDocument} from './types';

function projectSetting(value:WorkbenchCharacter):WorkbenchCharacter<CharacterPromptDocument>{return {...value,prompt:value.model_prompts?.models?.moss};}
function PageEditor(props:ModelPageEditorProps){return <MossPageEditor {...props} prompt={props.prompt as PagePromptDraft} characters={props.characters.map(projectSetting)} scenes={props.scenes.map(projectSetting)}/>;}
function SettingEditor(props:ModelSettingEditorProps){return <MossSettingView {...props} character={props.character as EditableWorkbenchCharacter<CharacterPromptDocument>}/>;}
function settingLoraFilenames(props:ModelPageEditorProps){const prompt=props.prompt as PagePromptDraft;return [...props.references.flatMap(ref=>{const input=props.characters.find(c=>c.id===ref.character_id)?.model_prompts?.models?.moss;return input?settingLoras(input.identity,input.variants[ref.variant_id]).map(lora=>lora.filename):[];}),...props.scenes.filter(scene=>scene.id===prompt.scene_id).flatMap(scene=>{const input=scene.model_prompts?.models?.moss;return input?settingLoras(input.identity,input.variants[prompt.scene_variant_id??'']).map(lora=>lora.filename):[];})];}
export const mossUiAdapter={id:'moss',label:'MOSS',profileId:'moss-image',PageEditor,pageFrame:{header:false,settingLoraFilenames},setting:{label:'MOSS',Editor:SettingEditor,createPrompt(name:string,variantIds:string[]):CharacterPromptDocument{return {prompt_name:name,identity:{lora:null},variants:Object.fromEntries(variantIds.map(id=>[id,{entries:[],loras:[]}]))};}}} satisfies SettingModelUiAdapter;
