import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {comicGeometry} from '../shared/comic-layout.mjs';
import {loadPageMedia,type WorkbenchPage,type PageMedia} from './project-workbench-client';
import {mediaVariantUrl} from './media-variant';
import ZoomableImageLightbox from './ImageLightbox';
import {videoPreviewUrl} from './video-preview';

/** 只轮询可见卡片；分镜按已保存的各格选图、分格和裁切展示整页。 */
export function StoryPagePreview({projectId,page,onMediaChange}:{projectId:string;page:WorkbenchPage;onMediaChange:(media:PageMedia)=>void}){
  const root=useRef<HTMLButtonElement>(null);
  const [state,setState]=useState<{media:Record<string,PageMedia>;loaded:boolean;failed:boolean}>({media:{},loaded:false,failed:false});
  const [fullscreen,setFullscreen]=useState(false),[broken,setBroken]=useState(false);
  const ids=page.comic?.document.order??[page.page_id],identity=ids.join(',');
  useEffect(()=>{
    const element=root.current;if(!element)return;
    const pageIds=identity.split(','),media:Record<string,PageMedia>={},versions:Record<string,string>={};
    let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    setState({media:{},loaded:false,failed:false});
    const observer=new IntersectionObserver(([entry])=>{
      controller?.abort();clearTimeout(timer);if(!entry.isIntersecting)return;
      const request=new AbortController();controller=request;
      async function refresh(){
        let failed=false;
        await Promise.all(pageIds.map(async id=>{
          try{const result=await loadPageMedia(projectId,{page_id:id},request.signal,versions[id]);if(result&&!request.signal.aborted){versions[id]=result.revision;media[id]=result.media;}}
          catch{if(!request.signal.aborted)failed=true;}
        }));
        if(request.signal.aborted)return;
        setBroken(false);setState({media:{...media},loaded:true,failed});
        if(media[pageIds[0]])onMediaChange(media[pageIds[0]]);
        timer=setTimeout(()=>void refresh(),5000);
      }
      void refresh();
    });
    observer.observe(element);
    return()=>{observer.disconnect();controller?.abort();clearTimeout(timer);};
  },[projectId,identity,onMediaChange]);
  const document=page.comic?.document,geometry=document?comicGeometry(document):null;
  const candidate=state.media[page.page_id]?.candidates[0],url=candidate?.video_url??candidate?.url;
  const thumbnail=url?(candidate?.video_url?videoPreviewUrl(url,320,page.video_postprocess):mediaVariantUrl(url,320)):'';
  const selected=(id:string)=>state.media[id]?.candidates.find(value=>value.candidate_id===document?.panels[id].candidate_id);
  const hasImage=document?document.order.some(id=>selected(id)):Boolean(url&&!state.failed&&!broken);
  const composite=(original=false)=>document&&geometry?<span className="story-comic-art" style={{aspectRatio:`${geometry.width}/${geometry.height}`}}>
    {document.order.map(id=>{const frame=geometry.frames[id],settings=document.panels[id],image=selected(id);return <span className="story-comic-frame" key={id} style={{left:`${frame.x*100}%`,top:`${frame.y*100}%`,width:`${frame.w*100}%`,height:`${frame.h*100}%`} as CSSProperties}>
      {image?<img src={original?image.url:mediaVariantUrl(image.url,320)} alt="" style={{objectPosition:`${settings.crop.x*100}% ${settings.crop.y*100}%`,transform:`scale(${settings.crop.zoom})`,transformOrigin:`${settings.crop.x*100}% ${settings.crop.y*100}%`}}/>:<span>{!state.loaded?'加载中…':settings.candidate_id?'选图暂不可用':'尚未选图'}</span>}
    </span>;})}
  </span>:null;
  return <>
    <button type="button" className={`story-page-thumbnail ${document?'story-page-thumbnail--comic':''}`} style={document?{aspectRatio:document.canvas.replace(':',' / ')}:undefined} ref={root} aria-label={`${document?'查看分镜整页':page.page_kind==='video'?'查看动态':'查看图片'}：${page.title}`} disabled={!hasImage} onClick={()=>setFullscreen(true)}>
      {document?composite():hasImage?<img src={thumbnail} alt={`${page.title}最新候选图`} loading="lazy" onError={()=>setBroken(true)}/>:<span>{state.failed||broken?'缩略图暂不可用':!state.loaded?'加载缩略图…':page.page_kind==='video'?'暂无视频候选':'暂无候选图'}</span>}
    </button>
    {fullscreen&&(document&&geometry?<ZoomableImageLightbox fullResolutionOnly content={{width:geometry.width*2,height:geometry.height*2,children:composite(true)}} alt={`${page.title}整页预览`} footer={page.title} onClose={()=>setFullscreen(false)}/>:url&&<ZoomableImageLightbox src={candidate?.video_url?videoPreviewUrl(url,'original',page.video_postprocess):url} fullResolutionOnly={Boolean(candidate?.video_url)} alt={`${page.title}最新候选图`} footer={page.title} onClose={()=>setFullscreen(false)}/>)}
  </>;
}
