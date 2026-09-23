# 架构

> 状态：当前实现与已经确认的演进边界。

StoryCanvas 把项目创作事实、生成配置、本机执行任务和可重建媒体分成四层：

剧情项目唯一生成路线是 Qwen-Image-2.1；`project.json` 以必填 `format: "story-free-text-v1"` 标识，
旧格式项目不能打开。角色、场景与页面 Prompt 都是自由文本整段：角色／场景的每个子设定一段文字和
有序参考图，页面一段本页描述加整段 override，编译按全局文字、逐角色段、场景段、附图用途、本页
描述确定性拼接，负向恒空。剧情页 Prompt 总览复用工作台事实快照和单页保存、生成接口，浏览器按
全部剧情页排列窄列、每页一个本页文本框，不增加服务或跨页事实。
词库 API 保留供独立查询与训练使用，生成路径不使用词库。

```text
剧情章节与角色设定
        │
        ├── 剧情页面 ───────┐
        └── 角色视觉页面 ───┤
                            ▼
                    PageKey 页面解析器
                            │
                            ▼
统一 Prompt 编译与生成 ──→ 本机候选与生成任务 ──→ 图片结果
            ▲                                      │
            └──────── 用户、Agent 与 render_profile ┘

对比实验是全局独立分支。测试输入由实验持有，可从项目页面一次性导入完整有效输入，或建立自由文本输入。
创建时冻结 Prompt、LoRA、有效生成配置和工作流；Start、执行、补跑和历史查看不读取来源项目。
存储位于根 Saved/comparison-results 与 Saved/comparisons；与候选共用生成队列，实验 project_id 为 null。
详情见对比实验文档。
```

LoRA 训练是独立项目，当前唯一训练路线是 Qwen-Image-2.1：固定 commit 的 DiffSynth-Studio 提供模型、
LoRA 注入与 loss 实现，仓库内薄 runner（`app/python/qwen-image21-lora-runner.py`）自管更新步、
采样、保存与恢复，Node 以缓存、训练两个独立子进程执行。正式项目路径由 `Config/projects.json` 登记；`project.json`、`assets/`、`captioning/` 与唯一 `settings.json` 组成项目事实。项目内 `Saved/` 放执行缓存，`Training/` 放冻结输入和终态归档，权重仍进入外部模型目录。工具 `Saved/` 只保存可清理数据，`workspace/` 仅放临时项目。
顶部名称下拉菜单切换项目、对比实验、LoRA 训练和资源；保留原目录、状态卡片和移动端项目翻页。
全局工具不受项目加载成功与否影响，URL 不带 project，返回原项目恢复离开时页面。
训练 HTTP 使用 `/api/lora-training`，通过 `lora-training-operations.mjs` 串行处理，
按数据集或方案的 ETag / If-Match 拒绝旧事实写入。

LoRA 顶层是一个深 Module，外部只依赖 `app/server/lora-training-module.mjs` 的四个 Interface：

- `facts`：数据集、素材、Caption 和训练设置等全局训练事实；
- `plan`：环境（DiffSynth commit、Python/Torch、runner 文件 hash、逐文件模型身份）、recipe、
  预检和 frozen run manifest 的计划冻结，含续训兼容性校验；
- `runtime`：只消费已验证 manifest 的两阶段（缓存→训练）子进程启动、停止、checkpoint 盘点、
  恢复包清理和运行媒体；服务启动时只负责终结失联的运行记录，不接管训练进程；
- `media` 与 `coordination`：图片后处理、项目媒体和“冻结后启动”的顶层协调。

这不是路由转发层：`lora-training-facts.mjs`、`lora-training-plan.mjs`、
`lora-training-runtime.mjs` 和 `lora-training-media.mjs` 分别持有各自的状态、参数协调和
不变量；`lora-training-run-index.mjs` 和 `lora-training-recipe.mjs` 只提供 checkpoint
清单与 recipe 身份读取这两个窄共享 Implementation，不承担顶层协调；公共文件安全与基础校验只位于
`lora-training-support.mjs`。`lora-training.mjs`
仅保留兼容导出，Adapter 不以它作为实现依赖。

LoRA HTTP Adapter 和 Node 主入口不再直接导入 LoRA Implementation 函数。计划冻结把当前项目事实、
图片与 Caption hash、加权采样清单、recipe、模型逐文件身份、本机执行参数和 checkpoint 相对目录
集中写入 version 5 manifest；
运行时先通过 manifest Interface 校验，再消费这份快照，不重新读取可变 task 或 dataset。Agent 手工登记正式
LoRA 时也以这份快照解释训练来源。续训不复用旧进程：从父 run 归档的最新完整恢复包（LoRA、optimizer、
scheduler、RNG 与采样游标）冻结一个新 run 后按同一路径执行，首版只改累计目标步数与备注。
顶层 `coordination.startRun`／`resumeRun` 明确编排 `plan.freeze`／`freezeResume` 后调用
`runtime.startManifest`；runtime 不再拥有建立 manifest 的启动入口。

## 组件职责

