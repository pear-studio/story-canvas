import {hasVideoPostprocess,normalizeVideoPostprocess,type VideoPostprocess} from '../shared/video-postprocess.mjs';
import {mediaVariantUrl} from './media-variant';

// 总览、小预览和高清预览使用相同参数规范与 URL，复用浏览器及磁盘缓存。
export function videoPreviewUrl(source:string,width:number,settings?:VideoPostprocess) {
  const edit=normalizeVideoPostprocess(settings);
  return mediaVariantUrl(source,width)+(hasVideoPostprocess(edit)?`&video_edit=${encodeURIComponent(JSON.stringify(edit))}`:'');
}
