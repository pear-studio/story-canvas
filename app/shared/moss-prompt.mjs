export const mossCategories = Object.freeze(['composition','person','setting','camera','extra','avoid']);
export const mossLabels = Object.freeze({composition:'构图',person:'人物',setting:'场景',camera:'镜头',extra:'补充',avoid:'避免'});
export const mossPageCategories = Object.freeze(mossCategories.filter(key=>key!=='avoid'));
export const mossProjectFields = Object.freeze(['style','lighting','avoid']);
export const mossProjectLabels = Object.freeze({style:'画风',lighting:'光照',avoid:'避免'});
export const emptyMossPrompt = () => Object.fromEntries(mossPageCategories.map(key=>[key,[]]));
export const mossText = entries => (entries??[]).filter(entry=>entry.enabled!==false).map(entry=>entry.description.trim()).filter(Boolean).join(' ');
export function mossLayoutBox(box,width,height) {
  const [x,y,w,h]=box;
  const pixel=(value,size)=>Number((value*size).toFixed(9));
  return [Math.floor(pixel(y,height))-Math.floor(height/2),Math.floor(pixel(x,width))-Math.floor(width/2),Math.ceil(pixel(y+h,height))-Math.floor(height/2),Math.ceil(pixel(x+w,width))-Math.floor(width/2)];
}
export function clampMossBox([x,y,w,h]) {
  w=Math.max(.02,Math.min(1,w));h=Math.max(.02,Math.min(1,h));
  return [Math.max(0,Math.min(1-w,x)),Math.max(0,Math.min(1-h,y)),w,h];
}
export function validateMossEntries(value,label,{person=false}={}) {
  if(!Array.isArray(value))return [`${label} 必须是自然语言条目数组`];
  const errors=[],ids=new Set();
  value.forEach((entry,index)=>{
    const key=`${label}[${index}]`;
    if(!entry||typeof entry!=='object'||Array.isArray(entry)){errors.push(`${key} 必须是对象`);return;}
    if(Object.keys(entry).some(k=>!['id','description','enabled',...(person?['character_id']:[])].includes(k)))errors.push(`${key} 包含未知字段`);
    if(typeof entry.description!=='string')errors.push(`${key}.description 必须是字符串`);
    if(entry.enabled!==undefined&&typeof entry.enabled!=='boolean')errors.push(`${key}.enabled 必须是布尔值`);
    if(entry.character_id!==undefined&&(typeof entry.character_id!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.character_id)))errors.push(`${key}.character_id 无效`);
    if(entry.id!==undefined){if(typeof entry.id!=='string'||!entry.id||ids.has(entry.id))errors.push(`${key}.id 无效或重复`);ids.add(entry.id);}
  });return errors;
}