| 组件 | 负责 | 不负责 |
|---|---|---|
| 外部 Agent | 与用户确定当前工作单元，整理分页和页面事实，通过 `prompt-authoring` 编写与审计 Prompt，维护配置和运行环境，并直接读图判断候选 | 在生成按钮中临时组织 Prompt，或把创作过程写成全项目阶段状态机 |
| 浏览器工作台 | 通过原工作台布局读取项目事实；让最高权限的用户编辑单页 narrative/goal、角色 profile/visual、页面与角色 Prompt 和嵌字布局，并生成、预览和删除候选 | 提供万能 JSON 编辑、替 Agent 选图或保存创作阶段状态机 |
| 本地 Node.js 服务 | 受限读写项目事实、确定性编译生成任务、配置诊断、词库搜索和媒体访问 | 内置 LLM、数据库、云同步或 Agent 调度 |
| `render_profile` | Qwen-Image-2.1 模型（`dit`、`text_encoder`、`vae`）、一段全局 `prompt.text`、文生图与参考图候选工作流、风格 LoRA | 保存角色或页面 Prompt、单页事实或项目创作事实 |
| ComfyUI | 执行生成工作流 | 管理故事、用户审核或项目版本 |
| 固定 commit 的 DiffSynth-Studio | 提供 Qwen-Image-2.1 的模型加载、LoRA 注入与 loss 实现 | 管理项目、下载环境或决定结果；训练循环、采样、保存与恢复由仓库内 runner 自管 |

工作台导航由 `workbench-navigation.ts` 集中维护当前位置和切换、回退规则；`App.tsx` 统一接纳
导航并同步 URL，首次加载、后台刷新和导航操作后的快照共用同一回退路径。普通切项目直接进入基本信息，
任务跳转与 URL 深链保留目标页面。导航树只支持单页，编辑区只生成当前页；多页排队留在总览入口。

左侧按「设定、系列、输出」分区；分区切换只浏览目录，打开具体内容时才切换工作区，
并同步定位所属分区。设定包含角色与场景；输出包含成品和项目嵌字样式；对比实验从顶部菜单进入全局工具。左下「项目」弹出菜单直接打开基本信息、生成设置、参考材料和任务历史，并集中当前项目的复制、提升、移除登记和临时项目删除；切换仍保护未保存草稿。顶栏名称下拉按剧情／LoRA 训练项目分组，条目内 Git 图标只读显示状态，未关联远程用「本地」标记、临时项目用浅米色底区分；列表底部添加项目；没有单独的项目管理窗口。
顶部搜索覆盖当前项目内容，纯数字匹配全系列剧情页码；角色视觉页在各子设定内分别编号。
编号由当前顺序派生，不写入事实或替代 PageKey。目录不使用逐级缩进，靠字号、字重、类型与编号区分。

`navigation-history.ts` 保存当前会话、当前项目内实际打开过的位置（含场景、总览目标和页内编辑标签），
不记录分区浏览、折叠或后台刷新，不缓存编辑草稿。后退／前进复用离开提示，取消不移动历史位置；
切项目或刷新清空历史。分支折叠按项目保存，首次收起内部内容，打开目标时只展开必要路径。
新增从标题或条目的右键／长按菜单进入：同级插在当前项之后，下级追加到容器末尾。
新增锚点在既有事实写入操作内校验，不采用先创建再另发移动请求的双重写入。

## 项目操作执行

同一仓库只运行一个负责事实写入的 Node 服务；网页和多个 Agent 都通过该服务操作。
`workbench-instance.mjs` 以进程启动身份登记服务和启动器，服务入口拒绝重复实例。
启动脚本显式替换旧服务及 dev 监听器；Linux 分别提供 dev 和非 dev 两个脚本，非 dev 启动前构建当前前端。
独立生成执行器继续使用候选、队列和任务所需的跨进程锁，不承担项目事实写入。

项目事实的并发边界已经收口到 `app/server/project-operations.mjs`。它按项目 ID 解析并验证项目
目录，在唯一的内部协调器后隐藏 mutation lock、项目移动保护和磁盘 revision 签名，并
一致性读取重试；领域 Module 只负责 JSON 结构、事实校验和原子落盘。

所有进入项目操作执行 Interface 的项目路由在进入领域代码前显式选择一种语义：

- `readFacts`：对必须使用完整当前事实视图的读取执行前后 revision 检查，并最多完整重试一次；
- `mutateTargetFacts`：网页核心事实保存与 Agent 会话共用的窄写入，只校验目标和必要依赖；
- `mutateFacts`：校验浏览器 expected revision，成功通过响应头返回写后 revision；
- `deriveFromFacts`：校验浏览器 expected revision，在当前事实下建立冻结的渲染或 LoRA run，允许 revision 不变；
- `mutateDerived`：串行更新任务、候选、缓存、预览和 run，不改变项目 revision；允许
  渲染在锁内读取提交时的最新事实并冻结持久任务，随后在锁外执行，也允许生成可重建缓存；不得写项目事实；

`http-app.mjs` 是唯一 HTTP 总边界：它从 header 构造项目凭据、集中映射公开错误，并依次调用
agent 事实读写、runtime、comparison、workbench、LoRA training 和 project 领域 Adapter。每个 Adapter 只匹配
本领域路径、选择项目操作 Interface 并组织 HTTP 输入输出；`index.mjs` 只组合服务实例状态、控制器、
启动恢复和 Node/Vite 生命周期，不再导入页面、材料、资源或实验的具体路由实现。成功事实或派生操作的
revision 写入 `x-story-canvas-revision`；响应工具不读取请求级隐式状态。项目复制和重命名只调用
`ProjectOperations.copyProject`／`renameProject` 专用 Interface。页面渲染使用项目执行 Interface；对比实验使用独立全局操作锁，仅导入通过项目 readFacts；LoRA 使用独立的全局训练操作边界；GPU 工作不进入项目事实锁，也不建立跨领域准入策略。

