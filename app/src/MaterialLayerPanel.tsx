import {useState,useEffect} from 'react';
import {fullCrop,imagePlacement,cropImageItem,layerLimit,type ImageLayers,type ImageMedia,type MaterialImageSource} from '../shared/image-layers.mjs';
import {ImageLayerList} from './ImageLayerList';
import {MaterialPicker} from './MaterialPicker';
import {CollageCrop} from './CollageCrop';
import {imageSourceUrl} from './image-layer-client';
export function MaterialLayerPanel({projectId,pageId,document,media,canvas,selected,disabled,onSelect,onChange,onEditing}:{projectId:string;pageId:string;document:ImageLayers;media:Record<string,ImageMedia>;canvas:string;selected:string;disabled:boolean;onSelect:(id:string)=>void;onChange:(doc:ImageLayers)=>void;onEditing:(value:boolean)=>void}){
  const [picker,setPicker]=useState(false),[cropId,setCropId]=useState('');
  const [languagePicker,setLanguagePicker]=useState<{assetId:string;locale:'en'|'ja'}|null>(null);
  const selectedItem=document.items.find(i=>i.id===selected),selectedSource=selectedItem?document.assets[selectedItem.asset_id]:undefined;
  function changeSource(assetId:string,source:MaterialImageSource){onChange({...document,assets:{...document.assets,[assetId]:source}});}
  const cropItem=document.items.find(i=>i.id===cropId);
  useEffect(()=>{onEditing(picker||Boolean(cropId)||Boolean(languagePicker));return()=>onEditing(false);},[picker,cropId,languagePicker,onEditing]);
  return <section><p className="workbench-lettering-note">拖动素材移动，右下角等比缩放；方向键微调，Shift 加速。列表后项位于上层。</p>
    <button className="button" disabled={disabled||document.items.length>=layerLimit} onClick={()=>setPicker(true)}>添加素材 · {document.items.length}/{layerLimit}</button>
    <ImageLayerList projectId={projectId} group={pageId} items={document.items} media={media} selected={selected} disabled={disabled} onSelect={onSelect} onChange={items=>onChange({...document,items})} onCrop={setCropId}/>
    {selectedItem&&selectedSource?.file&&<fieldset className="material-language-settings" disabled={disabled}>
      <legend>选中素材的语言版本</legend>
      <label><input type="checkbox" aria-label="多语言素材" checked={selectedSource.multilingual??false} onChange={e=>changeSource(selectedItem.asset_id,{...selectedSource,multilingual:e.target.checked})}/>多语言素材</label>
      <p className="workbench-lettering-note">{selectedSource.multilingual?'中文使用原图；英日版本共用位置、尺寸和取景，自动等比适配。缺少版本时无法输出该语言。':'所有语言共用原图。关闭开关会保留已指定的语言图片。'}</p>
      {selectedSource.multilingual&&(['en','ja'] as const).map(locale=><div className="material-language-choice" key={locale}>
        <span>{locale==='en'?'英文':'日文'} · {selectedSource.localizations?.[locale]?'已设置':'未设置'}</span>
        <button className="button" onClick={()=>setLanguagePicker({assetId:selectedItem.asset_id,locale})}>{selectedSource.localizations?.[locale]?'更换':'选择'}{locale==='en'?'英文':'日文'}图片</button>
        {selectedSource.localizations?.[locale]&&<button className="button button--quiet" aria-label={`移除${locale==='en'?'英文':'日文'}版本`} onClick={()=>{const localizations={...selectedSource.localizations};delete localizations[locale];changeSource(selectedItem.asset_id,{...selectedSource,localizations});}}>移除</button>}
      </div>)}
    </fieldset>}
    {languagePicker&&<MaterialPicker projectId={projectId} limit={1} onClose={()=>setLanguagePicker(null)} onAdd={choices=>{const source=document.assets[languagePicker.assetId],file=choices[0]?.asset.file;if(source?.file&&file)changeSource(languagePicker.assetId,{...source,localizations:{...source.localizations,[languagePicker.locale]:{file}}});setLanguagePicker(null);}}/>}
    {picker&&<MaterialPicker projectId={projectId} limit={layerLimit-document.items.length} onClose={()=>setPicker(false)} onAdd={choices=>{const next=structuredClone(document);for(const choice of choices){const id=crypto.randomUUID(),assetId=crypto.randomUUID();next.assets[assetId]=choice.asset;next.items.push({id,asset_id:assetId,enabled:true,crop:fullCrop(),box:imagePlacement(choice.media,{x:.2,y:.2,w:.6,h:.6},fullCrop(),canvas).box});onSelect(id);}onChange(next);setPicker(false);}}/>}
    {cropItem&&<CollageCrop url={imageSourceUrl(projectId,media[cropItem.asset_id])} imageSize={media[cropItem.asset_id]} initial={cropItem.crop} onClose={()=>setCropId('')} onDone={crop=>{onChange({...document,items:document.items.map(i=>i.id===cropId?cropImageItem(i,crop,media[i.asset_id],canvas):i)});setCropId('');}}/>}
  </section>;
}
