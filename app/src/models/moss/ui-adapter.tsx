import {settingLoras} from '../../../shared/lora-inheritance.mjs';
import {emptyMossPrompt,mossPageCategories,mossLabels} from '../../../shared/moss-prompt.mjs';
import type {EditableWorkbenchCharacter,WorkbenchCharacter} from '../../project-workbench-client';
import type {ModelPageEditorProps,ModelSettingEditorProps,ModelOverviewEditorProps,SettingModelUiAdapter} from '../types';
import {MossPageEditor} from './PageEditor';
import {MossProjectDescriptions} from './ProjectDescriptions';
import {MossSettingView} from './SettingView';
import {MossCategoriesEditor} from './EntriesEditor';
import type {PagePromptDraft,CharacterPromptDocument} from './types';

function projectSetting(value:WorkbenchCharacter):WorkbenchCharacter<CharacterPromptDocument>{return {...value,prompt:value.model_prompts?.models?.moss};}
function PageEditor(props:ModelPageEditorProps){return <MossPageEditor {...props} prompt={props.prompt as PagePromptDraft} characters={props.characters.map(projectSetting)} scenes={props.scenes.map(projectSetting)}/>;}
function OverviewEditor(props:ModelOverviewEditorProps){const prompt=props.prompt as PagePromptDraft;return <><MossCategoriesEditor categories={mossPageCategories.map(id=>({id,label:mossLabels[id]}))} value={Object.fromEntries(mossPageCategories.map(id=>[id,prompt[id]??[]]))} scopeKey={`${props.page.page_id}:overview`} disabled={props.disabled} roles={(props.page.characters??[]).map(ref=>({id:ref.character_id,label:ref.character_id}))} onChange={value=>props.onChange({...emptyMossPrompt(),...prompt,...value})}/><MossProjectDescriptions prompt={prompt} projectPrompt={props.page.model_project_prompt} scopeKey={`${props.page.page_id}:overview`} disabled={props.disabled} onChange={props.onChange}/></>;}
function SettingEditor(props:ModelSettingEditorProps){return <MossSettingView {...props} character={props.character as EditableWorkbenchCharacter<CharacterPromptDocument>}/>;}
function settingLoraFilenames(props:ModelPageEditorProps){const prompt=props.prompt as PagePromptDraft;return [...props.references.flatMap(ref=>{const input=props.characters.find(c=>c.id===ref.character_id)?.model_prompts?.models?.moss;return input?settingLoras(input.identity,input.variants[ref.variant_id]).map(lora=>lora.filename):[];}),...props.scenes.filter(scene=>scene.id===prompt.scene_id).flatMap(scene=>{const input=scene.model_prompts?.models?.moss;return input?settingLoras(input.identity,input.variants[prompt.scene_variant_id??'']).map(lora=>lora.filename):[];})];}
export const mossUiAdapter={id:'moss',label:'MOSS',profileId:'moss-image',PageEditor,OverviewEditor,pageFrame:{header:false,settingLoraFilenames},setting:{label:'MOSS',Editor:SettingEditor,createPrompt(name:string,variantIds:string[]):CharacterPromptDocument{return {prompt_name:name,identity:{lora:null},variants:Object.fromEntries(variantIds.map(id=>[id,{entries:[],loras:[]}]))};}}} satisfies SettingModelUiAdapter;
