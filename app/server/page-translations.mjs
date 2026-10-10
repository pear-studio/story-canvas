import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {readPageContent,readPageEntry} from './pages-store.mjs';
import {encodePageKey} from './page-key.mjs';
import {hashCanonicalJson} from './workflow-definition.mjs';
import {commitFactChanges} from './story-facts.mjs';

export const TRANSLATIONS_SCHEMA='https://storyvisualizer.local/schemas/page-translations.schema.json';
export function requireLetteringLocale(locale='zh') {
  if(!['zh','en','ja'].includes(locale))throw Object.assign(new Error('locale 只能是 zh、en 或 ja'),{status:400});
  return locale;
}
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status,code:'translation_error'});};
export const translationPath=id=>{encodePageKey({page_id:id});return `pages/${id}.translations.json`;};
export async function readTranslationDocument(directory,id) {
  try{return JSON.parse(await readFile(path.join(directory,translationPath(id)),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export function translationSources(content) {
  if(content.page_kind==='video')return [];
  if(content.page_kind==='text')return ['display_title','body'].filter(field=>content[field]?.trim()).map(field=>({id:field,text:content[field],source_sha256:hashCanonicalJson(content[field])}));
  return (content.dialogue??[]).map(line=>({id:line.id,text:line.text,mode:line.mode,...(line.speaker?{speaker:line.speaker}:{}),...(line.position?{position:line.position}:{}),source_sha256:hashCanonicalJson({text:line.text,mode:line.mode,speaker:line.speaker??null,position:line.position??null})}));
}
export function translationProjection(content,document,locale) {
  requireLetteringLocale(locale);
  const sources=translationSources(content),branch=document?.[locale]??{},entries=content.page_kind==='text'?branch:branch.dialogue??{};
  const lines=sources.map(source=>({...source,translation:entries[source.id]?.text??'',status:!entries[source.id]?.text?.trim()?'missing':entries[source.id].source_sha256!==source.source_sha256?'stale':'ready'}));
  return {locale,lines,expected_source_sha256:hashCanonicalJson(sources),expected_translation_sha256:hashCanonicalJson(branch),summary:{total:lines.length,missing:lines.filter(line=>line.status==='missing').length,stale:lines.filter(line=>line.status==='stale').length}};
}
export async function readPageTranslation(directory,value) {
  const id=value?.page_key?.page_id;try{encodePageKey({page_id:id});}catch{fail('page_key.page_id 无效',400);}
  if(!await readPageEntry(directory,id))fail('页面已不存在',404);
  const content=await readPageContent(directory,id),document=await readTranslationDocument(directory,id),locale=requireLetteringLocale(value.locale);
  if(locale==='zh')fail('中文使用页面正文编辑入口',400);
  return {page_key:{page_id:id},page_kind:content.page_kind??'illustration',...translationProjection(content,document,locale)};
}
export function validateTranslationDocument(document,content) {
  const errors=[],allowed=new Set(translationSources(content).map(line=>line.id));
  if(!document||typeof document!=='object'||Array.isArray(document)||document.$schema!==TRANSLATIONS_SCHEMA)return ['译文文档 Schema 无效'];
  for(const key of Object.keys(document))if(!['$schema','en','ja'].includes(key))errors.push(`未知字段 ${key}`);
  for(const locale of ['en','ja']) {
    const branch=document[locale];if(branch===undefined)continue;
    if(!branch||typeof branch!=='object'||Array.isArray(branch)){errors.push(`${locale} 必须是对象`);continue;}
    if(content.page_kind!=='text'&&branch.dialogue!==undefined&&(!branch.dialogue||typeof branch.dialogue!=='object'||Array.isArray(branch.dialogue))){errors.push(`${locale}.dialogue 必须是对象`);continue;}
    const entries=content.page_kind==='text'?branch:branch.dialogue??{};
    if(!entries||typeof entries!=='object'||Array.isArray(entries)){errors.push(`${locale} 条目必须是对象`);continue;}
    if(content.page_kind!=='text'&&Object.keys(branch).some(key=>key!=='dialogue'))errors.push(`${locale} 仅接受 dialogue`);
    for(const [id,entry] of Object.entries(entries)) {
      if(!allowed.has(id))errors.push(`${locale}.${id} 未对应原文`);
      if(!entry||typeof entry.text!=='string'||!entry.text.trim()||!/^[a-f0-9]{64}$/.test(entry.source_sha256??'')||Object.keys(entry).some(key=>!['text','source_sha256'].includes(key)))errors.push(`${locale}.${id} 条目无效`);
    }
  }
  return errors;
}
export async function savePageTranslation(directory,value) {
  const current=await readPageTranslation(directory,value),id=current.page_key.page_id;
  if(current.expected_source_sha256!==value.expected_source_sha256)fail('中文原文已变化，请重新读取后翻译');
  if(current.expected_translation_sha256!==value.expected_translation_sha256)fail('本语言译文已变化，请重新读取后合并');
  if(!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries))fail('entries 必须为 ID 到译文的对象',400);
  const before=await readTranslationDocument(directory,id),after=structuredClone(before??{$schema:TRANSLATIONS_SCHEMA}),locale=current.locale;
  const branch=after[locale]??={},entries=current.page_kind==='text'?branch:(branch.dialogue??={});
  for(const [key,text] of Object.entries(value.entries)) {
    const source=current.lines.find(line=>line.id===key);if(!source)fail(`原文中没有条目 ${key}`,400);
    if(text===null||typeof text==='string'&&!text.trim()){delete entries[key];continue;}
    if(typeof text!=='string'||text.length>20000)fail(`条目 ${key} 译文无效`,400);
    entries[key]={text,source_sha256:source.source_sha256};
  }
  const errors=validateTranslationDocument(after,await readPageContent(directory,id));if(errors.length)fail(errors.join('；'),400);
  await commitFactChanges(directory,[{relative:translationPath(id),before,after}]);
  return readPageTranslation(directory,value);
}
export async function prunePageTranslationChange(directory,write) {
  const match=/^pages\/(page-(?:\d{3}|[a-f0-9]{12}))\.content\.json$/.exec(write.relative);
  if(!match||!write.before)return null;
  const before=await readTranslationDocument(directory,match[1]);if(!before)return null;
  const after=structuredClone(before),allowed=new Set(translationSources(write.after).map(line=>line.id));
  for(const locale of ['en','ja'])if(after[locale]){
    if(write.after.page_kind==='text'){for(const id of Object.keys(after[locale]))if(!allowed.has(id))delete after[locale][id];}
    else {const entries=after[locale].dialogue??{};for(const id of Object.keys(entries))if(!allowed.has(id))delete entries[id];}
  }
  return hashCanonicalJson(before)===hashCanonicalJson(after)?null:{relative:translationPath(match[1]),before,after};
}
export function localizeLettering(lettering,content,document,locale,{strict=false}={}) {
  requireLetteringLocale(locale);if(locale==='zh'||content.page_kind==='video')return lettering;
  const projection=translationProjection(content,document,locale);
  if(strict&&(projection.summary.missing||projection.summary.stale))fail(`译文未就绪：缺译 ${projection.summary.missing} 条、原文变化 ${projection.summary.stale} 条`);
  const translations=new Map(projection.lines.map(line=>[line.id,line.translation]));
  const settings={...lettering.settings,font_family:'SVTranslation'};
  if(content.page_kind==='text')return {...lettering,locale,settings,display_title:translations.get('display_title')??'',body:translations.get('body')??''};
  return {...lettering,locale,settings,source_dialogue:lettering.dialogue,dialogue:lettering.dialogue.map(line=>({...line,text:translations.get(line.id)??''}))};
}
