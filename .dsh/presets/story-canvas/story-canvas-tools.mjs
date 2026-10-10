// DSH 只负责注册；领域操作的执行与帮助由各自模块一起维护。
import { executeWorkbench, loadedRevision, toolParameters } from '../../../app/scripts/workbench-actions/index.mjs'
import { fileURLToPath } from 'node:url'
export const name = 'story-canvas-tools'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx) {
  ctx.systemPrompt.variable('story_canvas_root', () => fileURLToPath(new URL('../../../', import.meta.url)))
  ctx.tools.register({
    name: 'story_canvas',
    description: `StoryCanvas 工作台（${loadedRevision}）。help 列分类；target:分类ID 列操作；target:操作名 查参数、副作用和恢复，topic 查字段细则。动态页查 target:video。status 检查版本和限制。用 operation 与 args 执行。`,
    parameters: toolParameters,
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: executeWorkbench,
  })
}
