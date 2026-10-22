import {useEffect,useRef,useState,type RefObject} from 'react';
import type {CollageAsset,CollageDocument,CollageMedia} from '../shared/collage-layout.mjs';
import {readFacts,mutateDerived,mutateTargetFacts} from './project-write-client';
import {workbenchResponseJson} from './api-response';
import {mediaVariantUrl} from './media-variant';
export type CollageScope={document:CollageDocument;sha256:string};
export type CollageChoice={page_id:string;title:string;path:string;asset:CollageAsset;media:CollageMedia};
export type CollageSources={pages:CollageChoice[];next:number|null;chapters:{id:string;title:string;sequences:{id:string;title:string}[]}[]};
export async function collageAction<T>(projectId:string,pageId:string,action:'read'|'save'|'sources'|'preview'|'arrange'|'media',value:Record<string,unknown>={},signal?:AbortSignal){
  const request=action==='save'?mutateTargetFacts:action==='preview'?mutateDerived:readFacts;
  return workbenchResponseJson<T>(await request(`/api/projects/${encodeURIComponent(projectId)}/workbench/collage/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page_key:{page_id:pageId},...value}),signal}));
}
export function collageAssetUrl(projectId:string,asset:CollageMedia|undefined,width?:number){
  if(!asset?.file||asset.error)return '';
  const url=`/api/projects/${encodeURIComponent(projectId)}/media/${asset.file}?v=${asset.sha256}`;
  return width?mediaVariantUrl(url,width):url;
}
// 只刷新媒体，不替换排版草稿；总览只为进入视口的组图发起请求。
export function useCollageMedia(projectId:string,document:CollageDocument,visibleRef?:RefObject<HTMLElement|null>){
  const identity=JSON.stringify(document.assets),latest=useRef(document);latest.current=document;
  const [state,setState]=useState<{identity:string;projectId:string;media:Record<string,CollageMedia>}>({identity:'',projectId:'',media:{}});
  useEffect(()=>{
    let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,observer:IntersectionObserver|undefined;
    function stop(){controller?.abort();clearTimeout(timer);}
    function start(){
      stop();const request=new AbortController();controller=request;
      async function refresh(){
        try{const result=await collageAction<{media:Record<string,CollageMedia>}>(projectId,'','media',{document:latest.current},request.signal);if(!request.signal.aborted)setState({identity,projectId,media:result.media});}
        catch{if(!request.signal.aborted)setState({identity,projectId,media:Object.fromEntries(Object.entries(latest.current.assets).map(([id,a])=>[id,{...a,width:1,height:1,error:'来源读取失败'}]))});}
        if(!request.signal.aborted)timer=setTimeout(()=>void refresh(),5000);
      }
      void refresh();
    }
    if(visibleRef?.current){observer=new IntersectionObserver(([entry])=>entry.isIntersecting?start():stop());observer.observe(visibleRef.current);}else start();
    return()=>{stop();observer?.disconnect();};
  },[projectId,identity,visibleRef]);
  return state.projectId===projectId&&state.identity===identity?state.media:{};
}
