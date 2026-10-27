import {mossText,mossLayoutBox} from '../../../shared/moss-prompt.mjs';
import {resolvePageLoras} from '../../lora-config.mjs';
import {validatePageKey} from '../../page-key.mjs';
import {pagePromptAudit} from '../../prompt-audit.mjs';
import {characterSource,sceneSource} from '../../prompt-contract.mjs';
export function compilePrompt({pageId,pageKey,pagePrompt:prompt,profile,characters=[],scenes=[],participantIds=[],dimensions}){
  const errors=[...validatePageKey(pageKey)],missing=[],sections=[];
  const join=parts=>parts.filter(part=>part?.trim()).join('\n\n');
  const named=(setting,caption)=>caption&&setting.prompt_name?.trim()?`${setting.prompt_name.trim()}: ${caption}`:caption;
  const text=key=>mossText(prompt[key]);
  const active=new Set(participantIds),sources=new Set();
  const loras=resolvePageLoras(prompt,pageId,profile,characters,scenes);errors.push(...loras.errors);
  const captionById=new Map();
  for(const id of participantIds){
    const c=characters.find(c=>c.id===id);if(!c){errors.push(`未知角色：${id}`);continue;}
    const source=characterSource(id,c.configuration_id);sources.add(source);
    const caption=named(c,join([...(loras.triggers.characters.get(id)??[]),mossText(prompt.entry_overrides?.[source]??c.entries),mossText(prompt.person.filter(entry=>entry.character_id===id))]));
    captionById.set(id,caption);sections.push({kind:'character',source,prompt_name:c.prompt_name,text:caption});
  }
  const environment=scenes.map(c=>{const source=sceneSource(c.id,c.configuration_id);sources.add(source);const caption=named(c,join([...(loras.triggers.scenes.get(c.id)??[]),mossText(prompt.entry_overrides?.[source]??c.entries)]));sections.push({kind:'scene',source,prompt_name:c.prompt_name,text:caption});return caption;});
  for(const source of Object.keys(prompt.entry_overrides??{}))if(!sources.has(source))errors.push(`描述覆盖引用了未出场的设定：${source}`);
  for(const entry of prompt.person)if(entry.character_id&&!active.has(entry.character_id))errors.push(`人物条目引用了未出场角色：${entry.character_id}`);
  for(const item of prompt.layout?.items??[])if(item.character_id&&!active.has(item.character_id))errors.push(`Layout 引用了未出场角色：${item.character_id}`);
  const global=join([...loras.triggers.style,mossText(prompt.project_overrides?.style??profile.prompt.style),mossText(prompt.project_overrides?.lighting??profile.prompt.lighting)]);
  const freePeople=mossText(prompt.person.filter(entry=>!entry.character_id));
  const objects=(prompt.layout?.items??[]).filter(item=>!item.character_id).map(item=>join([mossText(item.entries),item.label==='text'?item.text:'']));
  let positive=join([text('composition'),...environment,text('setting'),...captionById.values(),freePeople,...objects,text('camera'),global,text('extra')]);
  if(!positive.trim())missing.push('MOSS 正向描述为空');
  if(prompt.layout?.enabled&&prompt.layout.items.length){
    if(!dimensions?.width||!dimensions?.height)errors.push('Layout 缺少实际生成尺寸');
    else {
      for(const item of prompt.layout.items)if(!(item.character_id?captionById.get(item.character_id):join([mossText(item.entries),item.label==='text'?item.text:'']))?.trim())errors.push(`Layout 元素缺少描述：${item.id}`);
      const boxed=new Set(prompt.layout.items.map(item=>item.character_id));
      const summary=join([text('composition'),...environment,text('setting'),...[...captionById].filter(([id])=>!boxed.has(id)).map(([,caption])=>caption),freePeople,text('camera'),global,text('extra')]);
      positive=JSON.stringify({summary:{caption:summary},items:prompt.layout.items.map(item=>({label:item.character_id?'character':item.label,caption:item.character_id?captionById.get(item.character_id)??'':mossText(item.entries),...(item.label==='text'?{text:item.text}:{}),bbox:mossLayoutBox(item.bbox,dimensions.width,dimensions.height)})),bbox_coord_space:'abs_centralized',bbox_format:'yxyx'});
    }
  }
  const audit=pagePromptAudit({missing,errors,positive});
  return {page_key:structuredClone(pageKey),ready:!errors.length&&!missing.length&&!!positive.trim(),missing,errors,positive_prompt:positive,negative_prompt:mossText(prompt.avoid??profile.prompt.avoid),sections,audit,loras:loras.loras,images:[]};
}
