import {useEffect,useState} from 'react';

type Preview={identity:string;url:string;pending:boolean;error:string};
const empty:Preview={identity:'',url:'',pending:false,error:''};
function usePreviewLayer(source:string,profile:'preview'|'original',attempt:number) {
  const [state,setState]=useState<Preview>(empty);
  useEffect(()=>{
    if(!source){setState(empty);return;}
    const controller=new AbortController();let url='';
    setState({...empty,identity:source,pending:true});
    void (async()=>{
      const started=performance.now();let stage='fetch',status=0,bytes=0,fetchMs=0,requestId='',outcome='loaded';
      try {
        const response=await fetch(source,{signal:controller.signal});
        status=response.status;requestId=response.headers.get('x-story-canvas-request-id')??'';
        if(!response.ok){const error=await response.json().catch(()=>null);throw Error(error?.details?.message??`HTTP ${status}`);}
        const blob=await response.blob();bytes=blob.size;fetchMs=Math.round(performance.now()-started);
        if(controller.signal.aborted)return;
        url=URL.createObjectURL(blob);stage='decode';const image=new Image();image.src=url;await image.decode();
        if(!controller.signal.aborted)setState({identity:source,url,pending:false,error:''});
      } catch(error) {
        outcome='failed';
        if(!controller.signal.aborted)setState({identity:source,url:'',pending:false,error:error instanceof Error?error.message:String(error)});
      } finally {
        const duration=Math.round(performance.now()-started);
        void fetch('/api/performance',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:JSON.stringify({
          event:'video-preview',outcome:controller.signal.aborted?'cancelled':outcome,stage,profile,status,bytes,
          request_id:requestId,source:source.split('?')[0],duration_ms:duration,fetch_ms:stage==='fetch'?duration:fetchMs,decode_ms:stage==='decode'?duration-fetchMs:0,
        })}).catch(()=>{});
      }
    })();
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[source,profile,attempt]);
  return state.identity===source?state:{...empty,identity:source,pending:Boolean(source)};
}

/** 原图按需加载；开启或关闭原图不会重取、撤销已就绪的小图。 */
export function useVideoPreview(small:string,large:string,attempt=0) {
  const preview=usePreviewLayer(small,'preview',attempt),original=usePreviewLayer(large,'original',attempt);
  return {url:original.url||preview.url,profile:original.url?'original':'preview',pending:preview.pending||original.pending,error:original.error||preview.error};
}
