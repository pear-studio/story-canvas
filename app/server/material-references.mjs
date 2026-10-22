import path from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {ApiError} from './http-support.mjs';
import {imageSourceFiles} from '../shared/image-layers.mjs';

// 删除保护包括关闭的图层；输出依赖查询则只取启用图层。
export async function materialReferences(directory,file){
  const references=[];
  for(const folder of ['pages','characters','scenes']){
    const entries=await readdir(path.join(directory,folder)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    for(const name of entries){
      if(!/\.(prompt|layers|collage)\.json$/.test(name))continue;
      const doc=JSON.parse(await readFile(path.join(directory,folder,name),'utf8'));
      const used=name.endsWith('.prompt.json')?JSON.stringify(doc).includes(JSON.stringify(file)):
        [...(doc.items??[]),...(doc.background?[doc.background]:[])].some(item=>imageSourceFiles(doc.assets?.[item.asset_id]).includes(file));
      if(used)references.push(`${folder}/${name}`);
    }
  }
  return references;
}
export async function assertMaterialUnused(directory,file){
  const references=await materialReferences(directory,file);
  if(references.length)throw new ApiError(409,'material_in_use',['素材仍被引用，请先移除引用（包括关闭的图层）',...references]);
}
