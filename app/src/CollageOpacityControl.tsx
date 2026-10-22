import {useEffect,useState} from 'react';

/** 与文字页字号、生成参数相同的数值编辑：百分比明确，空值不覆盖草稿。 */
export function CollageOpacityControl({value,disabled,onChange}:{value:number;disabled:boolean;onChange:(value:number)=>void}){
  const [draft,setDraft]=useState(String(Math.round(value*100)));
  useEffect(()=>setDraft(String(Math.round(value*100))),[value]);
  return <div className="page-generation-settings collage-opacity-control"><label>
    <span>不透明度</span><input type="number" aria-label="背景不透明度" min="0" max="100" step="1" disabled={disabled} value={draft} onChange={event=>{
      setDraft(event.target.value);const percent=event.target.valueAsNumber;
      if(Number.isFinite(percent)&&percent>=0&&percent<=100)onChange(percent/100);
    }} onBlur={()=>setDraft(String(Math.round(value*100)))}/><span>%</span>
  </label></div>;
}
