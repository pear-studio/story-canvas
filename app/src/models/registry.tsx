import {useState} from 'react';
import {saveSettingPrompt,type EditableWorkbenchCharacter as WorkbenchCharacter} from '../project-workbench-client';
import {animaUiAdapter} from './anima/ui-adapter';
import {qwenUiAdapter} from './qwen/ui-adapter';
import {h3UiAdapter} from './h3/ui-adapter';
import {mossUiAdapter} from './moss/ui-adapter';
import {PagePromptFrame} from './PagePromptFrame';
import type {GenerationModelId,PromptModelId} from './prompt-types';
import type {ModelPageEditorProps,ModelSettingEditorProps,ModelUiAdapter} from './types';

const models={anima:animaUiAdapter,qwen:qwenUiAdapter,h3:h3UiAdapter,moss:mossUiAdapter} satisfies Record<GenerationModelId,ModelUiAdapter>;
const settingModels={anima:models.anima,qwen:models.qwen,moss:models.moss};
export const modelChoices=Object.values(settingModels).map(({id,label,profileId})=>({id,label,profileId}));
export const generationModelLabel=(id:GenerationModelId)=>models[id].label;

export function ModelSettingEditor(props:ModelSettingEditorProps) {
  const [selection,setSelection]=useState<{id:string;model:PromptModelId}|null>(null);
  const modelId=selection?.id===props.character.id?selection.model:props.character.model_id;
  const [dirty,setDirty]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const input=props.character.model_prompts?.models?.[modelId];
  const adapter=settingModels[modelId].setting;
  const Editor=adapter.Editor;
  const character={...props.character,model_id:modelId,prompt:input} as WorkbenchCharacter;
  async function enable() {
    setSaving(true);setError('');
    const prompt=adapter.createPrompt(props.character.name,props.character.visual.variants.map(v=>v.id));
    try {const result=await saveSettingPrompt(props.kind??'character',props.projectId,{...character,prompt},prompt);props.onSaved({...result,model_id:modelId} as Partial<WorkbenchCharacter>);}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}
  }
  return <><div className="prompt-camera-actions"><label>设定模型 <select aria-label="设定模型" disabled={props.busy||saving||dirty} value={modelId} onChange={event=>{setSelection({id:props.character.id,model:event.target.value as PromptModelId});setError('');}}>{modelChoices.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>{dirty&&<small>请先保存当前修改再切换模型</small>}</div>{input?<Editor key={`${props.projectId}:${props.kind ?? 'character'}:${character.id}:${modelId}`} {...props} character={character} onDirtyChange={setDirty}/>:<div className="setting-section"><p>此模型尚未配置设定。创建后可为各个子设定编写对应模型的描述。</p><button className="button" disabled={props.busy||saving} onClick={()=>void enable()}>创建 {adapter.label} 设定</button>{error&&<p role="alert">{error}</p>}</div>}</>;
}
export function ModelPromptEditor(props:ModelPageEditorProps) {
  const adapter:ModelUiAdapter=models[props.page.model_id];
  const Editor=adapter.PageEditor;
  if(!adapter.pageFrame)return <Editor {...props}/>;
  return <PagePromptFrame {...props} settingFilenames={adapter.pageFrame.settingLoraFilenames?.(props)}>{adapter.pageFrame.header&&props.header}<Editor {...props}/></PagePromptFrame>;
}
