export const populationKinds = ['girls','boys','others'];
export const populationTags = populationKinds.flatMap(kind => [
  ...Array.from({length:6},(_,i)=>({prompt_text:`${i+1}${i===5?'+':''}${i===0?kind.slice(0,-1):kind}`,kind,minimum:i+1})),
  {prompt_text:`multiple ${kind}`,kind,minimum:2},
]);
export const populationInputs = ['solo','no_humans',...populationTags.flatMap(t=>[t.prompt_text,t.prompt_text.replaceAll(' ','_')])];
export const populationText = value => String(value??'').trim().toLowerCase().replaceAll('_',' ').replace(/\s+/g,' ');
export const populationTag = value => populationTags.find(tag=>tag.prompt_text===populationText(value)) ?? null;
export const isPopulationControl = value => ['solo','no humans'].includes(populationText(value)) || populationTag(value)!==null;

// 只约束确定的人数语法；人物中未绑定角色的普通词条始终合法。
export function validatePopulation(prompt,{setting=false}={}) {
  const errors=[],active=[];
  for(const [category,fragments] of Object.entries(prompt??{})) {
    if(!Array.isArray(fragments))continue;
    for(const [index,f]of fragments.entries()) {
      if(!f || typeof f!=='object' || Array.isArray(f))continue;
      const text=f.tag??f.description,control=isPopulationControl(text),field=`${category}[${index}]`;
      if(category==='population') {
        if(setting)errors.push(`${field}：画面人数只能由页面设置，角色/场景不得声明人数`);
        if(!control || !populationInputs.includes(f.tag) || typeof f.tag!=='string' || f.character_id!==undefined || f.camera_settings!==undefined)
          errors.push(`${field}：population 只接受未绑定角色的人数 tag；普通词条请放 person/setting/camera`);
        if(f.enabled!==false)active.push(populationText(text));
      } else if(control && category!=='avoid')errors.push(`${field}：正向人数词必须放 population`);
    }
  }
  const counts=active.map(populationTag).filter(Boolean);
  for(const kind of populationKinds)if(counts.filter(c=>c.kind===kind).length>1)errors.push(`population：${kind} 人数重复或冲突`);
  if(new Set(active).size!==active.length)errors.push('population：人数标签重复');
  if(active.includes('no humans') && active.length>1)errors.push('population：no_humans 不能与其他人数声明共用');
  if(active.includes('solo') && (counts.length>1 || counts.some(c=>c.minimum>1)))errors.push('population：solo 不能与多人声明共用');
  return errors;
}
