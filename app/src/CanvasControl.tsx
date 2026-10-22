import canvasChoices from '../shared/canvas-presets.json';

/** 生图与组图共用画幅预设、比例示意和选择交互。 */
export function CanvasControl({value,disabled=false,onChange}:{value:string;disabled?:boolean;onChange:(value:string)=>void}){
  const [width,height]=value.split(':').map(Number),scale=24/Math.max(width,height);
  const label=canvasChoices.find(choice=>choice.value===value)?.label??'';
  return <label className="page-canvas-control" title={`画幅：${value} · ${label}`}><span className="generation-setting-label">画幅</span>
    <svg className="page-canvas-preview" width="30" height="30" viewBox="0 0 30 30" role="img" aria-label={`画幅示意：${value} · ${label}`}>
      <rect x={(30-width*scale)/2} y={(30-height*scale)/2} width={width*scale} height={height*scale} rx="1"/>
    </svg>
    <select aria-label="本页画幅" disabled={disabled} value={value} onChange={event=>onChange(event.target.value)}>
      {!canvasChoices.some(choice=>choice.value===value)&&<option value={value} disabled>原画幅 {value}</option>}
      {canvasChoices.map(choice=><option key={choice.value} value={choice.value}>{choice.label} {choice.value} · {choice.width}×{choice.height}</option>)}
    </select>
  </label>;
}
