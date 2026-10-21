import {hasVideoPostprocess,normalizeVideoPostprocess,type VideoPostprocess} from '../shared/video-postprocess.mjs';

// 总览、小预览和高清预览使用相同参数规范与 URL，复用浏览器及磁盘缓存。
export function videoPreviewUrl(source:string,width:320|'original',settings?:VideoPostprocess) {
  const edit=normalizeVideoPostprocess(settings);
  return source+(source.includes('?')?'&':'?')+`video_profile=${width===320?'preview':'original'}&video_v=3`+(hasVideoPostprocess(edit)?`&video_edit=${encodeURIComponent(JSON.stringify(edit))}`:'');
}
