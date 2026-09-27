import { readPageEditContext, savePageEditChanges } from './page-edit-context.mjs';
import { generationModels, modelAdapter } from './model-adapters.mjs';
import { pageCanvases } from './page-render-settings.mjs';
import { ApiError } from './http-support.mjs';

function receipt(value) {
  return {...value,save:{operation:'page.render.set',args:Object.fromEntries(Object.entries(value.save.args).filter(([key])=>key!=='section'))},
    options:{models:generationModels.map(({id,label})=>({id,label,default_profile:modelAdapter(id).defaultProfile})),canvases:pageCanvases}};
}
export async function readPageRenderEditor(options) {
  return receipt(await readPageEditContext({...options,section:'render'}));
}
// 同一个事实锁内解析默认 profile，再复用文件指纹与领域原子提交。
export async function setPageRenderEditor(options) {
  const {model_id,profile_id,canvas}=options.settings;
  if ([model_id,profile_id,canvas].every(value=>value===undefined)) throw new ApiError(400,'empty_render_changes');
  const current=await readPageEditContext({...options,section:'render'});
  const changes={...(model_id===undefined?{}:{model_id}),...(canvas===undefined?{}:{canvas}),...(profile_id===undefined?{}:{profile_id})};
  if (model_id!==undefined) {
    let adapter;
    try {adapter=modelAdapter(model_id);} catch {throw new ApiError(400,'invalid_page_model');}
    if(model_id!==current.document.model_id && profile_id===undefined)changes.profile_id=adapter.defaultProfile;
  }
  return receipt(await savePageEditChanges({...options,section:'render',changes}));
}
