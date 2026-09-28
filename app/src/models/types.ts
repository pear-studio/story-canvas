import type {ReactNode} from 'react';
import type {PagePrompt,WorkbenchPage,WorkbenchCharacter} from '../project-workbench-client';
export type ModelSettingEditorProps={kind?:'character'|'scene';projectId:string;character:WorkbenchCharacter;initialSettingId:string;busy:boolean;onSaved:(replacement:Partial<WorkbenchCharacter>)=>void;onSettingChange?:(settingId:string)=>void;onDirtyChange?:(dirty:boolean)=>void};
export type ModelPageEditorProps = {
  projectId:string;page:WorkbenchPage;prompt:PagePrompt;onChange:(prompt:PagePrompt)=>void;
  characters:WorkbenchCharacter[];scenes:WorkbenchCharacter[];
  references:Array<{character_id:string;variant_id:string}>;
  onReferencesChange:(value:Array<{character_id:string;variant_id:string}>)=>void;
  header?:ReactNode;disabled:boolean;rewrite?:ReactNode;onOpenOverview?:()=>void;
};
