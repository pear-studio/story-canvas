import type {PageRewriteController} from './qwen/usePageRewrite';
import type {ComponentType,ReactNode} from 'react';
import type {EditableWorkbenchCharacter,PagePrompt,WorkbenchPage,WorkbenchCharacter} from '../project-workbench-client';
import type {GenerationModelId,PromptModelId,SettingPrompt} from './prompt-types';
export type ModelSettingEditorProps<TSetting=SettingPrompt>={kind?:'character'|'scene';projectId:string;character:EditableWorkbenchCharacter<TSetting>;initialSettingId:string;busy:boolean;onSaved:(replacement:Partial<WorkbenchCharacter<TSetting>>)=>void;onSettingChange?:(settingId:string)=>void;onDirtyChange?:(dirty:boolean)=>void};
export type ModelPageEditorProps<TPrompt extends PagePrompt=PagePrompt,TSetting=SettingPrompt> = {
  projectId:string;page:WorkbenchPage;prompt:TPrompt;onChange:(prompt:TPrompt)=>void;
  characters:WorkbenchCharacter<TSetting>[];scenes:WorkbenchCharacter<TSetting>[];
  references:Array<{character_id:string;variant_id:string}>;
  onReferencesChange:(value:Array<{character_id:string;variant_id:string}>)=>void;
  header?:ReactNode;disabled:boolean;qwenRewrite?:PageRewriteController;dirty?:boolean;
};
export type SettingUiAdapter = {
  label:string;
  Editor:ComponentType<ModelSettingEditorProps>;
  createPrompt:(name:string,variantIds:string[])=>SettingPrompt;
};
export type ModelUiAdapter = {
  id:GenerationModelId;
  label:string;
  profileId:string;
  PageEditor:ComponentType<ModelPageEditorProps>;
  pageFrame:{header:boolean;settingLoraFilenames?:(props:ModelPageEditorProps)=>string[]}|null;
  setting?:SettingUiAdapter;
};
export type SettingModelUiAdapter = ModelUiAdapter & {id:PromptModelId;setting:SettingUiAdapter};
