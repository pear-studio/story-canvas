# 开发入口

本文只维护当前代码入口与验证方式。系统边界和已经确认的演进方向见[架构](architecture.md)，
其他稳定文档见[开发文档导航](README.md)。创作任务不要从开发代码猜流程，应从
[任务入口](../start-here.md) 选择对应文档和技能。

## 当前实现

- React 工作台以完整 `PageKey` 打开统一视觉页面工作区；剧情按章节导航，角色节点同时提供
  稳定设定和多个视觉页面；场景采用相同层级，三类归属共用页面内容、Prompt、候选和嵌字工作区；
- Node.js 本地服务通过当前项目文件读取工作台视图，并提供单页内容、页面 Prompt、角色 profile/visual、角色 Prompt/LoRA、
  项目嵌字设置、单页嵌字布局、只读流程预览和候选生成/删除等领域入口，以及确定性页面编译、配置诊断、PageKey 生成任务、词库和媒体接口；
- 项目操作由 `app/server/project-operations.mjs` 统一执行。所有项目操作路由显式使用
  `readFacts`、`mutateFacts`、`mutateTargetFacts`、`deriveFromFacts`、`mutateDerived`、`copyProject` 或 `renameProject`，
  由服务端路由直接选择对应 Interface；项目媒体和静态文件不属于项目操作 Interface，但浏览器仍经
  `readProjectResource` Interface 读取；非项目接口使用普通请求，HTTP 层只解析项目凭据和返回 revision；
  LoRA 已移到独立全局训练操作边界；生命周期只通过专用的
  `copyProject`／`renameProject` Interface，媒体流在锁外发送；
- 图片生成由 `app/server/page-render-resolver.mjs` 直接读取当前页面、Prompt、角色与生成配置，
  `app/server/page-render.mjs` 原子保存正式任务并排队；`app/server/render-project-runtime.mjs` 只读取
  已冻结的 task ID、执行预检并调用 ComfyUI。Agent 使用 `visual:produce` 生成一至三张候选；当前
  Anima 与 Qwen profile 支持 candidates；Qwen 另支持页面单参考图，见 [Qwen 接入](qwen-image.md)；浏览器单页生成入口真实建立同一任务，不再提供选用入口；
- LoRA 训练由 `app/server/lora-training-module.mjs` 组合四个深 Module：`lora-training-facts.mjs`
  负责全局训练事实与 Caption，`lora-training-plan.mjs` 负责环境、方案和 frozen manifest，
  `lora-training-runtime.mjs` 负责只消费 manifest 的运行时，`lora-training-media.mjs` 负责图片后处理；
  `lora-training.mjs` 仅提供脚本和领域测试的稳定导出入口。浏览器页面位于
  `app/src/LoraTrainingView.tsx`，独立入口为 `/api/lora-training`，事实保存在登记的独立训练项目；版本清单和预设位于 `library/lora-training/`；
- 剧情文案使用稳定 ID 和明确表达语义；工作台按项目统一样式保存归一化文字布局，在当前候选预览上通过 DOM 直接拖动文字，支持选定候选后超分、嵌字和系列成品导出，见 [成品输出](finished-pages.md)。

## 代码位置

选择控件的公共样式位于 `app/src/styles.css`。桌面精确指针环境在支持时通过
`appearance: base-select` 美化原生下拉菜单；触屏保持系统原生选择面板，不替换成网页列表。
复选框和单选按钮保留原生语义、键盘与禁用状态，触屏标签提供至少 44px 高的点按区域。
`npm --prefix <仓库根>/app run test:selection-ui` 验证桌面键盘与触屏模拟；手机系统弹层的实际
外观仍需真机确认。该 CSS 特性对移动端面板的影响见 [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/appearance)。