浏览器工作台由 `app/src/App.tsx` 组合当前项目、导航和编辑器状态。载入请求使用
`app/src/project-request-guard.ts` 隔离项目切换后的 stale 响应；事实读写集中在
`app/src/project-workbench-client.ts`，底层写入仍由 `project-write-client` 串行化并携带当前事实版本。

剧情页内容、页面 Prompt、嵌字、角色 profile、角色 visual 和角色 Prompt 都使用显式手动保存。
每个编辑区分别维护草稿、dirty 状态和目标内容指纹；过期保存被拒绝后后台同步最新版，
仅资源确实变化时覆盖对应草稿，不重放旧保存。浏览器刷新或关闭含未保存事实草稿的页面前会使用原生离开警告。工作台没有 debounce
自动保存会话，也不维护第二套页面事实状态机。

`App.tsx` 是本机健康、硬件和任务状态的唯一轮询所有者；每一路都在前一次请求结束后才安排下一次
读取，并在卸载时中止请求。`RuntimeStatusBar.tsx` 只消费状态和提供任务对应页面入口，不再启动第二套
任务轮询。工作台事实与当前页媒体分别读取：项目切换或事实写入后刷新 workbench；当前 PageWorkspace
独立串行检查该 PageKey 的媒体版本，不从任务历史推断候选变化。两类读取都有独立的 stale 响应保护。
材料与生成配置注册项目快照读取器；LoRA 工具页独立加载训练数据与事实版本。`workbench-snapshot-sync.ts` 为初次加载、
常规刷新和导航操作后的加载统一检查请求次序、项目切换及读取期间的写入，准备好同一事实 revision
的数据后一起应用并推进写入版本；不会用根工作台的新版本号提交独立页面的旧缓存。
`App.tsx` 只保留各入口的导航意图和界面反馈，草稿与媒体刷新仍由原视图负责。

浏览器对项目操作请求显式选择 `readFacts`、`mutateTargetFacts`、`mutateFacts`、`deriveFromFacts`、
`mutateDerived`、`copyProject` 或 `renameProject` Interface。事实写入、事实派生和项目生命周期
请求按项目串行、检查客户端 epoch；mutateTargetFacts 不注入项目 expected revision，其他需要项目凭据的写入仍注入；事实写入和事实派生响应提供 revision
时，浏览器保存为下一次预期值。事实读取和本机派生变更不进入事实写队列，也不注入 expected
revision。项目媒体和材料文件等静态资源不属于项目操作 Interface，但浏览器仍通过独立的
`readProjectResource` Interface 读取。Node 路由按 endpoint 直接选择实际 Interface；请求不再重复
声明操作语义。

Agent 使用“了解现状、分页、页面制作、Prompt 编写、主观探索、客观验证和环境
维护”等可组合工作流。它们只描述当前工作单元的方法和交接关系，不是持久业务
状态。一个项目可以先反复校准高影响页面，再分批推进其他页面；决策锚点一次只处理一个，
由事实或偏好的不确定性及下游影响决定，不以生成难度排序。稳定创作路由见
[创作指南](../creative/guide.md)。

## 当前 API

- `GET /api/health`：返回 API 版本、当前服务实例 ID、启动时间、本地配置和当前词库状态，
  供已打开的工作台识别后端断线、恢复和开发模式重启；
- `GET /api/projects`：项目摘要；项目路径来自本机显式登记，页数由 `pages/index.json` 计算；
- `GET /api/resources`：读取已登记资源、本机发现模型、词库、字体、ComfyUI 扩展、工作流、
  生成配置和可复用视觉页面模板；发现模型不在页面打开时计算全文件 SHA；损坏模板只返回模板资源错误，
  不阻止空白页面创建；
- `GET /api/projects/:id/workbench`：从当前项目文件读取章节、sequence、剧情页、角色、角色视觉页和 Prompt 等稳定工作台事实，不扫描任务或媒体；
- `GET /api/projects/:id/revision`：事实 revision 的轻量缓存查询，由项目事实文件变化通知失效，覆盖独立 Agent CLI 写入；
- `POST /api/projects/:id/workbench/page-media`：按完整 PageKey 无锁读取本机媒体投影，不进行项目事实 revision 扫描；返回独立媒体 `revision`。请求头 `x-story-canvas-media-revision` 相同时只返回 `{ unchanged: true, revision }`。服务端按文件通知只重读变化页面的成果记录，候选与数量共用按页索引；每分钟或无法定位页面的通知触发全量校验。`x-story-canvas-media-fresh: 1` 强制重读当前页；
- 项目事实读取接口在响应头 `x-story-canvas-revision` 返回当前项目 revision；事实写入、事实派生
  和生命周期接口必须携带 `x-story-canvas-expected-revision`，成功响应同样返回新的 revision；
- `PUT /api/projects/:id/project`：保存标题、统一画面比例和默认生成配置；`project.json`
  不保存项目 ID；
