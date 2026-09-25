// 复用 DSH 原生读文件和读图实现，只保留当前任务需要的模型工具。
import { fileURLToPath } from 'node:url'
import { restrictWorkbench } from '../../app/scripts/workbench-actions/access-policy.mjs'
export const name = 'story-canvas-lite-tools'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx) {
  ctx.systemPrompt.variable('story_canvas_root', () => fileURLToPath(new URL('../../', import.meta.url)))
  const allowed = ['glob', 'read', 'read_image', 'story_canvas']
  const restrictions = new Map()
  const release = id => {
    restrictions.get(id)?.()
    restrictions.delete(id)
  }
  const restrict = agent => {
    if (restrictions.has(agent.id)) return
    restrictions.set(agent.id, ctx.effect(() => {
      const releaseTools = agent.ctx.tools.restrict({ allow: allowed })
      const releaseCapabilities = restrictWorkbench(agent, ['generation', 'training'])
      return () => { releaseCapabilities(); releaseTools() }
    }))
  }
  ctx.on('agent/created', ({ agent }) => { restrict(agent) })
  ctx.on('agent/disposed', ({ agent }) => { release(agent.id) })
  // 空白会话切回完整版时，不能让旧预设的过滤继续附着于同一个 Agent。
  ctx.on('agent-preset/selected', (id, preset) => {
    if (preset !== 'story-canvas-lite') release(id)
  })
  // 空白会话可以切换预设；此时 agent/created 已发生，首次组装时补上限制。
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    if (agent) restrict(agent)
    const assembly = await next()
    return { ...assembly, tools: assembly.tools.filter(tool => allowed.includes(tool.name)) }
  })
}
