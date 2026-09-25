# StoryCanvas 的 DSH 预设

`cordis.patch.yml` 是新版 DSH 的预设声明来源，本目录是可安装的本地 bundle。
`story-canvas` 保留完整版身份，`story-canvas-lite` 是四工具极简版；两者共用工作台客户端。
旧式 `preset.yml`、`agent.cordis.yml` 和 `agent-presets.roots` 不再用于发现。

在 DSH Plugin Manager 安装本目录；命令行等价入口为
`dsh plugin --profile web add <本目录绝对路径>`。此命令会安装并启用 bundle。
在新会话的预设选择器选“StoryCanvas 创作”或“StoryCanvas 极简”，模型单独选择。
本机已配置的本地模型标识为 `huihui-qwen3.8:27b-ud-q4`，提供方 `ollama-local`。
现有开始对话的会话不会切换到新预设；没有热更新时重启 DSH。

极简版仅呈现 `glob`、`read`、`read_image`、`story_canvas`。
`glob` 用于发现文件，最多内联40项；通用 `write`、`edit`、`grep` 不向模型提供。
原生文件工具仍由 DSH 提供，作用域过滤同时限制其可见性和执行；不重新实现文件和图片读取。
极简版使用完整自定义 persona，关闭通用提示词及动态上下文，不自动注入完整 AGENTS 或技能目录；
persona 是规则摘要，未覆盖任务按需读取仓库 `AGENTS.md`；两个预设的动作/关系词数上限统一为20。
`story_canvas` 的 `operation:help` 只返回分类；`target:分类ID` 返回该类简短操作目录，
`target:操作名` 返回详细参数与规则。已知操作名可直接查询详情。
领域操作在 `app/scripts/workbench-actions/` 各自维护参数、帮助与执行，总入口自动汇总。
目录查询通过服务端只读分页入口，仅载入索引和必要显示名，不展开 Prompt 或媒体。
`story-canvas-tools` 是唯一完整能力插件；两个预设加载同一份实现。
极简预设额外加载 `lite-tools` 限制插件，在 Agent 作用域禁用 `generation` 和 `training` 执行能力，
帮助标记为 `disabled`，直接调用也在请求发出前拒绝。退出极简预设或销毁 Agent 时释放限制，不影响其他会话。
所有普通编辑、参考图导入、候选清理、文字布局、已有成品导出、训练数据编辑和只读预检仍可用。
出图、模型重写、超分成品、对比运行、训练启动/续训、自动 Caption 与模型图像准备受执行能力限制。
训练素材导入、裁剪应用和恢复明确跳过自动图像准备，防止普通编辑隐式加载模型。
没有任意 HTTP 路径入口，不能绕过能力限制。操作参数和使用细则只维护在工具实现及其 help 中。
`operation:status` 返回实际加载版本、磁盘版本及是否需要重新加载；工具描述也携带加载版本。
该版本标识工具客户端代码，不代表服务端版本。更新后重启 DSH 并开新会话验收，旧会话不会自动迁移提示词。
极简模式需要被禁用的模型执行能力时请用户交给其他 Agent；
缺少必要或方便的工具时说明缺口并请求用户提供，不反复尝试低效绕路。

极简版在约75%上下文或预留输出及4096 token余量的阈值中取较小值触发压缩，
保留最近4096 token，默认摘要输出上限2048 token；不会主动截断正在编辑的完整事实工具回包。
仅极简预设使用上述本地 Qwen 时，摘要单独由 `deepseek-official/deepseek-flash` 生成，
输出预算4096 token（含推理）；主任务仍由 Qwen 执行，选中的历史会发送到 DeepSeek。
完整版的压缩插件组合与 DSH standard 默认一致，不设置自定义模型策略；默认工具结果裁剪也保持一致。
不要仅调低 AGENTS 字节上限实现精简，以免截断必要规则。

本机模型和提供方不由 bundle 安装；本地路径登记由 DSH profile 管理，不写入仓库共享配置。
