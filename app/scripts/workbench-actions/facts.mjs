import { readFactDraft, readPromptContext, saveFactDraft } from '../workbench-client.mjs';
import { pageKey } from './http-action.mjs';
import { schema, string, object } from './contract.mjs';
const kinds = {
  story: ['outline', 'index', 'synopsis', 'chapter', 'sequence', 'narrative', 'prompt', 'text-sources'],
  character: ['profile', 'visual', 'prompt', 'page-index', 'page-goal', 'page-prompt'],
  scene: ['profile', 'visual', 'prompt'], page: ['content', 'prompt', 'text-sources', 'render'],
};
const identity = { domain: { ...string('事实领域'), enum: Object.keys(kinds) }, kind: string('领域内的事实 kind，见 kinds') };
const draftRules = '只改 draft.document，保留 project_id、target_id 和两个 expected 指纹，完整提交；不只传改动字段。Anima Prompt 新增片段省略 id，由服务端生成；已有片段保留原 id，不自编或复用其他片段 id。目标或上游冲突先重读判断，不替换指纹强行覆盖。有诊断不等于保存失败，分别报告结果，不盲目重放。';
const loraRules = 'Anima 角色/场景 identity.lora 由 variants.<id> 继承，子设定 loras 可追加；页面随引用继承有效 LoRA。子设定或页面的 lora_overrides 按 filename 保存 {weight?,enabled?}，删除对应键恢复继承，不复制上游完整定义；本页 loras 为新增或同名完整替换项。LoRA 新增、删除、替换须先经用户同意。';
export const factActions = {
  'facts.read': {
    summary: '读取目标的完整可写事实草稿',
    parameters: schema({ ...identity, project_id: string('项目 ID'), target_id: string('目标 ID；项目级 outline/index/synopsis 省略') }, ['domain', 'kind', 'project_id']),
    kinds, targets: { story: 'outline/index/synopsis 无 target_id；chapter/sequence 用对应 ID；narrative/prompt/text-sources 用页面 ID', character: 'profile/visual/prompt/page-index 用角色 ID；page-goal/page-prompt 用页面 ID', scene: 'profile/visual/prompt 用场景 ID', page: '所有 kind 用页面 ID' },
    details: `先用列表和索引定位目标，仅读取需要的章节、单元或页面；浏览目录用 chapter.list/sequence.list/character.list/scene.list/page.list。profile 编辑显示名与设定正文；visual 编辑子设定显示名；子设定 ID 变更使用 variant.rename。返回完整草稿，不分页、不截断。${draftRules} 编辑页面 Prompt 应先用 prompt.context。`,
    example: { domain: 'story', kind: 'outline', project_id: 'demo' },
    execute: ({ domain, kind, project_id, target_id }) => readFactDraft(domain, kind, project_id, target_id),
  },
  'facts.save': {
    summary: '提交完整事实草稿并校验指纹', parameters: schema({ ...identity, draft: object('facts.read 或 prompt.context 返回的完整 draft') }),
    kinds, details: `${draftRules} ${loraRules}`, execute: ({ domain, kind, draft }) => saveFactDraft(domain, kind, draft),
  },
  'prompt.context': {
    summary: '编辑前取得单页完整 Prompt 上下文和草稿',
    parameters: schema({ project_id: string('项目 ID'), page_key: pageKey }),
    details: `仅在编辑该页 Prompt 时调用；不用于遍历全项目。检查 context 中的当前模型、上游引用、整段覆盖、参考图与编译结果；只改 draft.document，再按返回的 save.domain/kind 用 facts.save 提交完整 draft。不回写只读 context，不覆盖无关模型数据。完整上下文不截断。${loraRules}`,
    example: { project_id: 'demo', page_key: { page_id: 'page-001' } },
    execute: ({ project_id, page_key }) => readPromptContext(project_id, page_key),
  },
};
