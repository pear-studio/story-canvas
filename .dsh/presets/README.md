# StoryCanvas 的 DSH 预设

`cordis.patch.yml` 是新版 DSH 的预设声明来源，本目录是可安装的本地 bundle。
`story-canvas` 保留完整版身份，`story-canvas-lite` 是五工具极简版；两者共用工作台客户端。
旧式 `preset.yml`、`agent.cordis.yml` 和 `agent-presets.roots` 不再用于发现。

在 DSH Plugin Manager 安装本目录；命令行等价入口为
`dsh plugin --profile web add <本目录绝对路径>`。此命令会安装并启用 bundle。
在新会话的预设选择器选“StoryCanvas 创作”或“StoryCanvas 极简”，模型单独选择。
本机已配置的本地模型标识为 `huihui-qwen3.8:27b-ud-q4`，提供方 `ollama-local`。
现有开始对话的会话不会切换到新预设；没有热更新时重启 DSH。

极简版仅呈现 `glob`、`read`、`read_image`、`story_canvas_api`、`story_canvas_facts`。
`glob` 用于发现文件，最多内联40项；通用 `write`、`edit`、`grep` 不向模型提供。
原生文件工具仍由 DSH 提供，作用域过滤同时限制其可见性和执行；不重新实现文件和图片读取。
极简版使用完整自定义 persona，关闭通用提示词及动态上下文，不自动注入完整 AGENTS 或技能目录；
persona 是规则摘要，未覆盖任务按需读取仓库 `AGENTS.md`；用户明确覆盖的本预设动作/关系词数上限为20。
操作速查在 `QUICKSTART.md`，只按需读取。生成、训练、环境维护和开发请用户交给其他 Agent；
缺少必要或方便的工具时说明缺口并请求用户提供，不反复尝试低效绕路。

极简版在约75%上下文或预留输出及4096 token余量的阈值中取较小值触发压缩，
保留最近4096 token，摘要输出上限2048 token；不会主动截断正在编辑的完整事实工具回包。
完整版只为上述本地模型设置4096 token压缩余量与2048 token摘要上限，其他模型沿用原配置。
不要仅调低 AGENTS 字节上限实现精简，以免截断必要规则。

本机模型和提供方不由 bundle 安装；本地路径登记由 DSH profile 管理，不写入仓库共享配置。