- `POST /api/projects/:id/copy`：按固定白名单建立无依赖项目副本并自动分配 `_N` 后缀；
- `POST /api/projects/:id/rename`：在没有活动任务时重命名同级项目目录，不改写项目内部事实；
- `GET /api/projects/:id/materials`、`PUT|DELETE /api/projects/:id/materials/item` 和受限材料读取接口：
  自动发现 `materials/` 中的参考材料，并通过单次语义写入同时维护内容与显示标题；
- `PUT /api/projects/:id/creative-agreement`：保存扁平的项目级创作约定清单，每条明确为必须遵守或创作偏好；
- `PUT /api/projects/:id/workbench/page-content`：以完整 PageKey 与目标内容 SHA 完整替换单页 narrative 或 goal；
- `PUT /api/projects/:id/workbench/story-summary`：以明确 target 和目标文本 SHA 窄写入梗概、章节摘要或
  情节单元摘要，仍校验项目 revision，不允许总览写入页面内容或修改故事结构；
- `PUT /api/projects/:id/workbench/page-prompt`：以目标 Prompt SHA 完整替换单个剧情页或角色视觉页 Prompt；
- `PUT /api/projects/:id/workbench/character-prompt`：以目标 Prompt SHA 完整替换单个角色的
  `prompt_name` 与各 variant 子设定的自由文本和参考图；
- `GET /api/projects/:id/workbench/candidate-counts`：共享按页媒体索引，汇总各完整 PageKey 的可用候选数量，不重复检查图片文件；
- `POST /api/projects/:id/workbench/candidate-detail` 与
  `DELETE /api/projects/:id/workbench/candidates/:candidateId`：按完整 PageKey 读取冻结生成详情或删除候选；
- `PUT /api/projects/:id/workbench/lettering-settings`：以目标 SHA 原子保存项目排版预设和全部角色文字颜色；
- 浏览器用单页窄契约编辑 narrative/goal，用独立入口编辑 Prompt，不提供全量 JSON 写入口；
- `PUT /api/projects/:id/workbench/page-lettering`：校验对白稳定 ID 与归一化位置，只替换目标页文字布局；
- 主候选预览默认通过 DOM 叠加文案并支持直接拖动；位置草稿仅在「嵌字」子菜单显式保存，不合成 PNG；
- `POST /api/projects/:id/workbench/page-render-inspection`：以完整 PageKey 编译只读流程预览，可临时带入尚未保存的页面 Prompt 草稿；
  返回正负 Prompt（负向恒空）、按 sections 来源分段、编号参考图、出场角色 variant、有效生成配置、候选 route、recipe、workflow、画布、审计和阻断，
  不生成 Prompt ID、不落盘、不创建任务，也不要求 expected revision；
- `POST /api/projects/:id/workbench/render`：完整 PageKey 单页候选生成入口；渲染读取提交时最新事实，
  不要求 project revision，候选允许 1 到 3 张与可选 seed；
- `PUT /api/projects/:id/render-profile`：切换项目生成配置；
- `GET/PUT /api/projects/:id/render-profile-override`：读取或完整替换项目稀疏生成配置调整；写入前
  验证所有 profile、语义目标、route 与 workflow topology，冲突可以保存但会阻止生成；
- 页面渲染由 `visual:produce render page` 或工作台单页 render 入口读取提交时最新事实并冻结本机任务，不携带项目 revision；
- `GET /api/hardware-status`：独立返回本机 CPU、内存、由 `nvidia-smi` 读取的 NVIDIA GPU/显存状态，以及当前 ComfyUI 地址的缓存状态；本机地址继续读取进程显存和驻留内存，远程地址不在轮询中自动探测；
- `POST /api/comfyui/refresh`：并行检测全部 `comfyui_urls`；服务启动时执行同样的一次检测，之后只由该显式入口更新实例状态；当前实例仍在线时保留选择，否则回到列表中第一个在线实例；
- `POST /api/comfyui/select`：选择一个已经检测为在线的实例，当前进程内后续任务与请求统一使用该地址；不持久化选择，也不自动故障转移；
- `POST /api/comfyui/install`、`POST /api/comfyui/update`：用户或 Agent 显式调用 comfy-cli 安装或更新；安装请求必须指定 `device`（`nvidia`、`amd`、`m-series` 或 `cpu`），根据 workspace 状态选择首次安装或 `--restore`，允许本机配置安装源并按阶段返回错误；安装和更新分别使用 90 分钟与 30 分钟上限。维护操作只由 ComfyUI 控制器自身串行，并要求目标 workspace 的 ComfyUI 未运行；日常启动不会自动执行；
- `POST /api/comfyui/start`、`POST /api/comfyui/stop`：通过 comfy-cli 启停本机 workspace，启动验证 CLI、监听目标与 `/system_stats` 身份；空闲端口遇到 `server_already_running` 时，只在全局记录匹配当前主机／端口且记录 PID 不属于当前 workspace 启动器时原子清除陈旧记录并重试一次；关闭前检查 ComfyUI 自身队列，并分别用全局背景记录和指定端口的 `stop --dry-run`、二次进程父链读取核对 workspace、主机、端口与 PID；
- `GET /api/tasks`：只聚合活动任务与实时进度，不扫描历史 state、工作台事实或候选媒体；浏览器可附带当前页面跟踪的项目/任务 ID，精确状态独立返回；
- `GET /api/tasks/history?before=...`：历史按提交顺序每页 30 条，无总量上限；先枚举历史任务目录名，再只读取本页 state。历史面板打开或加载更多时读取，不加入后台定时轮询；
- `GET /api/tasks/:projectId/:taskId/results?purpose=candidate|comparison`：按需读取单个任务已落盘且仍存在的图片地址，供卡片缩略图和全屏查看；候选只读轻量 state，对比实验读取其存储记录；
- 任务控制响应返回任务身份、状态、`pending_control` 和队列 revision，浏览器立即应用，并拒绝控制完成前发起的旧轮询响应；按钮请求期间用转圈反馈，延后生效的取消由服务端状态明确提示；
- `GET /api/tasks/:projectId/:taskId?purpose=candidate|comparison`：点击任务卡片时读取单个任务详情，包含条目、冻结执行快照与实际提交记录。活动列表和历史列表只返回摘要，不包含逐张条目、图片预览地址或阶段记录。顶部任务入口与「项目 → 任务记录」共用卡片、历史分页和详情弹窗；记录页展示当前工作台全部项目，不按当前项目过滤；
- `GET /api/prompt-dictionary`、`POST /api/prompt-dictionary/matches`：搜索固定 Danbooru/中文
  快照，或批量取得标签类别、频次和翻译证据；词库仅供独立查询与训练，不参与剧情页 Prompt 编译与审计；
