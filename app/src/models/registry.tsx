import {useState} from 'react';
import {AnimaPageEditor} from './anima/PageEditor';
import {QwenPageEditor} from './qwen/PageEditor';
import type {ModelPageEditorProps,ModelSettingEditorProps} from './types';
import {AnimaSettingView} from './anima/SettingView';
import {QwenSettingView} from './qwen/SettingView';
import type {CharacterPromptDocument as AnimaPrompt} from './anima/types';
import {saveSettingPrompt,type WorkbenchCharacter} from '../project-workbench-client';
import {PageLoraEditor} from './PageLoraEditor';
import {AnimaOverviewEditor,QwenOverviewEditor} from './OverviewEditor';
const AnimaSettingEditor=(props:ModelSettingEditorProps)=><AnimaSettingView {...props} character={props.character as unknown as WorkbenchCharacter<AnimaPrompt>} onSaved={value=>props.onSaved(value as unknown as Partial<WorkbenchCharacter>)}/>;
const models={anima:{PageEditor:AnimaPageEditor,OverviewEditor:AnimaOverviewEditor,SettingEditor:AnimaSettingEditor},qwen:{PageEditor:QwenPageEditor,OverviewEditor:QwenOverviewEditor,SettingEditor:QwenSettingView}};
export function ModelSettingEditor(props:ModelSettingEditorProps) {
  const [selection,setSelection]=useState<{id:string;model:'anima'|'qwen'}|null>(null);
  const modelId=selection?.id===props.character.id?selection.model:props.character.model_id??'qwen';
  const [dirty,setDirty]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const input=props.character.model_prompts?.models?.[modelId]??((props.character.model_id??'qwen')===modelId?props.character.prompt:undefined);
  const Editor=models[modelId].SettingEditor;
  const character={...props.character,model_id:modelId,prompt:input} as WorkbenchCharacter;
  async function enable() {
    setSaving(true);setError('');
    const empty=()=>({subject:[],person:[],setting:[],camera:[],avoid:[]});
    const prompt=modelId==='anima'?{identity:{prompt:empty(),lora:null},variants:Object.fromEntries(props.character.visual.variants.map(v=>[v.id,{prompt:empty(),loras:[],identity_disabled:[]}]))}:{prompt_name:props.character.name,variants:Object.fromEntries(props.character.visual.variants.map(v=>[v.id,{text:'',reference_images:[]}]))};
    try {const result=await saveSettingPrompt(props.kind??'character',props.projectId,{...character,prompt},prompt);props.onSaved({...result,model_id:modelId} as Partial<WorkbenchCharacter>);}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}
  }
  return <><div className="prompt-camera-actions"><label>设定模型 <select aria-label="设定模型" disabled={props.busy||saving||dirty} value={modelId} onChange={event=>{setSelection({id:props.character.id,model:event.target.value as 'anima'|'qwen'});setError('');}}>{modelChoices.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>{dirty&&<small>请先保存当前修改再切换模型</small>}</div>{input?<Editor key={`${character.id}:${modelId}`} {...props} character={character} onDirtyChange={setDirty}/>:<div className="setting-section"><p>此模型尚未配置设定。Qwen 页面从 Anima 带入全文时无需维护这份设定。</p><button className="button" disabled={props.busy||saving} onClick={()=>void enable()}>创建{modelId==='anima'?' Anima':' Qwen'} 设定</button>{error&&<p role="alert">{error}</p>}</div>}</>;
}
export function ModelOverviewEditor(props:Parameters<typeof QwenOverviewEditor>[0]) {
  const Editor=models[props.page.model_id??'qwen'].OverviewEditor;
  return <Editor {...props}/>;
}
export const modelChoices=[{id:'anima',label:'Anima Basic',profileId:'anima-base-v1'},{id:'qwen',label:'Qwen-Image-2.1',profileId:'qwen-image-2-1'}] as const;
export function ModelPromptEditor(props:ModelPageEditorProps) {
  const adapter=models[props.page.model_id??'qwen'];
  const projectSetting=(value:WorkbenchCharacter)=>({...value,prompt:value.model_prompts?.models?.[props.page.model_id??'qwen']??value.prompt}) as WorkbenchCharacter;
  return <><PageLoraEditor projectId={props.projectId} page={props.page} prompt={props.prompt} onChange={props.onChange} disabled={props.disabled}/><adapter.PageEditor {...props} characters={props.characters.map(projectSetting)} scenes={props.scenes.map(projectSetting)}/></>;
}
