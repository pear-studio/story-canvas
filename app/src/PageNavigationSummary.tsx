import type {WorkbenchPage} from './project-workbench-client';
import {pageKeyId} from './page-key';
import {videoPostprocessTiming} from '../shared/video-postprocess.mjs';

export type PageType = 'text' | 'image' | 'video' | 'comic';
export const pageTypeLabels:Record<PageType,string>={text:'文字页',image:'图片页',video:'动态页',comic:'分镜页'};
export function pageTypeOf(page:WorkbenchPage):PageType{return page.comic?'comic':page.page_kind==='text'?'text':page.page_kind==='video'?'video':'image';}

export function pageNavigationInfo(page:WorkbenchPage,counts:Record<string,number>|null,video?:{frames:number;fps:number}){
  const type=pageTypeOf(page);
  if(type==='text')return {type,label:'',description:pageTypeLabels[type]};
  if(type==='comic')return {type,label:`${page.comic!.document.order.length} 格`,description:`分镜页，${page.comic!.document.order.length} 个分镜`};
  const count=counts===null?null:counts[pageKeyId(page.page_key)]??0;
  const quantity=count===null?'…':String(count);
  if(type==='video'){
    let timing=count===null?'时长加载中':count===0?'未生成':'时长未知';
    if(count!==0&&video)try{timing=`${videoPostprocessTiming(video,page.video_postprocess).duration_seconds.toFixed(2)} 秒`;}
    catch{timing='裁剪范围无效';}
    return {type,label:`${quantity} 段 · ${timing}`,description:`动态页，${count===null?'候选数量正在读取':`${count} 个可用视频候选`}，${video?'最新候选，':''}${timing}`};
  }
  return {type,label:`${quantity} 张`,description:`图片页，${count===null?'候选数量正在读取':`${count} 张可用候选图`}`};
}

export function PageTypeIcon({type}:{type:PageType}){
  return <svg className={`navigation-page-type navigation-page-type--${type}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type==='text'?<><path d="M4 5h16M12 5v15M8 20h8"/></>:type==='image'?<><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></>:type==='video'?<><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M3 11h18M3 7l16-4 2 4M8 6l3 4M14 4l3 4"/></>:<><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M11 3v18M11 12h10"/></>}
  </svg>;
}

export function PageNavigationLabel({page,number,type}:{page:WorkbenchPage;number:number;type:PageType}){
  return <span className="navigation-page-label"><i className="navigation-page-number">{String(number).padStart(2,'0')}</i><PageTypeIcon type={type}/><span className="navigation-page-title">{page.title}</span></span>;
}