| 路径 | 作用 |
|---|---|
| `app/src/` | React 工作台 |
| `app/vite.config.ts` | 前端构建与热更新；按目录名排除 `data.local`、`Saved`、`workspace`（只匹配同名目录，不约定仓库内的具体路径），避免本机素材与运行产物拖慢 Node 服务 |
| `app/src/App.tsx` | 工作台项目载入、显式保存和当前视图协调 |
| `app/src/workbench-navigation.ts` | 导航位置、标签/页面/角色切换和快照刷新后的同组回退规则；App 统一接纳并同步 URL |
| `app/src/navigation-history.ts` / `NavigationSearch.tsx` | 项目内会话浏览历史、分区归属和当前项目内容搜索 |
| `app/src/ProjectNavigationHome.tsx` | 设置、参考材料与任务历史的项目管理入口 |
| `app/src/workbench-page-patch.ts` | 单页保存后视图局部更新，整文档指纹（如嵌字 layout_sha256）广播到全部剧情页 |
| `app/src/project-request-guard.ts` | 项目切换和载入请求的 stale 响应保护 |
| `app/src/project-workbench-client.ts` | 工作台事实、当前页媒体和嵌字的明确读写入口 |
| `app/src/project-snapshot-sync.ts` | 独立事实视图的同版本快照准备与统一应用 |
| `app/src/workbench-snapshot-sync.ts` | 工作台初次加载、刷新和导航操作后的统一快照接纳：请求竞态、写入代次、关联视图与 revision 一起应用；导航意图由入口保留 |
| `app/src/WorkbenchPageEditor.tsx` | 页面内容、Prompt、嵌字与流程预览的手动保存编辑器 |
| `app/src/StoryOverview.tsx` | 可编辑梗概／摘要与只读分镜总览，页面编辑跳转到唯一单页工作区 |
| `app/src/PromptOverview.tsx` | 全项目剧情页 Prompt 窄列总览，复用词条编辑器；分类对齐、导航定位、逐页指纹保存和批量排队 |
| `app/src/WorkbenchCandidateWorkspace.tsx` | 候选生成、预览与批量删除工作区 |
| `app/src/runtime-status.ts` | 健康、硬件和任务状态的不重叠串行轮询与任务终态判断 |
| `app/src/RuntimeStatusBar.tsx` | 只消费根组件状态的本机环境与生成任务入口 |
| `app/server/page-key.mjs` | PageKey 校验、规范编解码和安全媒体路径 |
| `app/server/prompt-contract.mjs` | Prompt 类型、页面与角色分类、预算、审计码和公共归一化规则 |
| `app/server/prompt-audit.mjs` | 跨 render profile、角色和页面片段的确定性审计 |
| `app/server/prompt-write-audit.mjs` | 保存后消费捕获事实的只读审计，以及不可用诊断与保存成功的隔离 |
| `app/server/prompt-dictionary-loader.mjs` | 写入、网页审计和渲染共用的严格词库加载与身份 |
| `app/server/render-profile-compiler.mjs` | 从最终 profile、Prompt policy、recipe 与 workflow manifest 解析唯一语义配置和来源身份 |
| `app/server/render-profile-diagnostics.mjs` | 对已解析生成配置的模型、风格与角色 LoRA 做本机可用性诊断 |
| `app/server/comparison-inputs.mjs` | 项目页面一次性导入、空白输入与独立自由文本输入契约 |
| `app/server/comparison-experiment.mjs` | 对比实验轴、双 registry、canonical identity 和 cell selection 契约 |
| `app/server/comparison-experiment-storage.mjs` | 对比实验本机派生存储：manifest/preflight 原子创建、status 成果归档、运行状态与重启终结 |
| `app/server/comparison-experiment-runtime.mjs` | 对比实验按 cell 串行调用 ComfyUI、落盘 PNG 结果和最小运行 API |
| `app/server/comparison-lora-identity.mjs` | 冻结比较用正式/未登记 LoRA 的安全文件身份与 SafeTensors metadata |
| `app/server/safetensors-metadata.mjs` | 只读取 SafeTensors header 的严格/容错 metadata reader |
| `app/server/comparison-execution-plan.mjs` | 从实验独立冻结输入构建一 cell 一 workflow 的本机执行计划 |
| `app/server/comparison-execution-contract.mjs` | 比较执行计划的字段、hash、LoRA 层、workflow 与输出映射校验 |
| `app/server/render-profile-inspection.mjs` | 为工作台投影基础配置、route、recipe、workflow、依赖和结构化诊断关系 |
| `app/server/render-profile-override.mjs` | 读取、校验和原子保存项目稀疏调整，并按最终语义 target 解析应用、冗余与三方冲突 |
| `app/server/workflow-definition.mjs` | 成对读取并校验 ComfyUI API JSON 与 workflow manifest，冻结两者身份 |
| `app/server/render-task-contract.mjs` | 冻结渲染任务契约的主要 Interface：集中校验 version、effective profile、Prompt、route/registry 与 execution unit |
| `app/server/render-task-storage.mjs` | 文件型 TaskStore：原子创建 manifest/state、跨进程锁内窄更新轻量状态并在 active/history 间归档 |
| `app/server/render-task-workspace.mjs` | 跨项目聚合轻量任务摘要、精确跟踪任务状态；不修改队列或任务状态 |
| `app/server/render-media.mjs` | 渲染领域共享的 PageKey 输出路径、项目媒体身份和完整 PNG 校验 |
| `app/server/render-plan-route.mjs` | 冻结并验证逐条目 render route、workflow/recipe registry 与执行时 manifest 能力 |
| `app/server/render-project-runtime.mjs` | 只读冻结任务执行预检、提交 ComfyUI、收集输出并更新任务状态 |
| `app/server/comfy-cli.mjs` | 以 `shell: false`、显式 workspace、分命令超时和 JSON envelope 调用 comfy-cli；仅负责 ComfyUI 安装、启动、停止和显式更新 |
| `app/server/project-workbench.mjs` | 从当前项目文件读取不含媒体扫描的工作台事实，并实现页面 Prompt、角色 Prompt/LoRA、页面嵌字等领域操作 |
| `app/server/page-media.mjs` | 完整 PageKey 媒体投影、独立版本、文件通知失效和小型成果索引，不构建完整工作台 |
| `app/server/comfy-runtime.mjs` | ComfyUI workspace、进程身份、安装、更新和启停生命周期；只串行自身维护操作 |
| `app/server/hardware-status.mjs` | CPU、内存、NVIDIA GPU 与 ComfyUI 进程资源的非阻塞状态投影 |
| `app/server/global-resources.mjs` | 生成配置、模型发现、LoRA 使用关系、工作流、字体、扩展与模板的全局资源投影 |
| `app/server/http-support.mjs` | Node HTTP 请求体、JSON/文件响应、项目目录与媒体路径安全等共享边界工具 |
| `app/server/http-app.mjs` | 解析请求、建立项目操作凭据、顺序组合领域 HTTP Adapter，并集中映射错误与静态前端响应 |
| `app/server/runtime-http.mjs` | 健康、硬件、任务、ComfyUI、全局资源、LoRA 资源和 Prompt 词库 HTTP Adapter |
| `app/server/project-http.mjs` | 项目列表、生命周期、材料、生成设置和项目媒体 HTTP Adapter |
| `app/server/agent-http.mjs` | Agent 文件式 read/save 与无文件 read/save HTTP Adapter |
| `app/server/prompt-edit-context.mjs` | 一致性事实读取内组合可写草稿和只读继承／覆盖／关闭项、有效配置及实际模式 Prompt，不诊断本机模型 |
| `app/server/fact-drafts.mjs` | 统一草稿、目标/依赖指纹与领域提交调度；网页保存也直接复用领域提交 |
| `app/server/workbench-http.mjs` | 页面工作台、导航、候选、嵌字和单页生成 HTTP Adapter |
| `app/server/comparison-http.mjs` | 对比实验创建、读取、启动、结果媒体与 Agent 结果工具 HTTP Adapter |
| `app/server/comparison-review.mjs` | 实验结果选择与汇总、冻结输入差异、带来源索引的拼图导出 |
| `app/server/story-files.mjs` | outline、页面 index、narrative 与 Prompt 当前契约 |
| `app/server/character-files.mjs` | 角色 profile、visual、Prompt 与视觉页当前契约 |
| `app/server/lettering-settings.mjs` | 项目排版预设与角色文字颜色的统一契约 |
| `app/server/page-render-resolver.mjs` | 按当前 index 精确解析完整 PageKey，并为普通生成与实验一次性导入编译唯一页面生成目标 |
| `app/server/two-step-generation.mjs` / `two-step-runtime.mjs` | 页面两步实验的草稿来源、固定配方展开、模型预检和中间结果保存 |
| `app/src/TwoStepPromptPanel.tsx` / `SourcePromptEditor.tsx` | 页面实验面板，以及与自定义模式共用的来源标签、重置和文本编辑控件 |
| `app/server/prompt-inheritance-facts.mjs` | 继承检查、连带影响计划、确认指纹和原子写入；共享规则在 `app/shared/prompt-inheritance.mjs`，重复检查与编译共用覆盖后生效片段投影；生成解析只预检引用，由编译器统一检查生效重复 |
| `app/server/scene-facts.mjs` | 项目场景 read/save、环境分类约束与连带修改 |
| `app/src/InheritedPromptEditor.tsx` / `SceneEditor.tsx` | 继承行权重/开关与项目场景管理 |
| `app/server/current-page-prompt.mjs` | 直接消费当前页面与角色 Prompt 文件，生成可审计 Prompt 与当前来源追踪 |
| `app/server/prompt-dictionary.mjs` | 固定 Danbooru/中文快照解析、类别与频次查询 |
| `app/server/index.mjs` | Node 服务的实例状态、依赖装配、启动恢复、Vite/HTTP 生命周期和进程启动入口；不理解领域路由 |
| `app/server/visual-page-templates.mjs` | 全局视觉页面模板清单读取与契约校验 |
| `app/server/render-task-id.mjs` | 渲染任务 ID 的生成与格式校验 |
| `app/server/generation-queue.mjs` | 候选与对比实验共用的跨进程排序、执行单元租约和控制状态 |
| `app/server/generation-lifecycle.mjs` | 生成任务提交、取消、失败收尾和启动恢复的统一边界 |
| `app/server/render-task-state.mjs` | 渲染进程异常退出时的共享任务终态转换 |
| `app/server/project-operations.mjs` | 项目事实读取、事实写入、事实派生、本机派生变更和 HTTP 凭据转换 |
| `app/server/project-write-coordinator.mjs` | `ProjectOperations` 内部的项目 revision 签名、mutation lock、移动登记和直写探测 |
| `app/server/project-contracts.mjs` | 项目目录、材料和创作约定的共享契约 |
| `app/server/lora-training-module.mjs` | LoRA 顶层 Module 与 Adapter 唯一依赖的 facts、plan、runtime、media Interface |
| `app/server/lora-training-facts.mjs` | LoRA 数据集、素材、Caption、训练任务事实 Implementation |
| `app/server/lora-training-plan.mjs` | 环境、recipe、运行设置、预检和 frozen run manifest 计划 Implementation |
| `app/server/lora-training-runtime.mjs` | 训练进程、恢复、checkpoint 和运行媒体的 manifest-only Implementation |
| `app/server/lora-training-media.mjs` | 图片裁剪、超分、恢复和后处理预览 Implementation |
| `app/server/lora-training-run-index.mjs` | checkpoint 清单与历史运行投影的窄共享 Implementation |
| `app/server/lora-training-recipe.mjs` | recipe 身份与 hash 读取的窄共享 Implementation |
| `app/server/lora-training-run-manifest.mjs` | frozen run manifest 的完整 Interface 校验 |
| `app/server/project-materials.mjs` | 来源材料发现、受限读写与创作约定持久化 |
| `app/server/project-management.mjs` | 项目事实与输入复制白名单和目录重命名 |
| `app/scripts/` | 本机初始化、诊断、项目校验和生成 |
| `app/tests/` | 高价值行为契约测试 |
| `library/schemas/` | 项目与生成配置 JSON 契约 |
| `library/visual-page-templates/` | 可复用视觉页面模板清单；模板只在新建页面时一次性展开 |
| `library/render-profiles/` | 用户维护的可复用生成配置 |
| `.agents/skills/` | 项目级 Agent 工作流的唯一事实来源 |

