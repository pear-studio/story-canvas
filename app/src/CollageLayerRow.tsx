import type {ReactNode} from 'react';
import type {CollageMedia} from '../shared/collage-layout.mjs';
import {collageAssetUrl} from './collage-client';

export function CollageLayerRow({projectId,media,label,selected=false,disabled=false,handle,onSelect,onCrop,onRemove,background=false,enabled,onEnabledChange}:{projectId:string;media?:CollageMedia;label:string;selected?:boolean;disabled?:boolean;handle?:ReactNode;onSelect:()=>void;onCrop:()=>void;onRemove:()=>void;background?:boolean;enabled?:boolean;onEnabledChange?:(enabled:boolean)=>void}){
  return <>
    {handle}
    <button className="collage-layer-select" disabled={disabled} aria-pressed={background?undefined:selected} aria-label={background?'更换背景':label} title={background?'点击更换背景':label} onClick={onSelect}>
      {media?.file&&!media.error?<img src={collageAssetUrl(projectId,media,320)} alt=""/>:<span className="collage-layer-placeholder">{media?.error??'加载中…'}</span>}
      <span>{label}</span>
    </button>
    <button className="button button--quiet collage-layer-crop" disabled={disabled||!media||Boolean(media.error)} aria-label={background?'背景取景':`调整取景：${label}`} title="调整取景" onClick={onCrop}>取景</button>
    {onEnabledChange&&<label className={`prompt-fragment-enabled ${enabled?'is-on':'is-off'}`} title={enabled?'参与组图':'已关闭，不参与组图'}>
      <input type="checkbox" aria-label={background?'背景参与组图':`参与组图：${label}`} disabled={disabled} checked={enabled} onChange={event=>onEnabledChange(event.target.checked)}/>
      <span aria-hidden="true"><i/></span>
    </label>}
    <button className="prompt-fragment-delete" disabled={disabled} aria-label={background?'移除背景':`移除：${label}`} title="移除" onClick={onRemove}>×</button>
  </>;
}
