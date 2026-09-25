import type {PagePrompt,WorkbenchPage} from '../project-workbench-client';
import {LoraListEditor} from './LoraListEditor';
export function PageLoraEditor({projectId,page,prompt,onChange,disabled,settingFilenames=[]}:{projectId:string;page:WorkbenchPage;prompt:PagePrompt;onChange:(prompt:PagePrompt)=>void;disabled:boolean;settingFilenames?:string[]}) {
  const local=prompt.loras??[],hidden=new Set(settingFilenames);
  return <LoraListEditor projectId={projectId} profileId={page.render?.profile_id} title="本页 LoRA" inherited={(page.project_loras??[]).filter(lora=>!hidden.has(lora.filename))} value={local.filter(lora=>!hidden.has(lora.filename))} overrides={prompt.lora_overrides} disabled={disabled} collapseInherited onChange={(value,lora_overrides)=>onChange({...prompt,loras:[...local.filter(lora=>hidden.has(lora.filename)),...value],lora_overrides})}/>;
}
