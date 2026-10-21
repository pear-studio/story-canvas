import {useEffect,useState} from 'react';

type Preview={identity:string;url:string;width:number;pending:boolean;error:string};
const empty:Preview={identity:'',url:'',width:0,pending:false,error:''};

/** 两档独立加载，先显示可用的小图；高清失败不抹去小图，旧请求不能覆盖新候选。 */
export function useVideoPreview(small:string,large:string,attempt=0) {
  const [state,setState]=useState<Preview>(empty);
  useEffect(()=>{
    const controller=new AbortController(),urls=new Set<string>();
    let best=0,finished=0,largeError='';
    setState({...empty,identity:large,pending:Boolean(large)});
    async function load(source:string,width:number) {
      const started=performance.now();
      let failure='',stage='fetch',outcome='loaded',requestId='',status=0,bytes=0,fetchMs=0,decodeMs=0;
      try {
        const response=await fetch(source,{signal:controller.signal});
        requestId=response.headers.get('x-story-canvas-request-id')??'';status=response.status;
        if(!response.ok)throw Error(`HTTP ${response.status}`);
        const blob=await response.blob();
        bytes=blob.size;fetchMs=Math.round(performance.now()-started);
        if(controller.signal.aborted)return;
        const url=URL.createObjectURL(blob);urls.add(url);
        stage='decode';const decodeStarted=performance.now();
        const image=new Image();image.src=url;
        await image.decode();
        decodeMs=Math.round(performance.now()-decodeStarted);
        if(controller.signal.aborted)return;
        if(width>best){best=width;setState(previous=>({...previous,identity:large,url,width}));}
      } catch(error) {
        outcome=controller.signal.aborted?'cancelled':'failed';
        if(controller.signal.aborted)return;
        failure=error instanceof Error?error.message:String(error);
      } finally {
        const duration=Math.round(performance.now()-started);
        if(stage==='fetch')fetchMs=duration;
        else decodeMs=Math.max(0,duration-fetchMs);
        // 只上报来源路径和阶段，不记录图片、Prompt 或 URL 查询参数。
        void fetch('/api/performance',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:JSON.stringify({
          event:'video-preview',outcome:controller.signal.aborted?'cancelled':outcome,stage,width,status,bytes,
          request_id:requestId,source:source.split('?')[0],duration_ms:duration,fetch_ms:fetchMs,decode_ms:decodeMs,
        })}).catch(()=>{});
        if(!controller.signal.aborted) {
          finished++;
          if(width===1024)largeError=failure;
          setState(previous=>({...previous,pending:best<1024&&finished<2,error:finished===2&&best<1024?(largeError||failure):''}));
        }
      }
    }
    if(small&&large){void load(small,320);void load(large,1024);}
    return()=>{controller.abort();urls.forEach(url=>URL.revokeObjectURL(url));};
  },[small,large,attempt]);
  return state.identity===large?state:{...empty,identity:large,pending:Boolean(large)};
}
