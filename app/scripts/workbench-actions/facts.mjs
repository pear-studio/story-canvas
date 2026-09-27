import { readFactDraft, readPromptContext, saveFactDraft } from '../workbench-client.mjs';
import { pageKey, jsonArtifact } from './http-action.mjs';
import { editingContext } from './prompt-context-view.mjs';
import { schema, string, object } from './contract.mjs';
const kinds = {
  story: ['outline', 'index', 'synopsis', 'chapter', 'sequence', 'narrative', 'prompt', 'text-sources'],
  character: ['profile', 'visual', 'prompt', 'page-index', 'page-goal', 'page-prompt'],
  scene: ['profile', 'visual', 'prompt'], page: ['content', 'prompt', 'text-sources', 'render'],
};
const identity = { domain: { ...string('事实领域'), enum: Object.keys(kinds) }, kind: string('领域内的事实 kind，见 kinds') };
const draftRules = '只改 draft.document，保留 project_id、target_id 和两个 expected 指纹，完整提交；不只传改动字段。Anima Prompt 新增片段省略 id，由服务端生成；已有片段保留原 id，不自编或复用其他片段 id。目标或上游冲突先重读判断，不替换指纹强行覆盖。有诊断不等于保存失败，分别报告结果，不盲目重放。';
const loraRules = 'Anima 角色/场景 identity.lora 由 variants.<id> 继承，子设定 loras 可追加；页面随引用继承有效 LoRA。子设定或页面的 lora_overrides 按 filename 保存 {weight?,enabled?}，删除对应键恢复继承，不复制上游完整定义；本页 loras 为新增或同名完整替换项。LoRA 新增、删除、替换须先经用户同意。';
const modelRules = 'Prompt 草稿为 {$schema,models:{anima:…,qwen:…}}，按当前模型编辑并保留其他模型。Anima 使用 identity、子设定分类词条及页面 inheritance；Qwen 使用 prompt_name、variants 中的 text/reference_images，以及页面 text_overrides/reference_overrides。Qwen standalone 直接使用本页全文与附图，不追加设定文字。不要跨模型套字段，当前结构以 read/context 返回为准。';
export const factActions = {
  'facts.read': {
    summary: '读取目标的完整可写事实草稿',
    parameters: schema({ ...identity, project_id: string('项目 ID'), target_id: string('目标 ID；项目级 outline/index/synopsis 省略') }, ['domain', 'kind', 'project_id']),
    kinds, targets: { story: 'outline/index/synopsis 无 target_id；chapter/sequence 用对应 ID；narrative/prompt/text-sources 用页面 ID', character: 'profile/visual/prompt/page-index 用角色 ID；page-goal/page-prompt 用页面 ID', scene: 'profile/visual/prompt 用场景 ID', page: '所有 kind 用页面 ID' },
    details: `先用列表和索引定位目标，仅读取需要的章节、单元或页面；浏览目录用 chapter.list/sequence.list/character.list/scene.list/page.list。profile 编辑显示名与设定正文；visual 编辑子设定显示名；子设定 ID 变更使用 variant.rename。返回 {draft,save}，只改 draft.document；save 指明保存入口与固定参数，提交时添加 draft，不把整个返回包当成草稿。不分页、不截断。${draftRules} ${modelRules} 页面局部编辑优先用 page.editor.read/save；只有需要展开引用或检查最终输入时才用 prompt.context。`,
    example: { domain: 'story', kind: 'outline', project_id: 'demo' },
    execute: async ({ domain, kind, project_id, target_id }) => ({draft: await readFactDraft(domain, kind, project_id, target_id), save: {operation: 'facts.save', args: {domain, kind}, draft_parameter: 'draft'}}),
  },
  'facts.save': {
    summary: '提交完整事实草稿并校验指纹', parameters: schema({ ...identity, draft: object('facts.read 或 prompt.context 返回的完整 draft') }),
    example: {domain:'character',kind:'prompt',draft:{project_id:'demo',target_id:'alice',document:{},expected_sha256:'读取值',expected_context_sha256:'读取值'}},
    recover:(_error,a)=>({message:'按 details 中的字段说明修正；重新读取并核验目标，原样保留指纹，不直接换新指纹覆盖。',next:{operation:'facts.read',args:{domain:a.domain,kind:a.kind,project_id:a.draft?.project_id,target_id:a.draft?.target_id??undefined}}}),
    kinds, details: `${draftRules} ${modelRules} ${loraRules}`, execute: ({ domain, kind, draft }) => saveFactDraft(domain, kind, draft),
  },
  'prompt.context': {
    summary: '按需展开页面引用与最终 Prompt',
    parameters: schema({ project_id: string('项目 ID'), page_key: pageKey, view:{type:'string',enum:['edit','details'],description:'默认 edit：精简编辑上下文；details：完整编译追踪写入文件，返回路径'} },['project_id','page_key']),
    details: `仅在需要理解上游引用或诊断最终输入时调用；普通编辑用 page.editor.read/save，不要求组装后全文核验，不用于遍历全项目。检查 context 中的当前模型、上游引用、整段覆盖、参考图与编译结果；只改 draft.document，再按返回的 save.operation 和 save.args 提交完整 draft。不回写只读 context，不覆盖无关模型数据。默认 edit 保留完整草稿、上游原文/词条、参考图选择、最终正负向输入和异常；不重复本页正文与编译追踪。references 按来源键索引，inherited 按分类列原文或 {text,weight,enabled}；本页覆盖与继承调整见 draft.document。view:details 返回完整追踪文件，按需 read/grep，不提交为草稿。${modelRules} ${loraRules}`,
    example: { project_id: 'demo', page_key: { page_id: 'page-001' } },
    execute: async ({ project_id, page_key, view='edit' }) => {
      const pack=await readPromptContext(project_id,page_key);
      if(view==='details')return jsonArtifact(pack);
      return {...pack,context:editingContext(pack.context),save:{operation:'facts.save',args:pack.save,draft_parameter:'draft'}};
    },
  },
};