- `GET /api/lora-training/environment`：只读诊断固定 DiffSynth 训练器 commit、Python/Torch/CUDA、GPU、
  仓库内 runner 身份与模型清单逐文件状态；网页不能触发安装或升级；
- `GET /api/lora-resources` 与详情、媒体接口：读取当前设备每个正式 LoRA 各自独立的完整本地
  资源记录、身份诊断、预览和示例；
- `GET/POST/PUT /api/lora-training/datasets...`：独立管理数据集、分组、受限素材导入、
  非破坏性裁剪、同名 Caption 与图片集确认；
- `GET/PUT /api/lora-training/tasks...`：读取和更新项目唯一训练设置与预检；
- `POST /api/lora-training/tasks/:taskId/runs` 及停止、删除、续训（`runs/:runId/resume`）接口：
  建立不可变快照并管理本机训练记录；checkpoint 直接写入统一 LoRA 目录，删除记录时保留权重；
- 受限媒体接口：读取项目的候选、缩略图、输出图片，以及任务内图片。

除纯读取和明确的本机派生任务操作外，项目写接口都在 `ProjectOperations` 的项目 mutation lock 内校验
`x-story-canvas-expected-revision`。工作台把本项目写请求串行发送，并从每次成功响应的
`x-story-canvas-revision` 取得下一次预期值；revision 冲突拒绝旧写入，浏览器后台同步最新事实，
不重放旧保存。每三秒轻量检查 revision，变化后后台更新 workbench 数据，不进行整页刷新；
当前资源确实变化时允许覆盖浏览器未保存输入，不做冲突合并。revision 不写入项目 JSON，也不
替代 Git 历史。其磁盘签名可以发现常见的绕过 Node 直写并触发重载，但同一系统用户下没有
文件权限隔离，因此它不是对恶意或精确竞态直写的硬阻断。

Prompt 草稿可以带审计错误保存。所有向 ComfyUI 提交新采样的生成入口在服务端按同一投影
重新编译与审计：错误硬阻断，警告不阻断；浏览器预检和 CLI 不能绕过门禁。

## 数据边界

项目事实使用可读 JSON 和输入文件，不使用数据库。项目目录名是运行时身份，不在
`project.json`、新任务或新图片来源元数据中重复保存；旧任务中的目录字段只作为历史快照
忽略。`materials/` 中实际存在的文件就是参考材料；`materials/index.json` 仅保存可选显示标题，
不表达登记状态或阅读顺序；
`creative-agreement.json` 保存扁平的项目级创作约定，每条只有稳定 ID、正文和必须遵守／创作偏好类型。Agent 的当前任务、待决事项和汇报留在会话中，
不写入项目事实，也不替代 Git 历史。

浏览器与 Agent 均通过在线 Node 服务修改事实；核心编辑共用领域提交函数。Agent 的 read/save 返回并核对目标和依赖指纹，提交完整草稿对象。文件与 stdin 使用同一协议，服务不托管草稿；outline 支持按 synopsis、chapter、sequence 局部读写。
具体命令与 API 见[Agent 直接操作工作台](../reference/agent-interfaces.md)。
Agent 在目标或依赖指纹冲突后重新读取并判断，不自动覆盖；浏览器过期保存不重试，只后台读取磁盘最新版。
项目文件仍按领域保持现有拆分，不为并发控制增加业务 revision 字段。

