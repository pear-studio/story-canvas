# Agent 操作接口

工作台语义操作是首选入口。通用纪律见 [AGENTS](../../AGENTS.md)，目录归属见 [项目文件](project-files.md)。参数、可选值和限制只维护在操作 help 与 Schema，不重复列举。

## 工具与 CLI

有 DSH `story_canvas` 时直接使用；`operation:help` 返回分组，`target` 查询分类、操作或字段主题。CLI 共用同一注册表：

```powershell
node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs help
node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs help facts
node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs help prompt.save
node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs <操作名> --args <参数JSON绝对路径> --out <回执JSON绝对路径>
```

`--out` 写成功或失败回执。失败和批量部分失败退出码为 1，检查逐项结果，不能重放成功项。操作完成但回执落盘失败时，先查询结果。

`status` 显示已加载版本；DSH 返回 `reload_required:true` 时需重载，磁盘新代码不代表工具已加载。极简预设禁用生成与训练执行，help 和执行均遵守限制。

CLI 连接 `Config/local.json` 配置的本机 Node 服务，默认端口 3000；连接失败返回 `workbench_unavailable`，没有离线写入后备。

## 找操作

| 任务 | help 分类或入口 |
|---|---|
| 项目登记、设置与生命周期 | `project` |
| 故事、seq、角色、场景、子设定、页面导航 | `structure`、`settings`、`page` |
| 正文、Prompt 与语料 | `facts`；Prompt 查 `prompt.read` / `prompt.save` |
| 模型配置、生成与依赖检查 | `generation` |
| 参考图、材料与约定 | `materials` |
| 候选读取和清理 | `candidates` |
| 嵌字、成品与导出 | `finished` |
| 任务等待、取消与队列 | `tasks` |
| 资源、词库与环境 | `resources`、`runtime` |
| 训练素材、图像处理与训练运行 | `training-data`、`training-image`、`training` |
| 按需对比 | `comparison` |

## 编辑回执

- `facts.read`：非 Prompt 正文及目标、上下文指纹；文件式旧 CLI 使用 document read/save。
- `page.editor.read`：页面 content 或 render 全文及 save 回执；多页内容用对应 batch 操作。
- `prompt.read`：单模型编辑范围及 save 回执；`prompt.sources` 查引用来源，`prompt.context` 只读展开输入。
- `page.render.read/set`：只改本页模型、配置或画幅；项目默认配置用于新页。
- 保存使用读取回执给出的参数，并按操作契约提交 changes 或 document；局部保存由服务端合并，回包返回相关全文。旧 Prompt 事实接口不再支持编辑。

目标与必要依赖指纹用于判断内容变化；短暂 busy 与内容冲突不同。训练另用 ETag / If-Match，素材与当前设置视图共享版本，不使用剧情项目 revision。

## 生成与长任务

`generation.page.inspect` 只检查输入和依赖，ready 不保证 ComfyUI 在线；`generation.run` 从提交时最新事实冻结输入，执行与候选发布不改创作事实。

保存提交回执的任务身份，用 `task.wait` 等待同一任务；超时按回执续等，停止等待不取消任务。取消用明确任务操作。排队时路径不代表成果已存在，以 `task.results` / `candidate.list` 返回的已发布路径为准。候选操作见 [视觉页面](visual-pages.md)。

## HTTP 补充入口

语义操作未覆盖的现有能力才查代码并使用 `app/scripts/workbench-api.mjs`，不另维护路由清单。该 CLI 返回 `{ value, revision }`，不改请求体、不自动重试；接口要求版本时沿用读取版本。上传与流式媒体走专用入口，DSH 极简模式不提供任意 HTTP 绕过。