## 常用搜索

```powershell
rg "PageKey|resolvePageIdentity|project-workbench|story-files|character-files" app
rg "story-files|character-files|prompt-dictionary" app
rg "prompt_type|prompt-audit|resolved_fragments" app
rg "camera_settings|prompt_text|default_render_profile" app library workspace/ellen-jk-v3
rg "creative-agreement|materials|project:copy|project:rename" app docs library
rg "readFacts|mutateFacts|deriveFromFacts|mutateDerived|expected-revision" app/server app/tests docs/dev
rg --files library\schemas library\render-profiles workspace\ellen-jk-v3
```

## 验证

### 临时浮层

提示、右键菜单、下拉菜单与搜索候选统一使用 `app/src/floating-layer.ts` 的浏览器顶层与视口定位机制。
文字提示使用 `data-tooltip`，由 `useTooltips` 统一处理悬停、键盘焦点和 `aria-describedby`；不要用
CSS 伪元素绘制提示。交互菜单使用 `useFloatingLayer`，已有候选定位器使用 `FloatingPanel`；
Portal 宿主使用 `floatingLayerHost()`，以保证原生 modal dialog 内的菜单仍可操作。
不要通过提高 `z-index`、放开正文容器 overflow 或写死菜单高度解决浮层遮挡。
新增浮层应验证父容器裁切、屏幕边缘、长内容滚动、弹窗内交互和 Escape 关闭；回归命令为
`npm --prefix C:/Workspace/story-canvas/app run test:floating-ui`。

