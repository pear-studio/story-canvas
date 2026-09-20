import path from "node:path";
export const PAGE_KEY_VERSION = "v3";
export const ownerKindPattern = /^(?:story|character|scene)$/;
export const ownerIdPattern = /^[a-z0-9][a-z0-9-]*$/;
export const pageIdPattern = /^page-(?:\d{3}|[a-f0-9]{12})$/;
export function isPageId(value) { return typeof value === 'string' && pageIdPattern.test(value); }
export function createStoryPageKey(pageId) { return {page_id:pageId}; }
export function createCharacterPageKey(_ownerId,pageId) { return {page_id:pageId}; }
export function createPageKey(pageId) {return {page_id:pageId};}
export function validatePageKey(value,{path:valuePath='page_key'}={}) {
  if (!value || typeof value!=='object' || Array.isArray(value)) return [`${valuePath} 必须是对象`];
  const errors=[];
  if(Object.keys(value).some(key=>key!=='page_id')) errors.push(`${valuePath} 只保存 page_id`);
  if(!isPageId(value.page_id)) errors.push(`${valuePath}.page_id 无效`);
  return errors;
}
function assertPageKey(value) {const errors=validatePageKey(value);if(errors.length)throw new TypeError(errors.join('；'));return value;}
export function encodePageKey(value) {return `${PAGE_KEY_VERSION}/${assertPageKey(value).page_id}`;}
export function decodePageKey(value) {
  if(value && typeof value==='object')return {...assertPageKey(value)};
  if(isPageId(value))return {page_id:value};
  if(typeof value!=='string')throw new TypeError('PageKey 必须是对象或规范字符串');
  const parts=value.split('/');
  if(parts.length!==2 || parts[0]!==PAGE_KEY_VERSION)throw new TypeError(`PageKey 不是 ${PAGE_KEY_VERSION} 规范字符串`);
  return {...assertPageKey({page_id:parts[1]})};
}
export function pageKeyPathSegments(value) {return ['pages',assertPageKey(value).page_id];}
export function pageKeyMediaPath(mediaRoot,value,...segments) {
  if(typeof mediaRoot!=='string'||!path.isAbsolute(mediaRoot))throw new TypeError('媒体根目录必须是绝对路径');
  for(const segment of segments)if(typeof segment!=='string'||!segment||segment==='.'||segment==='..'||/[\\/\0:<>"|?*]/.test(segment)||path.isAbsolute(segment))throw new TypeError('媒体路径必须是安全的单一路径片段');
  return path.resolve(mediaRoot,...pageKeyPathSegments(value),...segments);
}
export const PageKeyCodec=Object.freeze({encode:encodePageKey,decode:decodePageKey,validate:validatePageKey,pathSegments:pageKeyPathSegments,mediaPath:pageKeyMediaPath});
