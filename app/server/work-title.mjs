import {ApiError} from './http-support.mjs';
import {validateWorkTitle} from './project-manifest.mjs';

export function normalizeWorkTitle(value) {
  const errors=validateWorkTitle(value,{allowEmpty:true});
  if(errors.length)throw new ApiError(422,'invalid_work_title',errors);
  const result={};
  for(const [locale,title] of Object.entries(value)) {
    if(title.trim())result[locale]=title.trim();
  }
  return result;
}

export function exportWorkTitle(project,locale='zh') {
  return project.work_title?.[locale] || project.work_title?.zh || project.title;
}

export function filenamePart(value,maxBytes=160) {
  const safe=String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/g,'').trim();
  let result='';
  for(const char of safe){if(Buffer.byteLength(result+char)>maxBytes)break;result+=char;}
  return result||'作品';
}
