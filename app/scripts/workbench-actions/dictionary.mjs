import { endpoint, jsonArtifact } from './http-action.mjs';
import { string, array, pagination } from './contract.mjs';

const scope={...string('词库范围'),enum:['page','character','render_profile','lora']};
const prompt=string('短语，最多500字');
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
function summary(entry) {
  const result=pick(entry,['prompt_text','matched','allowed','display_text','provider_category','post_count']);
  if(entry.description) {
    result.description=entry.description.slice(0,80);
    if(entry.description.length>80)result.description_truncated=true;
  }
  return result;
}
const status=value=>pick(value,['available','reason']);
export const dictionaryActions={
  'dictionary.search':endpoint('分页搜索词库，返回简短释义','GET','/api/prompt-dictionary',{
    scope,q:string('关键词，最多100字'),...pagination,
  },{required:['scope','q'],query:a=>({...a,limit:a.limit??12}),transform:({value},args)=>({
    ...status(value),items:value.suggestions.map(summary),offset:args.offset??0,
    next_offset:value.has_more?(args.offset??0)+value.suggestions.length:null,
  }),details:'默认12条、最多50条；只返回词条、中文名、频次与最多80字符释义，不返回别名和长文。next_offset 非空可继续翻页。完整释义用 dictionary.inspect，传返回的 prompt_text。'}),
  'dictionary.matches':endpoint('批量检查词条是否存在及适用','POST','/api/prompt-dictionary/matches',{
    scope,prompts:{...array('1–50个短语，每条最多500字',prompt,50),minItems:1},
  },{body:a=>a,transform:({value})=>({...status(value),items:value.matches.map(summary)}),
    details:'每个输入返回 matched、allowed、中文名和简短释义；最多50项，更多请分批。完整描述和别名用 dictionary.inspect，不读取整个 CSV。'}),
  'dictionary.inspect':endpoint('将一个词条的完整解释与别名写入文件','POST','/api/prompt-dictionary/matches',{
    scope,prompt,
  },{body:a=>({scope:a.scope,prompts:[a.prompt]}),transform:({value})=>jsonArtifact(value),
    details:'返回 JSON 文件路径；其中 matches 含完整词条说明、别名和匹配状态，按需 read。未匹配时 matched:false，不代表生成模型一定无法理解。'}),
};
