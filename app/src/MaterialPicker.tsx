import {useEffect,useState} from 'react';
import {Modal} from './Modal';
import {layerAction,imageSourceUrl,type MaterialChoice} from './image-layer-client';
export function MaterialPicker({projectId,limit,onAdd,onClose}:{projectId:string;limit:number;onAdd:(choices:MaterialChoice[])=>void;onClose:()=>void}){
  const [choices,setChoices]=useState<MaterialChoice[]>([]),[selected,setSelected]=useState<MaterialChoice[]>([]),[busy,setBusy]=useState(true),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();void layerAction<{materials:MaterialChoice[]}>(projectId,'materials',{},controller.signal).then(result=>setChoices(result.materials)).catch(e=>{if(!controller.signal.aborted)setError(String(e));}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();},[projectId]);
  async function upload(files:FileList|null){if(!files)return;setBusy(true);setError('');try{for(const file of Array.from(files)){if(file.size>32*1024*1024)throw Error('图片不能超过 32 MB');const content=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('读取图片失败'));reader.readAsDataURL(file);});const choice=await layerAction<MaterialChoice>(projectId,'import',{title:file.name,content});setChoices(current=>[...current,choice]);}}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <Modal className="reference-picker-modal" title="选择项目素材" subtitle="导入会保存到项目；取消排版仍保留素材。后面的图片叠在上层。" busy={busy} onClose={onClose} footer={<><button className="button" disabled={busy} onClick={onClose}>取消</button><button className="button button--primary" disabled={busy||!selected.length} onClick={()=>onAdd(selected)}>添加到页面 · {selected.length}</button></>}>
    <label className="button material-import">导入项目素材<input aria-label="导入项目素材" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} onChange={e=>{void upload(e.target.files);e.target.value='';}}/></label>
    {error&&<p role="alert">{error}</p>}{busy&&<p>正在读取素材…</p>}
    <div className="reference-candidate-grid material-picker-grid">{choices.map(choice=>{const key=choice.asset.file!,checked=selected.some(c=>c.asset.file===key);return <button key={key} className="reference-candidate-choice" aria-label={choice.title} title={choice.media.error??choice.title} aria-pressed={checked} disabled={busy||Boolean(choice.media.error)||!checked&&selected.length>=limit} onClick={()=>setSelected(current=>checked?current.filter(c=>c.asset.file!==key):[...current,choice])}>
      {choice.media.error?<span>{choice.media.error}</span>:<img src={imageSourceUrl(projectId,choice.media,320)} alt={choice.title} loading="lazy"/>}{checked&&<i>{selected.findIndex(c=>c.asset.file===key)+1}</i>}
    </button>;})}</div>{!busy&&!choices.length&&<p>暂无图片素材，请先导入。</p>}
  </Modal>;
}
