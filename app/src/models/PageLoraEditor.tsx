import {useState} from 'react';
import {Modal} from '../Modal';
import {ResourcePicker,ResourcePreview,ResourceDetailsButton,loraResourceCatalogItem,rawLoraCatalogItem,type LoraResourceDefinition} from '../ResourceCatalog';
import {useProjectLoraResources,rawLoraResourceDefinition} from '../use-lora-resources';
import type {PagePrompt,WorkbenchPage} from '../project-workbench-client';

export function PageLoraEditor({projectId,page,prompt,onChange,disabled}:{projectId:string;page:WorkbenchPage;prompt:PagePrompt;onChange:(prompt:PagePrompt)=>void;disabled:boolean}) {
  const [open,setOpen]=useState(false);
  const {list,compatibility,error}=useProjectLoraResources(projectId,page.render?.profile_id);
  const loras=prompt.loras??[];
  const choices=[...(list?.resources??[]).filter(entry=>entry.resource.architecture.family===compatibility?.architectureFamily).map(entry=>({item:loraResourceCatalogItem(entry),resource:entry.resource})),...(list?.raw??[]).map(raw=>({item:rawLoraCatalogItem(raw),resource:rawLoraResourceDefinition(raw,compatibility)}))].filter(({resource})=>!loras.some(lora=>lora.sha256===resource.file.sha256));
  function update(next:NonNullable<PagePrompt['loras']>) {
    onChange({...prompt,loras:next});
  }
  function add(resource:LoraResourceDefinition) {
    const weight=resource.recommended_generation.weight.default??1;
    const trigger=resource.activation.trigger_words.join(', ').trim();
    update([...loras,{filename:resource.file.relative_path.replace(/^loras\//,''),sha256:resource.file.sha256,weight:Math.max(-2,Math.min(2,weight)),...(trigger?{trigger}:{})}]);setOpen(false);
  }
  return <section className="page-loras" aria-label="本页 LoRA">
    <div className="section-header"><h3>本页 LoRA</h3><button type="button" className="button button--quiet" disabled={disabled} onClick={()=>setOpen(true)}>添加 LoRA</button></div>
    <div className="project-lora-current-list">{loras.map((lora,index)=>{
      const registered=list?.resources.find(entry=>entry.resource.file.sha256===lora.sha256);
      const item=registered?loraResourceCatalogItem(registered):null;
      return <article key={lora.filename} className={lora.enabled===false?'is-disabled':''}>
        {item&&<ResourcePreview compact images={item.previewImages} placeholder="LoRA"/>}
        <div className="project-lora-current__body"><header><label><input type="checkbox" aria-label={`启用 ${item?.name??lora.filename}`} checked={lora.enabled!==false} disabled={disabled} onChange={event=>update(loras.map((entry,i)=>i===index?{...entry,enabled:event.target.checked}:entry))}/>{item?.name??lora.filename}</label>{item&&<ResourceDetailsButton item={item}/>}</header>
          <footer><label>权重<input type="number" min="-2" max="2" step="0.05" value={lora.weight} disabled={disabled} onChange={event=>{const weight=event.target.valueAsNumber;if(Number.isFinite(weight)&&weight>=-2&&weight<=2)update(loras.map((entry,i)=>i===index?{...entry,weight}:entry));}}/></label><button type="button" className="button button--quiet" disabled={disabled} onClick={()=>update(loras.filter((_,i)=>i!==index))}>移除</button></footer>
          {lora.trigger&&<small>触发词：{lora.trigger}</small>}
        </div>
      </article>;
    })}</div>
    {open&&<Modal size="workspace" title="本页添加 LoRA" onClose={()=>setOpen(false)} ariaLabel="本页添加 LoRA"><div className="lora-picker-body">{error?<p role="alert">{error}</p>:!list?<p>正在读取资源…</p>:<ResourcePicker items={choices.map(value=>value.item)} empty="没有可添加的 LoRA" onSelect={item=>{const choice=choices.find(value=>value.item.id===item.id);if(choice)add(choice.resource);}}/>}</div></Modal>}
  </section>;
}
