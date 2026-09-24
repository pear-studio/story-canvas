// StoryCanvas 工作台薄适配：把仓库共用 HTTP/事实客户端注册为两个 DSH 工具。
// 零依赖 ESM 模块插件：具名导出 name/apply。仓库根由本文件位置推导，不依赖会话 cwd。
// 工具使用说明随工具维护；help 按主题返回，不把完整手册常驻模型上下文。
import { readFactDraft, readPromptContext, requestWorkbench, saveFactDraft } from '../../../app/scripts/workbench-client.mjs'
import { decodePageKey } from '../../../app/server/page-key.mjs'

export const name = 'story-canvas-tools'
export const inject = ['tools']

const METHODS = ['GET', 'POST', 'PUT', 'DELETE']

const asError = (message, code) => Object.assign(new Error(message), { code })

const renderJson = value => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

// DSH 只把普通异常的 message 呈现给模型；把完整诊断放进文本，仍抛出异常以保持失败状态。
function registerTool(ctx, definition) {
  ctx.tools.register({
    ...definition,
    async execute(...args) {
      try {
        return await definition.execute(...args)
      } catch (error) {
        throw new Error(JSON.stringify({
          error: error.code ?? 'tool_failed',
          message: error.message,
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.details === undefined ? {} : { details: error.details }),
        }), { cause: error })
      }
    },
  })
}

function registerStoryCanvasApi(ctx) {
  const help = {
    projects: {
      usage: '以下请求通过本工具 method/path/body 发送。先查询登记，使用真实 ID；路径中的 ID 须 URL 编码。',
      requests: [
        { method: 'GET', path: '/api/project-library', purpose: '查询剧情和训练项目的 ID、路径、temporary、available；结果在 value.projects。' },
        { method: 'POST', path: '/api/project-library/{id}/copy', body: {}, purpose: '创建临时副本：复制事实与输入，不复制旧 Git、生成结果、训练历史或缓存；使用回执 value.id 定位副本。' },
        { method: 'POST', path: '/api/project-library/{id}/promote', body: { path: '不存在的外部绝对目录' }, purpose: '临时项目提升为正式项目：完整复制并核验，保留成果，初始化 Git，更新登记后移除临时目录。' },
        { method: 'POST', path: '/api/project-library/{id}/forget', body: {}, purpose: '只移除登记，保留文件和 Git。' },
        { method: 'POST', path: '/api/project-library/{id}/delete', body: {}, purpose: '删除临时项目及全部文件；仅允许 workspace 直接子目录，执行前确认用户已授权删除。' },
        { method: 'POST', path: '/api/project-library/open', body: { path: '已有项目绝对目录' }, purpose: '登记已有项目，不复制。' },
        { method: 'POST', path: '/api/project-library/{id}/relocate', body: { path: '已移动后的项目绝对目录' }, purpose: '更新路径登记，不搬运文件。' },
        { method: 'GET', path: '/api/project-library/{id}/git', purpose: '只读 Git 状态。' },
      ],
      rules: '这些接口不要求 revision。copy/promote/delete 要求没有活动任务；遇到失败先检查原因，不盲目重放。',
    },
    pages: {
      usage: '先用 story_canvas_facts read story/outline 和 story/index 获取章节、单元和页面 ID；路径中的项目 ID 须 URL 编码。',
      revision: '先 GET /api/projects/{id}/revision，取 value.revision 作为本工具 revision 参数。每次修改后使用最新版本；409 后重读判断，不自动重放。',
      path: '/api/projects/{id}/workbench/navigation/{action}',
      method: 'POST',
      actions: [
        { action: 'create-sequence', body: { chapter_id: '章节ID', title: '已确认标题' } },
        { action: 'create-story-page', body: { sequence_id: '单元ID' } },
        { action: 'duplicate-story-page', body: { page_id: '页面ID' } },
        { action: 'delete-story-page', body: { page_id: '页面ID' } },
      ],
      rules: '创建、复制、删除必须走语义接口，不能只改索引模拟；排序用 story_canvas_facts read/save story/index 并保留字段结构。',
    },
    'project-create': {
      steps: [
        { method: 'POST', path: '/api/agent/project-create/template', body: { project_id: '新项目ID' } },
        '只修改返回模板 value.document，再把完整模板作为 body 提交下一请求，不只传 document。',
        { method: 'POST', path: '/api/agent/project-create/create' },
      ],
      rules: '创建干净剧情项目，不复制现有项目；不要求 revision。',
    },
  }
  registerTool(ctx, {
    name: 'story_canvas_api',
    description: 'StoryCanvas JSON API，返回 { value, revision }。用 help 按需查询项目管理、页面管理或新建项目用法；help 不发送请求。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        help: { type: 'string', enum: Object.keys(help), description: '仅传 help 查询说明；执行请求时传 method/path。' },
        method: { type: 'string', enum: METHODS },
        path: { type: 'string', description: '/api/ 开头的工作台路由' },
        body: { type: 'object', description: 'POST/PUT 请求体' },
        revision: { type: 'string', description: '写入 x-story-canvas-expected-revision 的版本' },
      },
    },
    output: { schema: {}, render: (_args, value) => renderJson(value) },
    async execute(args) {
      if (args?.help !== undefined) {
        if (Object.keys(args).length !== 1 || !Object.hasOwn(help, args.help)) throw asError('help 必须单独使用，主题为 projects/pages/project-create', 'invalid_arguments')
        return help[args.help]
      }
      const { method, path: route, body, revision } = args ?? {}
      if (!METHODS.includes(method)) throw asError(`method 必须是 ${METHODS.join('/')}`, 'invalid_arguments')
      if (typeof route !== 'string' || !route.startsWith('/api/')) throw asError('path 必须以 /api/ 开头', 'invalid_arguments')
      if (body !== undefined && (typeof body !== 'object' || body === null)) throw asError('body 必须是对象', 'invalid_arguments')
      if (revision !== undefined && typeof revision !== 'string') throw asError('revision 必须是字符串', 'invalid_arguments')
      return requestWorkbench(route, { method, body, revision })
    },
  })
}

