import { readFactDraft, readPromptContext, saveFactDraft } from '../workbench-client.mjs';
import { pageKey, jsonArtifact } from './http-action.mjs';
import { editingContext } from './prompt-context-view.mjs';
import { schema, string, object } from './contract.mjs';
const kinds = {
  story: ['outline', 'index', 'synopsis', 'chapter', 'sequence', 'narrative', 'text-sources'],
  character: ['profile', 'visual', 'page-index', 'page-goal'],
  scene: ['profile', 'visual'], page: ['content', 'text-sources', 'render'],
};
const identity = { domain: { ...string('事实领域'), enum: Object.keys(kinds) }, kind: string('领域内的事实 kind，见 kinds') };
const draftRules = '只改 draft.document，保留 project_id、target_id 和两个 expected 指纹，完整提交；不只传改动字段。目标或上游冲突先重读判断，不替换指纹强行覆盖。有诊断不等于保存失败，分别报告结果，不盲目重放。Prompt 已迁往 prompt.read/save；不再用 facts 的 prompt/page-prompt 分支。';
const loraRules = 'Anima 角色/场景 identity.lora 由 variants.<id> 继承，子设定 loras 可追加；页面随引用继承有效 LoRA。子设定或页面的 lora_overrides 按 filename 保存 {weight?,enabled?}，删除对应键恢复继承，不复制上游完整定义；本页 loras 为新增或同名完整替换项。LoRA 新增、删除、替换须先经用户同意。';
export const factActions = {
  'facts.read': {
    summary: '读取目标的完整可写事实草稿',
    parameters: schema({ ...identity, project_id: string('项目 ID'), target_id: string('目标 ID；项目级 outline/index/synopsis 省略') }, ['domain', 'kind', 'project_id']),
    kinds, targets: { story: 'outline/index/synopsis 无 target_id；chapter/sequence 用对应 ID；narrative/text-sources 用页面 ID', character: 'profile/visual/page-index 用角色 ID；page-goal 用页面 ID', scene: 'profile/visual 用场景 ID', page: '所有 kind 用页面 ID' },
    details: `先用列表和索引定位目标，仅读取需要的章节、单元或页面；浏览目录用 chapter.list/sequence.list/character.list/scene.list/page.list。profile 编辑显示名与设定正文；visual 编辑子设定显示名；子设定 ID 变更使用 variant.rename。返回 {draft,save}，只改 draft.document；save 指明保存入口与固定参数，提交时添加 draft，不把整个返回包当成草稿。不分页、不截断。${draftRules} 页面内容和render局部编辑优先 page.editor.read/save；Prompt 用 prompt.read/save。`,
    example: { domain: 'story', kind: 'outline', project_id: 'demo' },
    execute: async ({ domain, kind, project_id, target_id }) => ({draft: await readFactDraft(domain, kind, project_id, target_id), save: {operation: 'facts.save', args: {domain, kind}, draft_parameter: 'draft'}}),
  },
  'facts.save': {
    summary: '提交非 Prompt 的完整事实草稿并校验指纹', parameters: schema({ ...identity, draft: object('facts.read 返回的完整 draft') }),
    example: {domain:'character',kind:'profile',draft:{project_id:'demo',target_id:'alice',document:{},expected_sha256:'读取值',expected_context_sha256:'读取值'}},
    recover:(_error,a)=>({message:'按 details 中的字段说明修正；重新读取并核验目标，原样保留指纹，不直接换新指纹覆盖。',next:{operation:'facts.read',args:{domain:a.domain,kind:a.kind,project_id:a.draft?.project_id,target_id:a.draft?.target_id??undefined}}}),
    kinds, details: draftRules, execute: ({ domain, kind, draft }) => saveFactDraft(domain, kind, draft),
  },
  'prompt.context': {
    summary: '按需展开页面引用与最终 Prompt',
    parameters: schema({ project_id: string('项目 ID'), page_key: pageKey, view:{type:'string',enum:['edit','details','final','render','sources'],description:'默认 final 最终输入；render 有效配置与 LoRA；sources 来源；edit 只读上下文；details 完整诊断文件'}, source:string('仅 sources：精确来源键，省略只列来源索引') },['project_id','page_key']),
    details: `本操作全部只读，默认 final。render 返回实际有效 LoRA 及各层来源/覆盖，null表示无法确认。sources 可精确筛选；编辑继承优先 prompt.sources，它提供稳定词键和来源版本。普通编辑用 prompt.read/save，不要求读取组装全文。edit 仅只读上下文和编辑入口；details返回完整诊断文件，不包含可写draft/save。不回写展开结果。${loraRules}`,
    example: { project_id: 'demo', page_key: { page_id: 'page-001' } },
    execute: async ({ project_id, page_key, view='final', source }) => {
      if(source && view!=='sources')throw Object.assign(new Error('source 仅用于 sources 视图'),{code:'invalid_arguments'});
      const pack=await readPromptContext(project_id,page_key);
      if(view==='details')return {...await jsonArtifact({page_key:pack.page_key,context:pack.context}),fields:['context.final','context.configuration','context.references'],read:'优先使用 final/render/sources 窄视图；文件仅作完整诊断。'};
      const status={page_key:pack.page_key,status:pack.context.status,diagnostics:pack.context.diagnostics};
      if(view==='final')return {...status,final:editingContext(pack.context).final};
      if(view==='render')return {...status,...pack.context.configuration};
      if(view==='sources') {
        const references=pack.context.references.filter(ref=>!source||ref.source===source);
        if(source&&!references.length)throw Object.assign(new Error('未知来源键，可用：'+pack.context.references.map(r=>r.source).join(', ')),{code:'invalid_arguments'});
        return {...status,references:source ? references : references.map(ref=>({source:ref.source,name:ref.prompt_name,kind:ref.kind,overridden:ref.override!==null || Object.keys(ref.adjustments??{}).length>0,images:ref.reference_images?.length??0}))};
      }
      return {page_key:pack.page_key,context:editingContext(pack.context),edit:{operation:'prompt.read',args:{project_id,target:{kind:'page',id:page_key.page_id}}}};
    },
  },
};
