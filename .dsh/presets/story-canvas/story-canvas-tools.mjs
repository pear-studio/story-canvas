// StoryCanvas 工作台薄适配：把仓库共用 HTTP/事实客户端注册为两个 DSH 工具。
// 零依赖 ESM 模块插件：具名导出 name/apply。仓库根由本文件位置推导，不依赖会话 cwd。
// 领域契约、路由与编辑纪律见仓库 docs/reference/agent-interfaces.md，本模块不复制 API 知识。
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
  registerTool(ctx, {
    name: 'story_canvas_api',
    description: 'StoryCanvas 本地工作台通用 JSON 请求。始终返回 { value, revision }；revision 可回传给需要版本的写接口。'
      + '路由、请求体形状与编辑纪律以仓库 docs/reference/agent-interfaces.md 为准；path 必须以 /api/ 开头。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'path'],
      properties: {
        method: { type: 'string', enum: METHODS },
        path: { type: 'string', description: '/api/ 开头的工作台路由' },
        body: { type: 'object', description: 'POST/PUT 请求体' },
        revision: { type: 'string', description: '写入 x-story-canvas-expected-revision 的版本' },
      },
    },
    output: { schema: {}, render: (_args, value) => renderJson(value) },
    async execute(args) {
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
    description: 'StoryCanvas 事实编辑：read 读取裸草稿（含身份与两个指纹），save 提交完整草稿，prompt-context 读取页面完整 Prompt 上下文。'
      + '支持的 domain/kind 与服务端校验见仓库 docs/reference/agent-interfaces.md。'
      + '编辑纪律：读取上下文后只改 draft.document，保留身份与指纹；prompt-context 后用 save 提交草稿（按其 save.domain/kind），冲突后重新读取判断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['read', 'save', 'prompt-context'] },
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
      throw asError('operation 必须是 read/save/prompt-context', 'invalid_arguments')
    },
  })
}

export function apply(ctx) {
  registerStoryCanvasApi(ctx)
  registerStoryCanvasFacts(ctx)
}