```powershell
npm --prefix <仓库根>/app run check
npm --prefix <仓库根>/app run build
npm --prefix <仓库根>/app test
npm --prefix <仓库根>/app run test:prompt-ui
npm --prefix <仓库根>/app run test:navigation-ui
npm --prefix <仓库根>/app run validate:project -- --project workspace/ellen-jk-v3
rg "protectedProjectMutationId|unprotectedProjectMutationPatterns|assertProtectedRequestApplied|responseRevision" app/server
rg "createHttpRequestHandler|handle[A-Za-z]+Request" app/server/index.mjs app/server
```

`test:prompt-ui` 使用真实浏览器验证 Prompt 行内编辑区自适应高度、候选定位和键盘操作，
以及原文选区、剪贴板、输入法与总览跨单元定位、分类对齐、描述标签详情、保存与冲突时的草稿保护。
84 页用例验证视口编辑器数量有界、原生内容布局次数，以及滚动往返和屏幕外草稿保存。
仅在临时 Vite 测试页面中运行，不读写故事项目。Windows 默认使用本机 Edge；
其他环境使用 Playwright Chromium（首次运行前执行 `npm --prefix <仓库根>/app exec -- playwright install chromium`），
也可通过 `BROWSER_CHANNEL` 指定已安装的浏览器。可见视口变化使用受控模拟，手机软键盘仍需实机验收。

