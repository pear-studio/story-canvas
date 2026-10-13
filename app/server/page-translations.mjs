import { readPageContent, readPageEntry } from './pages-store.mjs';
import { encodePageKey } from './page-key.mjs';
import { commitFactChanges } from './fact-commit.mjs';
import { TRANSLATIONS_SCHEMA, requireLetteringLocale, translationPath, readTranslationDocument, translationProjection, validateTranslationDocument } from './page-translation-document.mjs';

const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status,code:'translation_error'});};
export async function readPageTranslation(directory,value) {
  const id=value?.page_key?.page_id;try{encodePageKey({page_id:id});}catch{fail('page_key.page_id 无效',400);}
  if(!await readPageEntry(directory,id))fail('页面已不存在',404);
  const content=await readPageContent(directory,id),document=await readTranslationDocument(directory,id),locale=requireLetteringLocale(value.locale);
  if(locale==='zh')fail('中文使用页面正文编辑入口',400);
  return {page_key:{page_id:id},page_kind:content.page_kind??'illustration',...translationProjection(content,document,locale)};
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
