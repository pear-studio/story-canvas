import {useEffect,useState,type RefObject} from 'react';
import type {ImageLayers,ImageMedia,ImageSource,ImageLocale} from '../shared/image-layers.mjs';
import {readFacts,mutateTargetFacts,mutateDerived} from './project-write-client';
import {workbenchResponseJson} from './api-response';
import {mediaVariantUrl} from './media-variant';
export type LayerScope={document:ImageLayers;sha256:string};
export type MaterialChoice={asset:ImageSource;title:string;media:ImageMedia};
export async function layerAction<T>(projectId:string,action:'read'|'save'|'media'|'inspect'|'materials'|'import',value:Record<string,unknown>={},signal?:AbortSignal){
  const request=['save','import'].includes(action)?mutateTargetFacts:action==='inspect'?mutateDerived:readFacts;
  return workbenchResponseJson<T>(await request(`/api/projects/${encodeURIComponent(projectId)}/workbench/layers/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value),signal}));
}
export function imageSourceUrl(projectId:string,media:ImageMedia|undefined,width?:number){
  if(!media||media.error)return '';
  if(media.material_file){const url=`/api/projects/${encodeURIComponent(projectId)}/materials/file?file=${encodeURIComponent(media.material_file)}&v=${media.sha256}`;return width?mediaVariantUrl(url,width):url;}
  if(!media.file)return '';
  const url=`/api/projects/${encodeURIComponent(projectId)}/media/${media.file}?v=${media.sha256}`;return width?mediaVariantUrl(url,width):url;
}
export function useLayerMedia(projectId:string,document:ImageLayers,visibleRef?:RefObject<HTMLElement|null>,locale:ImageLocale='zh'){
  const identity=JSON.stringify(document.assets),[state,setState]=useState<{key:string;media:Record<string,ImageMedia>}>({key:'',media:{}}),key=projectId+locale+identity;
  useEffect(()=>{
    if(!Object.keys(document.assets).length){setState({key,media:{}});return;}
    let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{controller?.abort();clearTimeout(timer);};
    const start=()=>{stop();const request=new AbortController();controller=request;
      const refresh=async()=>{try{const result=await layerAction<{media:Record<string,ImageMedia>}>(projectId,'media',{document:{...document,items:[]},locale},request.signal);if(!request.signal.aborted)setState({key,media:result.media});}catch{if(!request.signal.aborted)setState({key,media:Object.fromEntries(Object.keys(document.assets).map(id=>[id,{width:1,height:1,error:'素材读取失败'}]))});}if(!request.signal.aborted)timer=setTimeout(()=>void refresh(),5000);};void refresh();};
    const observer=visibleRef?.current?new IntersectionObserver(([entry])=>entry.isIntersecting?start():stop()):null;
    if(observer)observer.observe(visibleRef!.current!);else start();return()=>{stop();observer?.disconnect();};
  },[key,visibleRef]);
  return state.key===key?state.media:{};
}