项目复制、重命名和日常 Agent 命令均通过在线服务执行。核心事实 read/save 使用目标及必要依赖指纹；
其他 API 按各自契约使用 expected revision，不能直接改项目 JSON。完整入口见
[Agent 直接操作工作台](../reference/agent-interfaces.md)。

开发时使用 `npm --prefix <仓库根>/app run dev`：Windows/macOS 显式监听 `app/server/` 和 `app/shared/`，避免 Vite 临时配置触发后端反复重启；其他平台使用 Node 的导入模块监听。后端代码变化后重启服务，Vite
仍由同一个 Node.js 服务以中间件方式提供前端开发页面。`npm --prefix <仓库根>/app run start` 则读取
已经由 `build` 生成的 `app/dist/`，不监视源码，修改任何代码都需手动重启，适合稳定运行。
两者均检查仓库单实例；需要自动替换旧服务时使用根目录启动脚本，Linux 普通脚本还会先执行构建，详见[环境搭建](../reference/setup.md)。浏览器通过带实例 ID 的健康
接口识别服务中断、恢复和重启。健康、硬件、任务和项目 revision 轮询都必须等待前次请求结束后再调度；新增页面
消费者不得自行轮询 `/api/tasks`，也不得用全量 workbench 刷新代替 PageKey 媒体刷新。
重启恢复会复验排队任务的冻结契约；如果开发修改改变了 Prompt 契约身份，旧任务会以明确错误
归档为失败并从队列移除，需要按当前页面重新提交。加载快照和模型预检失败也走相同终态收尾，
不能让已经退出的执行器留下永久排队项。任务控制在状态锁内重读终态，避免与失败归档竞争。
事实变化只后台更新 workbench 数据；仅变化的编辑区接受最新磁盘内容，不能因其他页面变化重置草稿或滚动。
当前页媒体独立串行检查自己的版本，不依赖任务列表；任务历史按需分页读取，无总量限制。
任务历史与结果缩略图清单复用对比实验的轻量 manifest/status 视图，不读取执行计划或逐格结果文件；
详情和执行仍使用完整校验。候选、对比和成品任务卡片使用缓存缩略图。LoRA 数据集导航摘要只读取
project.json，图片完整性检查保留在详情与训练预检；素材网格使用懒加载缩略图，媒体通过 ETag
重新验证缓存，裁剪和替换图片后按文件身份失效，全屏和裁剪继续读取原图。

修改视觉页面、Prompt、故事章节或角色契约时，同步更新 schema、项目创建器、开发示例、编译器、
服务端写接口和用户文档。测试优先保护：outline、页面 index 与页面文件的交叉诊断，PageKey
解析与路径安全，页面 Prompt 完整保存、服务端 fragment ID 生成、目标 SHA 冲突、角色 Prompt/LoRA 保存、
候选计数、删除和统一嵌字设置写入，页面与角色引用、Prompt 类型与预算审计，
当前页面生成的配置门禁、`avoid` 路由、角色和风格 LoRA 分层、任务快照、
受限文件写入、项目 revision 并发保护、材料路径穿越、复制白名单、活动任务重命名保护、畸形 JSON
只返回校验错误、固定词库身份和本机路径不进入 Git。

所有说明性文档使用中文。当前能力与目标能力必须明确区分。