function registerStoryCanvasFacts(ctx) {
  registerTool(ctx, {
    name: 'story_canvas_facts',
    description: 'StoryCanvas 事实编辑：read/save 完整草稿；编辑 Prompt 先 prompt-context。operation:help 按需查看字段、编辑规则；不会发送请求。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['help', 'read', 'save', 'prompt-context'] },
        domain: { type: 'string', description: 'story | character | scene | page（合法性以服务端为准）' },
        kind: { type: 'string', description: '事实 kind，如 outline / narrative / prompt / profile' },
        project_id: { type: 'string' },
        target_id: { type: 'string', description: '目标 id；项目级 kind 可省略' },
        draft: { type: 'object', description: 'save 的完整草稿（含 project_id、target_id、document、expected_sha256、expected_context_sha256）' },
        page_key: { type: 'string', description: 'prompt-context 的页面键，如 v3/page-001 或裸 page-id' },
      },
    },
    output: { schema: {}, render: (_args, value) => renderJson(value) },
    async execute(args) {
      const { operation, domain, kind, project_id: projectId, target_id: targetId, draft, page_key: pageKey } = args ?? {}
      if (operation === 'help') {
        if (Object.keys(args).length !== 1) throw asError('operation:help 不接受其他参数', 'invalid_arguments')
        return {
          read: { operation: 'read', domain: 'story', kind: 'outline', project_id: '实际项目ID' },
          kinds: {
            story: ['outline', 'index', 'synopsis', 'chapter', 'sequence', 'narrative', 'prompt', 'text-sources'],
            character: ['profile', 'visual', 'prompt', 'page-index', 'page-goal', 'page-prompt'],
            scene: ['profile', 'visual', 'prompt'],
            page: ['content', 'prompt', 'text-sources', 'render'],
          },
          target: '项目级 outline/index/synopsis 不传 target_id；其他 kind 按目标传真实 ID（chapter/sequence 为章节/单元，profile/visual 为角色或场景，页面事实为页面）。字段结构以 read 返回为准，不猜草稿。',
          save: 'read 返回裸草稿。仅修改 document，保留 project_id、target_id、expected_sha256、expected_context_sha256；用 {operation:"save",domain,kind,draft:完整草稿} 提交，不只传改动字段。',
          prompt: '先 {operation:"prompt-context",project_id,page_key:"v3/实际页面ID"}；检查只读 context 中的模型、上游引用、整段覆盖和参考图。只修改 draft.document，按返回 save.domain/kind 保存完整 draft，不回写 context，不覆盖其他模型数据。',
          conflicts: '目标或上游冲突先重新读取和判断，不换指纹强行提交。保存结果和诊断分别报告，有诊断不等于没保存，不盲目重放。',
          lifecycle: '项目和页面的创建/复制/删除用 story_canvas_api；其 help:projects/pages/project-create 提供用法。',
        }
      }
      const requireString = (value, field) => {
        if (typeof value !== 'string' || !value) throw asError(`${operation} 需要字符串参数 ${field}`, 'invalid_arguments')
        return value
      }
      if (operation === 'read') {
        requireString(domain, 'domain'); requireString(kind, 'kind')
        return readFactDraft(domain, kind, requireString(projectId, 'project_id'), targetId)
      }
      if (operation === 'save') {
        requireString(domain, 'domain'); requireString(kind, 'kind')
        if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw asError('save 需要对象参数 draft', 'invalid_arguments')
        return saveFactDraft(domain, kind, draft)
      }
      if (operation === 'prompt-context') {
        requireString(projectId, 'project_id')
        return readPromptContext(projectId, decodePageKey(requireString(pageKey, 'page_key')))
      }
      throw asError('operation 必须是 help/read/save/prompt-context', 'invalid_arguments')
    },
  })
}

export function apply(ctx) {
  registerStoryCanvasApi(ctx)
  registerStoryCanvasFacts(ctx)
}
