import type {ImageItem,ImageMedia} from '../shared/image-layers.mjs';
import {ImageLayerRow} from './ImageLayerRow';
import {imageSourceUrl} from './image-layer-client';
import {useNavigationReorder,NavigationReorderHandle,navigationDropClass,navigationSourceClass,NavigationReorderPreviewOverlay} from './NavigationReorder';
export function ImageLayerList({projectId,group,items,media,selected,disabled,onSelect,onChange,onCrop}:{projectId:string;group:string;items:ImageItem[];media:Record<string,ImageMedia>;selected:string;disabled:boolean;onSelect:(id:string)=>void;onChange:(items:ImageItem[])=>void;onCrop:(id:string)=>void}){
  const label=(item:ImageItem)=>media[item.asset_id]?.label??media[item.asset_id]?.material_file??media[item.asset_id]?.page_id??'素材';
  const reorder=useNavigationReorder(drop=>{if(disabled||drop.kind!=='collage-layer'||!drop.targetId||drop.id===drop.targetId)return;const item=items.find(i=>i.id===drop.id);if(!item)return;const next=items.filter(i=>i.id!==drop.id),index=next.findIndex(i=>i.id===drop.targetId);if(index<0)return;next.splice(index+(drop.placement==='after'?1:0),0,item);onChange(next);});
  return <><div className="collage-layer-list">{items.map(item=><div key={item.id} data-nav-kind="collage-layer" data-nav-id={item.id} data-nav-group={group} className={['collage-layer-row',item.enabled?'':'is-disabled',selected===item.id?'is-selected':'',navigationDropClass(reorder,'collage-layer',item.id),navigationSourceClass(reorder,'collage-layer',item.id)].filter(Boolean).join(' ')}>
    <ImageLayerRow url={imageSourceUrl(projectId,media[item.asset_id],320)} error={media[item.asset_id]?.error} label={label(item)} selected={selected===item.id} disabled={disabled} enabled={item.enabled} onEnabledChange={enabled=>onChange(items.map(i=>i.id===item.id?{...i,enabled}:i))} handle={<NavigationReorderHandle label={label(item)} source={{kind:'collage-layer',id:item.id,group,title:label(item)}} reorder={reorder}/>} onSelect={()=>onSelect(item.id)} onCrop={()=>onCrop(item.id)} onRemove={()=>onChange(items.filter(i=>i.id!==item.id))}/>
  </div>)}</div><NavigationReorderPreviewOverlay reorder={reorder}/></>;
}