`story/outline.json` 保存 synopsis、chapter 和 sequence；`pages/index.json` 保存所有页面的稳定 ID、
归属与同组顺序。页面 content 保存标题、画面内容、明确角色引用及文案，Prompt 独立保存。
角色与场景分别在 characters/、scenes/ 保存 index 和 profile、visual、Prompt，两者共用同一设定契约：
`prompt_name` 加各子设定一段自由文本与有序参考图，没有身份层、LoRA 或逐词继承。
页面归属与生成引用分离：新建时默认填入所属设定，之后允许移除；移动归属不修改内容。
三种归属共用页面编辑、生成、候选、嵌字及单页成品；系列导出只包含剧情目录。
`lettering/dialogue-layouts.json` 只保存对白稳定 ID 的归一化位置与尺寸，不复制文本或单条样式。
工作台只把布局叠加到当前预览候选图上，当前不合成输出文件。项目事实没有业务修订或批准字段，Git 承担
持久版本历史。项目事实和材料进入 Git，Outputs/ 与 Saved/ 忽略且不随项目复制。
每个渲染任务位于 `Saved/render/active|history/<task-id>/`；manifest 冻结输入，state 保存轻量状态，
实际提交记录位于 `Saved/render/submissions/<task-id>/<unit-id>.json`；比较任务沿用
`Saved/comparisons/<experiment-id>/submissions/<cell-id>.json`。新执行在提交记录中保存 ComfyUI 地址、
提交请求、等待远端结果、下载、本地保存的阶段起止时间与单调时钟耗时，失败保留已记录阶段和错误。
批量单元共享提交与远端等待，下载、保存按输出条目记录；等待包括远端排队、执行及检测延迟，保存包括锁等待，
不表示纯 GPU 耗时或浏览器显示时刻。详情只读本机任务记录，不扫描候选或访问远端；旧记录不推算缺失阶段。
这些记录随 runtime 保存在本机，显式清理 runtime 后不保留。任务状态
更新及归档在既有跨进程任务锁内完成。成果位于 `Outputs/pages/<page-id>/<candidate-id>/`，包含 image.png、result.json 和 generation.json。
三者在 staging 完成后原子发布，再更新任务状态；中断恢复保留已经发布的成功结果。媒体列表和详情
不再依赖任务 manifest/state。删除整个成果目录，并尽力标记仍存在的历史；历史标记失败不能复活图片。
旧存量通过离线一次性迁移转换，原始 manifest 只作为不可执行的来源证据保存。当前预览不持久保存选用关联；用户点击输出时，独立成品制作记录冻结本次候选和排版，见 [成品输出](finished-pages.md)。
候选请求只接受当前页面输入、Prompt、参考图与 route 契约；冻结任务使用版本化当前字段。
候选与对比实验通过 `generation-lifecycle.mjs` 集中处理提交、取消、失败收尾和启动恢复。
`generation-queue.mjs` 只负责跨进程排序、执行单元租约和取消请求；`generation-scheduler.mjs` 只管理
当前服务的 worker，不巡检重试失败任务。任务列表只读取状态和队列顺序，不补建或清理队列。
未开始的任务直接取消；运行任务等当前生成单元结束后停止后续工作，已经完成的成果保留。
当前不提供暂停；失败的对比实验支持用户显式补跑未完成项，沿用冻结输入和已完成成果，普通候选任务不提供手动恢复。队列和租约属于本机派生状态，不进入 Git。

启动时按活动任务重建队列引用，保留已有排序和其他存活进程的租约；失去执行者的 running 任务
回到 queued，已经请求的取消仍然生效。有效冻结任务自动继续，已确认成果不重算；未确认完成的
生成单元可能重算。ComfyUI 遗留请求先自然结束，再接受后续提交。冻结配置无法执行时明确失败并
移出队列，由用户重新提交；不自动修补旧任务或反复重试执行失败。

训练项目的 `project.json` 保存名称、激活标签、分组和图片项；Caption 位于各素材目录。`settings.json` 保存唯一当前底座与参数，不持久化独立方案名或数据集引用。素材与设置共享项目 ETag，历史 run 只读取自己的冻结输入。

每次训练先冻结：复制启用图片与 Caption 到归档 `inputs/`、计算 SHA、构建按分组 repeats 加权的
采样清单，不可变 manifest v5 与 `inputs/`、`resume/` 归档到 <训练项目>/Training/<task-id>/<run-id>/；
<训练项目>/Saved/Training/<task-id>/<run-id>/ 保留缓存、控制文件、status、事件与日志等工作副本，
再以 spawn()、shell: false 依次启动缓存与训练两个阶段的固定 Python runner。runner 输出结构化
JSONL 事件，Node 据此更新进度。终态先归档 result（含性能档案），再更新 runtime 状态；checkpoint
与恢复包在保存事件到达时即盘点登记，不等进程退出。
每个保存节点同时产出 models_root 下的小型 LoRA 权重和归档内的完整恢复包（LoRA、optimizer、
scheduler、RNG 与采样游标）；同一任务只保留最新一份完整恢复状态，新包发布后才清理被取代的旧包。
服务重启时只按 PID、可执行文件、命令行 run 路径与入口脚本
验证孤儿进程，并把失联的 running run 标记为中断，不按进程名批量终止。

训练 checkpoint 直接写入 `models_root/loras/training/<task-id>/<run-id>/`。run manifest 只用
`checkpoints_relative_path` 单向记录来源关系；删除 run 或项目不会删除权重。未登记 checkpoint
视为通用 LoRA，项目选择器与对比实验都可以直接使用。正式 LoRA 的目录整理与 `resource.json`
登记不在浏览器中自动执行，由 Agent 在用户选定结果后手工完成。

