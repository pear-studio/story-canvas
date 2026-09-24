import type {ReactNode} from 'react';
import type {PagePrompt,WorkbenchPage,WorkbenchCharacter} from '../project-workbench-client';
export type ModelPageEditorProps = {
  projectId:string;page:WorkbenchPage;prompt:PagePrompt;onChange:(prompt:PagePrompt)=>void;
  characters:WorkbenchCharacter[];scenes:WorkbenchCharacter[];
  references:Array<{character_id:string;variant_id:string}>;
  onReferencesChange:(value:Array<{character_id:string;variant_id:string}>)=>void;
  disabled:boolean;rewrite?:ReactNode;onOpenOverview?:()=>void;
};
