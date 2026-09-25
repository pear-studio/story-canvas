import {useState} from 'react';
import {Modal} from '../Modal';
import {ResourcePicker,ResourcePreview,ResourceDetailsButton,loraResourceCatalogItem,rawLoraCatalogItem,type LoraResourceDefinition} from '../ResourceCatalog';
import {useProjectLoraResources,rawLoraResourceDefinition} from '../use-lora-resources';
import {mergeInheritedLoras,type Lora,type LoraOverrides} from '../../shared/lora-inheritance.mjs';

type Props={projectId:string;profileId?:string;title:string;inherited?:Lora[];value:Lora[];overrides?:LoraOverrides;onChange:(value:Lora[],overrides:LoraOverrides)=>void;disabled:boolean;allowAdd?:boolean;single?:boolean;collapseInherited?:boolean};
export function LoraListEditor({projectId,profileId,title,inherited=[],value,overrides={},onChange,disabled,allowAdd=true,single=false,collapseInherited=false}:Props) {
  const [open,setOpen]=useState(false);
  const {list,compatibility,error}=useProjectLoraResources(projectId,profileId);
  const loras=mergeInheritedLoras(inherited,value,overrides), inheritedNames=new Set(inherited.map(lora=>lora.filename));
  function patch(lora:Lora,change:Partial<Pick<Lora,'weight'|'enabled'>>) {
    if(inheritedNames.has(lora.filename)||change.enabled!==undefined)onChange(value,{...overrides,[lora.filename]:{...overrides[lora.filename],...change}});
    else onChange(value.map(item=>item.filename===lora.filename?{...item,...change}:item),overrides);
  }
  function remove(lora:Lora) {const next={...overrides};delete next[lora.filename];onChange(value.filter(item=>item.filename!==lora.filename),next);}
  const choices=[...(list?.resources??[]).filter(entry=>entry.resource.architecture.family===compatibility?.architectureFamily).map(entry=>({item:loraResourceCatalogItem(entry),resource:entry.resource})),...(list?.raw??[]).map(raw=>({item:rawLoraCatalogItem(raw),resource:rawLoraResourceDefinition(raw,compatibility)}))].filter(({resource})=>!loras.some(lora=>lora.sha256===resource.file.sha256));
  function add(resource:LoraResourceDefinition) {const weight=resource.recommended_generation.weight.default??1,trigger=resource.activation.trigger_words.join(', ').trim();const next={filename:resource.file.relative_path.replace(/^loras\//,''),sha256:resource.file.sha256,weight:Math.max(-2,Math.min(2,weight)),...(trigger?{trigger}:{})};onChange(single?[next]:[...value,next],overrides);setOpen(false);}
  function row(lora:Lora) {
    const isInherited=inheritedNames.has(lora.filename),adjusted=isInherited&&(!!overrides[lora.filename]||value.some(item=>item.filename===lora.filename));
    const registered=list?.resources.find(entry=>entry.resource.file.sha256===lora.sha256),item=registered?loraResourceCatalogItem(registered):null;
    return <article key={lora.filename} className={lora.enabled===false?'is-disabled':''}>{item&&<ResourcePreview compact images={item.previewImages} placeholder="LoRA"/>}<div className="project-lora-current__body"><header><label>{(!single||isInherited)&&<input type="checkbox" aria-label={`启用 ${item?.name??lora.filename}`} checked={lora.enabled!==false} disabled={disabled} onChange={event=>patch(lora,{enabled:event.target.checked})}/>} {item?.name??lora.filename}</label>{item&&<ResourceDetailsButton item={item}/>}</header><small>{isInherited?adjusted?'继承 LoRA · 本层已覆盖':'继承 LoRA':'本层 LoRA'}</small><footer><label>权重<input type="number" min="-2" max="2" step="0.05" value={lora.weight} disabled={disabled} onChange={event=>{const weight=event.target.valueAsNumber;if(Number.isFinite(weight)&&weight>=-2&&weight<=2)patch(lora,{weight});}}/></label>{(!isInherited||adjusted)&&<button type="button" className="button button--quiet" disabled={disabled} onClick={()=>remove(lora)}>{isInherited?'恢复继承':'移除'}</button>}</footer>{lora.trigger&&<small>触发词：{lora.trigger}</small>}</div></article>;
  }
  const inheritedRows=loras.filter(lora=>inheritedNames.has(lora.filename));
  return <section className="page-loras" aria-label={title}><div className="section-header"><h4>{title}</h4>{allowAdd&&<button type="button" className="button button--quiet" disabled={disabled} onClick={()=>setOpen(true)}>{single&&value.length?'替换 LoRA':'添加 LoRA'}</button>}</div>{inheritedRows.length>0&&(collapseInherited?<details><summary>继承的项目 LoRA · {inheritedRows.length} 项</summary><div className="project-lora-current-list">{inheritedRows.map(row)}</div></details>:<div className="project-lora-current-list">{inheritedRows.map(row)}</div>)}<div className="project-lora-current-list">{loras.filter(lora=>!inheritedNames.has(lora.filename)).map(row)}</div>{open&&<Modal size="workspace" title="选择 LoRA" onClose={()=>setOpen(false)} ariaLabel="选择 LoRA"><div className="lora-picker-body">{error?<p role="alert">{error}</p>:!list?<p>正在读取资源…</p>:<ResourcePicker items={choices.map(value=>value.item)} empty="没有可添加的 LoRA" onSelect={item=>{const choice=choices.find(value=>value.item.id===item.id);if(choice)add(choice.resource);}}/>}</div></Modal>}</section>;
}