公开 Civitai LoRA 使用同一份 `resource.json` 契约，但登记在仓库的
`library/resources/loras/<resource-id>/`，其来源、推荐参数和包括 NSFW 在内的选定预览图随仓库
提交；权重仍不提交。服务端读取公开目录和 `app/data.local/lora-resources/` 并按资源 ID 合并，
因此训练/私有资源不会污染公共资源，公开资源也不会因为当前设备没有权重而丢失配置。

普通生成与对比实验共用统一队列；单个训练 runtime 和单个对比实验分别阻止重复启动。
训练和 ComfyUI 超分不纳入该队列，用户自行控制与队列生成并发时的显存占用。
服务不因这些领域的 GPU 状态主动拒绝请求，不保证同项目操作绕过既有项目
mutation lock。底层进程资源不足时按各自运行错误收束。训练器只按间隔保存 checkpoint，效果通过工作台对比实验验收。

PageKey 统一为 `{ page_id }`，编码为 `v3/<page-id>`。`app/server/page-key.mjs` 是 API、任务、
缓存键和媒体路径的唯一编解码入口。生成解析按 pages/index.json 读取页面，并根据页面明确引用的角色
与场景子设定冻结最终 Prompt 文本、有序参考图和生成身份；归属只用于组织，不推导出场对象。

生成配置是根仓库资源，项目用 `default_render_profile` 选择一个基础配置，并在独立的
`render-profile.override.json` 中按 profile ID 保存一层稀疏项目调整；override 只保存语义 target、
记录的原值和项目值，不复制完整 profile。每个 profile 以稳定角色映射声明模型，保存一段全局
`prompt.text`，并引用独立的 recipe 和 workflow；operation 与输入来源的固定 route 就是能力边界，
不再保存重复的 `capabilities`。模型 SHA-256 必填、来源可缺失。当前唯一生成结构家族是
`qwen-image-2-1`；全局 `prompt.text` 默认为空，项目 override 的语义 target 也是 `prompt.text`，为空时编译直接
省略。不再保留独立 Prompt policy 文件、prefix/suffix、分类、权重、负向或 AVOID 转换。
`library/resources/catalog.json` 额外维护供浏览和人工登记的资源
元数据，包括模型结构家族和模型预览图；生成配置按模型路径与 SHA 复用图片，不另存副本。
资源目录不是执行身份的替代品。项目与生成配置仍各自保存精确文件名和 SHA，项目不保存全局
目录副本，也不要求两台设备拥有相同模型或 ComfyUI 版本。recipe 只保存各画面比例尺寸与采样参数，不选择 workflow。当前 qwen-image-2-1 profile
声明 candidates 的 `empty_latent` 与 `reference_image` 两条 route，其他入口因 route 不存在而在
界面、API 和执行器统一阻止。

项目生成设置可以从正式 LoRA 资源中选择与当前结构家族匹配的条目。选择不会把
资源说明复制进项目，而是在当前 profile 的 sparse override 中新增、移除完整 `style_lora` 语义
target；单独修改既有 LoRA 权重仍可使用窄 `weight` target。资源记录提供选择用预览或示例图、
来源链接与版本、底座身份、触发词、标签、推荐权重和采样建议；有效配置只保留生成需要的文件名、
SHA-256、权重与触发词，继续经过统一诊断和任务冻结。剧情事实不再包含角色／场景 LoRA；
当前 qwen-image-2-1 profile 未声明任何风格 LoRA。

每份当前工作流由同 ID 的 API JSON 与 manifest 成对组成。manifest 已经是结构家族、operation、
输入来源、modifier 和节点绑定的唯一事实来源；任务同时冻结模板与 manifest 及各自 SHA-256。
生成配置不再保存节点绑定。`render-profile-compiler.mjs` 只读取当前格式，把 profile、recipe 和 workflow
解析成单一语义配置与来源身份；旧聚合字段不兼容。新建任务还会为每个条目冻结唯一的
`render_route`，明确记录本次 operation、输入来源、workflow ID、来源 recipe ID 和由有效参数
canonical SHA-256 组成的 recipe instance ID；任务快照只用 `workflows` 与按实例身份索引的
`recipes` 注册表保存实际引用项，同源 recipe 的不同 route-local 参数不会互相折叠。创建与恢复都用同一验证入口检查条目输入、route、
manifest 能力和冻结身份，不从派生或不完整字段重新猜测
workflow，也不兼容缺少 `render_route` 的旧任务。候选生成详情会展示实际执行链与双哈希。工作台的生成配置资源页已经使用服务端只读 inspection 投影展示
“项目 → 基础配置 → 项目调整状态 → 有效配置”以及当前 operation、输入来源、recipe、workflow、
模型和 LoRA 关系；所有 workflow 关系都经过 manifest 与双哈希校验。

