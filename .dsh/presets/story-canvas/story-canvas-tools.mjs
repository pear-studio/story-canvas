// DSH 只负责注册；领域操作的执行与帮助由各自模块一起维护。
import { executeWorkbench, loadedRevision, toolParameters } from '../../../app/scripts/workbench-actions/index.mjs'
export const name = 'story-canvas-tools'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register({
    name: 'story_canvas',
    description: `StoryCanvas 完整工作台（${loadedRevision}）。动态页先 operation:help,target:video，一次取得完整流程与参数。其他任务 help 列分类；target:分类ID 列操作；target:操作名 查详细用法。生成后 task.wait 省略 wait_ms，按图片/视频与批量大小选择固定等待档位，工具内轮询。status 检查版本和会话限制。用 operation 和 args 执行。`,
    parameters: toolParameters,
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: executeWorkbench,
  })
}
