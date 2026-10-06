// 只压缩只读展示，不重算继承。差异保存完整有效条目，避免丢失 enabled/weight/consumed。
export function compactSourcePool(sources) {
  const bases=new Map();
  return sources.map(source=>{
    if(!Array.isArray(source.entries))return source;
    const {ref,entries,...metadata}=source;
    const signature=JSON.stringify([metadata,entries.map(entry=>entry.key)]);
    const base=bases.get(signature);
    if(!base){bases.set(signature,source);return source;}
    const changed=entries.filter((entry,index)=>JSON.stringify(entry)!==JSON.stringify(base.entries[index]));
    const compact={ref,source:source.source,model_id:source.model_id,base_ref:base.ref,entries:changed};
    return JSON.stringify(compact).length<JSON.stringify(source).length?compact:source;
  });
}