项目 sparse override 已纳入项目 Schema、revision、复制与 expected revision 保护的完整文档写接口。基础变化后，
每项调整按“记录的原值 / 当前基础值 / 项目值”判定应用、冗余或冲突；任何冲突都会在工作台、Prompt
编译、服务端生成入口与 CLI 新任务入口统一阻止生成。无冲突时这些入口消费同一 effective profile，
新任务冻结 effective hash 与 override 文件身份；恢复任务始终只读冻结快照，不读取当前 override。
工作台同时展示 override 三方值、effective hash 以及 operation、输入来源、recipe、workflow、模型和
Prompt 的关联。`visual:produce` 通过 `page-render-resolver.mjs` 直接读取当前 PageKey 对应的页面、
角色和生成配置，由 `page-render.mjs` 原子保存完整 `queued` 任务后只按 task ID 启动执行器。
排队策略冻结在任务快照中，恢复不能由命令行覆盖，且不再读取当前项目、
profile、recipe 或 override。编译器同时冻结逐执行单元的最终 ComfyUI workflow、
输出节点和 batch 索引；参考图在冻结时按内容 SHA 保存有序输入字节与来源。执行器复核模型，在提交前按目标 ComfyUI
实例的 LoRA 节点枚举适配路径分隔符，再按冻结输出映射落盘和提升图片，不再选择 route、解析 recipe
或重建 modifier 拓扑。任务中的模型身份与 workflow 语义保持不变。详细目标契约见
[渲染计划目标契约](render-plan.md)。冻结任务的 version、effective profile 来源身份、Prompt 审计、
route/registry 与 execution unit 由 `render-task-contract.mjs` 的主要 Interface 一次性校验，
编译器不再依赖执行 runtime。对比实验保留独立的 manifest、cell 和执行存储，但页面预检与普通
页面生成已共同使用 `compilePageRenderTarget(PageKey)`；它直接消费当前项目文件，不建立中间项目
格式或 adapter。

执行器 `render-project-runtime.mjs` 只接受已持久化 task ID。PageKey 输出路径、项目媒体文件身份和 PNG 完整性
由 `render-media.mjs` 统一提供，避免计划和执行侧各自复制路径与媒体校验。

页面与角色／场景 Prompt 保持模型无关，都是自由文本整段。角色／场景设定保存 `prompt_name` 和
各子设定一段自包含文字与有序参考图；页面保存本页 `text`、场景引用、按 `character:<id>:<variant>` /
`scene:<id>:<variant>` 键的整段 `text_overrides` 与图片选择 `reference_overrides`，以及可带用途的
本页附图。key 存在即使用该字符串（含空串），恢复继承就是删除 key；override 不随上游更新，切换
子设定或移除引用时删除对应 key。编译按全局 `prompt.text`、逐角色段（名称、图片说明、文字）、
场景段、附图用途、本页描述拼接；最终图片序列按人物、场景、本页附图排序后统一编号 `<imageN>`
（单图用“参考图：……”），上限十张，负向恒空。所有输出保留 sections 来源追踪。完整契约
见 [Prompt 编写与审计](../reference/prompt.md)。

风格 LoRA 属于生成配置事实，剧情事实不再包含角色／场景 LoRA。页面渲染统一按
content 的 `characters` 与 Prompt 的场景子设定引用解析出场对象。生成任务冻结配置、最终文本、
解析后的 recipe、工作流模板、有序参考图及每页 seed，恢复时优先使用快照，不受后来配置修改影响。

## 本机配置

`app/comfyui-endpoints.json` 保存进入 Git 的跨设备 ComfyUI 地址与优先级。`Config/local.json` 保存当前设备自己的直连 `comfyui_urls`、`comfy_cli`、`comfyui_root`、可选 `comfy_install_source`、`models_root`、独立 LoRA 训练器与
Python 路径。共享地址命中当前主机名时以本机直连地址替代，避免重复检测自己的 Tailscale 入口。
本机路径不进入 Git，也不通过 `Saved/comfyui` 或 `Saved/models` 目录链接间接同步。
`Saved/` 只保留应用自己的日志和状态。

## 资源与项目视图

全局资源目录采用“仓库登记 + 独立本地 LoRA 记录 + 本机发现”三层：登记项提供稳定 ID、模型
结构家族、精确身份和来源；正式 LoRA 从各自的本地记录提供完整信息；发现项只说明
`models_root` 中存在某个文件，家族保持“其他 / 未登记”，不自动猜测。生成侧当前只登记
Qwen-Image-2.1 模型；LoRA 训练与资源记录仍按各自的训练契约保存家族信息。

固定 Danbooru 标签与中文翻译快照位于 `library/prompt-dictionaries/`，清单记录上游、取得日期
和 SHA-256。应用启动时读取仓库快照，不自动联网更新，也不把词库复制进故事项目。

工作台把模型资源目录拆为“资源 → 基模”和“资源 → LoRA”：基模页区分主模型与配套组件，
LoRA 页区分正式资源与包含训练 checkpoint 在内的未登记本机文件。两类资源的卡片、预览、详情
和单选器由全局目录与项目生成设置复用；项目当前状态、LoRA 权重、加入、替换与移除仍只由项目
生成设置负责。词库、字体、ComfyUI 扩展和生成配置仍由资源 API 读取，供生成、文字布局、Prompt
编辑和运行维护等工作流使用。

## 明确非目标

- 在应用内运行 LLM；
- 用创作阶段状态机、自动执行的审批流或批次历史表达创作过程；
- 在项目之间建立依赖、自动合并实验副本，或自动把实验经验提升为全局规范；
- 同步模型、候选、输出或机器绝对路径；
- 静默替换缺失模型或忽略无法处理的输入；
- 让用户直接维护 ComfyUI 工作流图。
- 从网页安装训练器或模型，自动开始训练，自动选择或导出唯一 LoRA 结果。
