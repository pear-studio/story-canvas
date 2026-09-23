# Agent 直接操作工作台

日常事实写入、项目创建与生命周期、生成和候选操作由正在运行的本地 Node.js 服务执行，不需要打开网页。
命令从 `Config/local.json` 的 `port` 连接本机服务，缺省为 3000；连接失败返回 `workbench_unavailable`，
不自动切换为离线写入，不自动重放失败请求。

同一契约有两种传输方式，编辑纪律完全相同（读取上下文、保留指纹、只改正文、冲突后重读判断）：

- **CLI**：`node <仓库根>/app/scripts/<脚本>.mjs …`，草稿通过 `--out <文件>` 与文件输入做 UTF-8 传输；
- **DSH 原生工具**：会话选择本仓库 `.dsh/presets/story-canvas/` preset 后可用 `story_canvas_facts` 与
  `story_canvas_api`，直接收发结构化对象，不要求先落盘。

## 查询关联项目的 Git

`GET /api/project-library/:id/git` 为剧情与训练项目共用的只读查询；ID 来自 `GET /api/project-library`。

```powershell
node <仓库根>/app/scripts/workbench-api.mjs GET /api/project-library/<project-id>/git
```

返回分支、改动文件、已配置远程和本地 upstream 领先／落后计数，具体字段见[本地项目管理](local-projects.md#项目-git-状态)。不连接远程、不修改 Git。提交或同步须有用户授权，使用返回的登记路径执行 Git CLI；不要把未初始化的临时项目当成工具仓库的一部分提交。

## 操作分类

| 操作 | 唯一业务入口 | 规则 |
|---|---|---|
| 编辑已有事实 | read/save | read 返回正文和指纹；只修改 document，save 带回读取时的指纹 |
| 创建、复制、删除、重命名、移动、生成与任务控制 | 对应语义命令 | 由服务维护相关文件和任务状态 |
| 浏览列表、媒体、状态、资源与诊断 | 只读查询 | 不创建草稿或编辑会话 |

不按修改大小分类。JSON 文件和 stdin 是同一请求体的两种传输方式，保存规则完全相同。
服务不创建草稿文件或 sidecar；旧 edit/write 命令与 HTTP 路由已删除，没有回退入口。
稳定项目 JSON 可以直接读取，不能直接写入；准备修改时使用 read 取得对应目标的正文和指纹。
环境安装、服务启动、存储整理和一次性离线迁移仍使用本机维护工具，不属于日常事实编辑。

## 事实对象与粒度

| 命令 | kind | target-id | document |
|---|---|---|---|
| story:page | outline | 不传 | 完整故事骨架 |
| story:page | synopsis | 不传 | 仅 synopsis |
| story:page | chapter | chapter-id | 仅 title、summary，不包含下属 sequence |
| story:page | sequence | sequence-id | 仅 title、summary |
| story:page | index | 不传 | 剧情页顺序与归属 |
| story:page | narrative、prompt | page-id | 对应页面事实 |
| character:fact | profile、visual、prompt | character-id | 对应角色事实 |
| character:fact | page-index | 不传 | 角色视觉页顺序与归属 |
| character:fact | page-goal、page-prompt | page-id | 对应角色视觉页事实 |
| fact:edit | scene 的 profile、visual、prompt | scene-id | 对应场景事实 |
| fact:edit | page 的 content、prompt、text-sources | page-id | 统一页面事实 |

`fact:edit`（`node <仓库根>/app/scripts/agent-fact.mjs`）是通用事实 CLI，覆盖服务端支持的全部
domain/kind：`read <domain> <kind> <project-id> [target-id]`、`save <domain> <kind> <JSON文件|->`。
story:page、character:fact 的 read/save 是它的薄转发；领域与 kind 的合法性以服务端为准，
不支持的组合返回 400 `fact_draft_not_supported`。场景当前没有 scene/index 事实，场景列表顺序由
工作台接口维护。

修改指定章节或单元的文本时，提交对应逻辑目标；调整整份骨架时提交 outline。服务内部仍维护一个
outline.json，并在锁内只更新局部目标，不要求 Agent 回传其他章节。sequence 的归属变化会使旧草稿失效。
索引保存调整现有页面的顺序与归属；创建、删除页面使用语义命令维护页面文件与索引的配对关系。

当前创作上下文使用 `node <仓库根>/app/scripts/story-page.mjs context read <project-id> <sequence-id>`：只返回 synopsis、
所属 chapter 的标题/摘要和该章全部 sequence 的标题/摘要，不返回其他章节。它是只读查询；
后续仍需按项目创作规则读取当前 sequence 的全部 narrative 和职责所需事实。

## 编辑页面 Prompt 的完整读取入口

编辑剧情、角色或场景视觉页 Prompt 前，先读完整上下文，不能仅凭本页 JSON 或局部 `prompt read` 判断实际输入：

```powershell
node <仓库根>/app/scripts/visual-production.mjs context page <project-id> v3/<page-id> --out <仓库根>/Saved/Agent/<任务>/prompt-context.json
# 或：node <仓库根>/app/scripts/agent-fact.mjs prompt-context <project-id> v3/<page-id> --out <同上文件>
```

对应 `POST /api/agent/prompt-context`，body 为 `{ project_id, page_key }`。CLI 接受 v3 PageKey 或项目内唯一页面 ID，不扫描归属来猜页面身份。

返回 `{ page_key, save, draft, context }`：

- `save` 给出原有保存接口的 domain/kind；`draft` 是可直接提交的原有 read/save 草稿。只修改 `draft.document`。
- `context` 只读，不能写回本页：
  - `global_text: { text, source: "profile" | "project_override" }`：有效全局文字及其来源，已经应用 render-profile.override.json；
  - `references`：按页面引用顺序列出角色与场景，每项含 `source`、`kind`、`id`、`variant_id`、
    `prompt_name`、`current_text`（上游当前文本）、`override`（本页整段覆盖，`null` 表示跟随上游）、
    `effective_text`、`reference_images` 和 `selected_image_ids`；
  - `page: { text, reference_images }`：本页文本与可带 `purpose` 的本页附图；
  - `final`：当前实际编译的 `{ positive, negative, images, sections }`；负向恒为空字符串，
    images 是编号后的最终参考图序列。配置冲突或无法编译时 `final` 为 null，不冒充有效结果。
- `status: complete` 表示读取和审计可完成，不代表没有内容错误或本机可以生成；同时阅读 `audit` 和 `diagnostics`。缺少有效配置等依赖时为 `incomplete`。事实文件损坏、引用对象缺失等无法读取的情况直接返回明确错误。

读取在同一 `readFacts` 一致性边界内完成，不新增持久化上下文。正常读取不要求模型文件或 ComfyUI 在线；生成前仍用 `preview page` 检查生成条件。同轮未变内容不用重复读，发生目标或依赖冲突后重新读取判断。

落盘后编辑并用 `save-context` 提交同一文件：它只从文件取 `save.domain`/`save.kind` 和 `draft` 调用
read/save 契约（当前为 page/prompt），只读 `context`、`page_key` 不进入请求体，且校验
`page_key.page_id` 与 `draft.target_id` 一致：

```powershell
# 阅读文件中的 context；仅修改 draft.document 正文，保留 save、身份与指纹。
node <仓库根>/app/scripts/agent-fact.mjs save-context <仓库根>/Saved/Agent/<任务>/prompt-context.json --out <仓库根>/Saved/Agent/<任务>/save-result.json
```

save 回执默认打印到 stdout；需要落盘时用与输入不同的文件（如上例的 save-result.json），不要用回执
覆盖草稿或完整上下文。DSH 原生工具不用落盘：`story_canvas_facts` 的 `prompt-context` 读取完整包后，
仅将返回的 `save.domain`/`save.kind` 与修改后的完整 `draft` 交给 `save`，不回传只读 `context`。

原有局部 read/save 继续用于事实操作和排查，但不能代替编辑前的完整上下文。

## read/save 契约

read 返回的整个 JSON 就是 save 的请求体：`{ project_id, target_id, document, expected_sha256, expected_context_sha256 }`。
项目级对象的 target_id 为 null；仅修改 document，保留读取时的身份与两个指纹。
草稿可以留在内存，也可以保存成普通文件跨轮次继续编辑；服务不管理其位置或生命周期。
草稿文件统一放在 `Saved/Agent/<任务名>/`，用 `--out` 落盘、文件路径提交：

```powershell
node <仓库根>/app/scripts/story-page.mjs sequence read <project-id> <sequence-id> --out <仓库根>/Saved/Agent/<任务>/draft.json
# 修改 draft.json 中的 document，保留身份与指纹
node <仓库根>/app/scripts/story-page.mjs sequence save <仓库根>/Saved/Agent/<任务>/draft.json --out <仓库根>/Saved/Agent/<任务>/save-result.json

node <仓库根>/app/scripts/agent-fact.mjs read scene profile <project-id> <scene-id> --out <仓库根>/Saved/Agent/<任务>/scene.json
node <仓库根>/app/scripts/agent-fact.mjs save scene profile <仓库根>/Saved/Agent/<任务>/scene.json
node <仓库根>/app/scripts/character-fact.mjs profile read <project-id> <character-id>
node <仓库根>/app/scripts/character-fact.mjs profile save <草稿JSON文件>
```

HTTP 均为 POST：

- `/api/agent/facts/:domain/:kind/read`：body 为 `{ project_id, target_id? }`，通过一致性事实读取返回草稿和指纹；
- `/api/agent/facts/:domain/:kind/save`：body 为 read 返回的完整 JSON，要求两个指纹；
- 场景事实使用 `domain=scene` 与 `profile`、`visual`、`prompt` 三种 kind，target_id 为场景 ID；
  当前没有 scene/index 事实，场景列表与顺序由 `/api/projects/:id/workbench/scenes` 的 GET/PUT 维护。
- 页面 `text_overrides`／`reference_overrides` 的 key 必须匹配当前引用：切换子设定或移除引用时删除
  对应 key，残留 key 保存被拒绝。override 不随上游更新，恢复继承就是删除 key。
- `/api/agent/story-context`：body 为 `{ project_id, sequence_id }`，返回上述只读创作上下文。

save 返回实际保存的 value、target_file 及领域诊断。目标过期返回 409 `fact_target_conflict`，依赖过期返回
409 `fact_upstream_conflict`；锁内进一步检查仍可能返回对应领域 conflict/busy。缺少或格式错误的指纹返回 400。
冲突后重新读取和判断，不拿新指纹替旧草稿绕过冲突。提交结果不是下一次编辑的草稿，继续修改时重新 read。

网页与 Agent 共用领域提交函数。核心事实使用 `mutateTargetFacts` 串行提交，校验目标及必要依赖，
不要求全项目 expected revision。导航、项目设置、材料、生成配置、训练事实与生命周期的现有 HTTP 接口
继续使用各自的 revision 契约；通用 HTTP 命令不自动刷新版本后重提旧请求。

上游合法修改可以留下下游诊断；生成检查当前页面实际依赖。这些命令不授权 Agent 开始或继续训练。

## 项目创建

新对象没有旧事实基线，使用 template/create：

```powershell
node <仓库根>/app/scripts/create-project.mjs template <project-id> --out <仓库根>/Saved/Agent/<任务>/project-draft.json
node <仓库根>/app/scripts/create-project.mjs create <仓库根>/Saved/Agent/<任务>/project-draft.json
```

template 返回 `{ project_id, document }`，document 包含 metadata、lettering_settings、outline、characters。
修改 document 后提交完整对象；create 支持 JSON 文件或 `-`（stdin），验证后原子发布项目，已存在的 ID 拒绝覆盖。
对应 POST `/api/agent/project-create/template` 接收 `{ project_id }`，`/api/agent/project-create/create` 接收完整模板对象。
模板读取不创建项目或草稿目录。细节见[项目创建](../dev/project-creation.md)。

新建项目的模板骨架不含任何 sequence；建页前先创建情节单元（chapter-id 从 outline 读取）：

```powershell
node <仓库根>/app/scripts/story-page.mjs sequence create <project-id> <chapter-id> <标题>
node <仓库根>/app/scripts/story-page.mjs page create <project-id> <sequence-id>
```

## 返回与传输

领域命令成功输出 JSON，完整保留 warnings、downstream_diagnostics、audit 等结果。
合法保存后的审计错误不回滚保存。失败以非零退出码结束，stderr 输出 `{ error, message, status?, details? }`，
stdout 不混入错误或进度日志。直接解析输出时使用 node 或 `npm --silent --prefix <仓库根>/app run …`。

所有日常操作脚本支持 `--out <文件>`：把原本应输出的成功 JSON 以 UTF-8 原样写入指定的一个文件
（父目录自动建立，已有文件覆盖），stdout 改为 `{ output_file, bytes }` 确认信息。`--out` 在业务参数
解析前统一提取，缺值或重复明确拒绝；请求失败时不写文件、不覆盖已有成功文件。业务已成功而落盘失败时
以 `output_write_failed` 报错并在 details 中保留成功结果，不要因此重放业务操作。调用脚本与临时文件
都使用绝对路径，避免从其他项目 cwd 调用时写错位置；无依赖的只读查询可以并行，依赖性写入保持顺序。

通用 HTTP CLI 的 `--body` 接受 JSON 文件或 `-`；成功返回 `{ value, revision }`，领域 read 命令直接返回草稿。

```powershell
node <仓库根>/app/scripts/workbench-api.mjs POST /api/agent/facts/story/narrative/read --body <仓库根>/Saved/Agent/<任务>/read-body.json --out <仓库根>/Saved/Agent/<任务>/narrative.json
```

## 生成与候选

```powershell
node <仓库根>/app/scripts/visual-production.mjs render page <project-id> v3/<page-id> --count 3 --seed 42
node <仓库根>/app/scripts/visual-production.mjs render page <project-id> v3/<page-id> --count 3 --wait
node <仓库根>/app/scripts/visual-production.mjs candidate delete <project-id> <PageKey> <candidate-id>
```

也可使用现有裸 page-id；命令通过工作台视图解析，出现歧义时应改用完整 PageKey。
count 为 1–3；seed 可选。默认立即返回 queued 任务与 task_id、task_directory、计划的 candidate_paths；
排队时路径不代表图片已经存在。`--wait` 只轮询服务，返回时 candidate_paths 只包含实际可用成果；
失败或取消时以非零退出并在错误 details 中保留任务和已经生成的成果。
停止等待不会撤销服务任务。候选删除仍接受已有的绝对图片路径，也可直接使用 candidate-id。

## 直接使用已有 HTTP 能力

```powershell
node <仓库根>/app/scripts/workbench-api.mjs GET /api/projects
node <仓库根>/app/scripts/workbench-api.mjs GET /api/projects/<project-id>/workbench
node <仓库根>/app/scripts/workbench-api.mjs POST /api/projects/<project-id>/workbench/page-render-inspection --body <临时JSON文件>
node <仓库根>/app/scripts/workbench-api.mjs PUT /api/projects/<project-id>/project --body <临时JSON文件> --revision <已读取的revision>
```

通用命令成功返回 `{ value, revision }`，其中 value 是原 HTTP 响应正文，revision 来自响应头，
没有事实版本时为 null。它不修改请求体，不自动重试冲突；上传图片等 multipart 请求继续使用普通 HTTP 工具。

| 能力 | 既有路径或文档 |
|---|---|
| 页面列表、内容、Prompt、角色、模板导航、嵌字 | [工作台 API](../dev/project-workbench.md#api) |
| 候选列表与绝对图片路径 | `POST /api/projects/:id/workbench/page-media`，body 为 `{ page_key }`；候选含 absolute_file |
| 候选详情、数量、批量删除与按需补图 | 同工作台 API；批量清理仍需遵守当前任务授权范围 |
| 最终 Prompt 与生成流程预览 | `POST /api/projects/:id/workbench/page-render-inspection`，body 为 `{ page_key, prompt? }` |
| 任务状态与历史 | `GET /api/tasks`、`GET /api/tasks/history`、`GET /api/tasks/:projectId/:taskId` |
| 任务控制 | `POST /api/tasks/:projectId/:taskId/cancel` |
| 项目设置与生成配置 | `/api/projects/:id/project`、`render-profile`、`render-profile-override` |
| 材料与创作约定 | `/api/projects/:id/materials`、`materials/item`、`creative-agreement` |
| 对比实验、结果索引、拼图与冻结输入差异 | [对比实验](../dev/comparison-experiment.md#agent-结果读取拼图和输入差异)；`comparison-experiments/review`、`sheet`、`diff` |
| 数据集、Caption、训练方案、预检与结果 | [LoRA 训练](lora-training.md) |
| 环境与全局资源 | `/api/health`、`/api/resources`、`/api/lora-resources`；维护见[环境搭建](setup.md) |

API 本身沿用领域响应，不为与 CLI 外观一致而增加重复包装；页面身份、校验与保存规则由现有领域模块共同维护。

## DSH 原生工具

DeepSeek Harness 会话选择本仓库 `.dsh/presets/story-canvas/` preset 后获得两个工具，与 CLI 共用
同一份连接与事实编辑实现，编辑纪律不变（先读上下文、保留指纹、只改正文、冲突后重读判断）：

- `story_canvas_facts`：`operation=read`（domain、kind、project_id、可选 target_id）返回裸草稿；
  `operation=save`（domain、kind、完整 draft）提交草稿；`operation=prompt-context`（project_id、page_key）
  返回完整 `{ page_key, save, draft, context }`，之后只把 `save.domain`/`save.kind` 与修改后的完整
  `draft` 交给 save，不回传只读 context。
- `story_canvas_api`：`method`、`path`（`/api/` 开头）、可选 `body`、可选 `revision`，调用任意 JSON
  接口，始终返回 `{ value, revision }`；`revision` 写入 `x-story-canvas-expected-revision` 请求头，
  遗漏版本 428、过期版本 409，工具不自动刷新重提。

失败保持工具失败状态；DSH 只呈现异常 message，因此插件将 `{ error, message, status?, details? }`
序列化到异常文本中（平台显示为 `Error: {…}`），不会仅依赖异常的自定义属性。连接失败为 `workbench_unavailable`。
媒体、流式下载与 multipart 上传仍走现有专用路径，不经过这两个工具。
