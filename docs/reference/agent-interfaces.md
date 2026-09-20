# Agent 直接操作工作台

日常事实写入、项目创建与生命周期、生成和候选操作由正在运行的本地 Node.js 服务执行，不需要打开网页。
命令从 `Config/local.json` 的 `port` 连接本机服务，缺省为 3000；连接失败返回 `workbench_unavailable`，
不自动切换为离线写入，不自动重放失败请求。

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
| character:fact | profile、visual、prompt、lora | character-id | 对应角色事实；LoRA 独立投影 |
| character:fact | page-index | 不传 | 角色视觉页顺序与归属 |
| character:fact | page-goal、page-prompt | page-id | 对应角色视觉页事实 |

修改指定章节或单元的文本时，提交对应逻辑目标；调整整份骨架时提交 outline。服务内部仍维护一个
outline.json，并在锁内只更新局部目标，不要求 Agent 回传其他章节。sequence 的归属变化会使旧草稿失效。
索引保存调整现有页面的顺序与归属；创建、删除页面使用语义命令维护页面文件与索引的配对关系。

当前创作上下文使用 `story:page -- context read <project-id> <sequence-id>`：只返回 synopsis、
所属 chapter 的标题/摘要和该章全部 sequence 的标题/摘要，不返回其他章节。它是只读查询；
后续仍需按项目创作规则读取当前 sequence 的全部 narrative 和职责所需事实。

## 编辑页面 Prompt 的完整读取入口

编辑剧情、角色或场景视觉页 Prompt 前，先读完整上下文，不能仅凭本页 JSON 或局部 `prompt read` 判断实际输入：

```powershell
npm --silent --prefix D:/Workplace/story-canvas/app run visual:produce -- context page <project-id> v3/<page-id>
```

对应 `POST /api/agent/prompt-context`，body 为 `{ project_id, page_key }`。CLI 接受 v3 PageKey 或项目内唯一页面 ID，不扫描归属来猜页面身份。

返回 `{ page_key, save, draft, context }`：

- `save` 给出原有保存接口的 domain/kind；`draft` 是可直接提交的原有 read/save 草稿。只修改 `draft.document`。
- `context` 只读，不能写回本页。`inherited` 按来源列出原始片段、身份调整后的权重／开关、页面调整后的最终值；关闭项仍保留。组内保留原始调整映射，方便发现失效键。
- `profile` 包含有效基础词、风格 LoRA、项目配置覆盖及冲突，已经应用 render-profile.override.json；不返回模型可用性扫描或完整工作流。
- `final` 为当前模式实际编译的正负向文本、LoRA 与来源；两步模式另列 `draft_stage`。自由模式的 `inherited_usage` 为 `structured_base_only`，继承区解释结构化基础，不代表这些词仍参与自由文本生成。
- `status: complete` 表示读取和审计可完成，不代表没有内容错误或本机可以生成；同时阅读 `audit` 和 `diagnostics`。缺少有效配置／词库等依赖时为 `incomplete`；配置覆盖冲突时 `final` 为 null，不冒充有效配置。事实文件损坏、引用对象缺失等无法读取的情况直接返回明确错误。

读取在同一 `readFacts` 一致性边界内完成，不新增持久化上下文。正常读取不要求模型文件或 ComfyUI 在线；生成前仍用 `preview page` 检查生成条件。同轮未变内容不用重复读，发生目标或依赖冲突后重新读取判断。

```powershell
$promptContext = node app/scripts/visual-production.mjs context page <project-id> v3/<page-id> | ConvertFrom-Json
# 先阅读 $promptContext.context；仅修改下方草稿正文。
$promptDraft = $promptContext.draft
$promptDraft.document.setting = @(@{ description = "quiet room" })
$promptDraft | ConvertTo-Json -Depth 100 | node app/scripts/story-page.mjs prompt save -
# 角色视觉页使用 character-fact.mjs page-prompt save -。
```

原有局部 read/save 继续用于事实操作和排查，但不能代替编辑前的完整上下文。

## read/save 契约

read 返回的整个 JSON 就是 save 的请求体：`{ project_id, target_id, document, expected_sha256, expected_context_sha256 }`。
项目级对象的 target_id 为 null；仅修改 document，保留读取时的身份与两个指纹。
草稿可以留在内存，也可以保存成普通文件跨轮次继续编辑；服务不管理其位置或生命周期。

PowerShell 7 的 UTF-8 管道示例：

```powershell
$factDraft = node app/scripts/story-page.mjs sequence read <project-id> <sequence-id> | ConvertFrom-Json
$factDraft.document.summary = "两人在门口相遇。"
$factDraft | ConvertTo-Json -Depth 100 | node app/scripts/story-page.mjs sequence save -

node app/scripts/story-page.mjs outline read <project-id> > outline-draft.json
node app/scripts/story-page.mjs outline save outline-draft.json
node app/scripts/character-fact.mjs profile read <project-id> <character-id>
node app/scripts/character-fact.mjs profile save <草稿JSON文件>
```

HTTP 均为 POST：

- `/api/agent/facts/:domain/:kind/read`：body 为 `{ project_id, target_id? }`，通过一致性事实读取返回草稿和指纹；
- `/api/agent/facts/:domain/:kind/save`：body 为 read 返回的完整 JSON，要求两个指纹；
- 场景使用 `domain=scene, kind=index`，不传 target_id；工作台对应 `/api/projects/:id/workbench/scenes` 的 GET/PUT。
- 上游 Prompt 或引用切换有下游影响时，save 返回 422 `inheritance_confirmation_required`，details 首项含 `changes` 清单与 `confirmation_sha256`。用户确认后将该 token 加入原请求再次提交；下游变化后须重新确认。
- `/api/agent/story-context`：body 为 `{ project_id, sequence_id }`，返回上述只读创作上下文。

save 返回实际保存的 value、target_file 及领域诊断。目标过期返回 409 `fact_target_conflict`，依赖过期返回
409 `fact_upstream_conflict`；锁内进一步检查仍可能返回对应领域 conflict/busy。缺少或格式错误的指纹返回 400。
冲突后重新读取和判断，不拿新指纹替旧草稿绕过冲突。提交结果不是下一次编辑的草稿，继续修改时重新 read。

网页与 Agent 共用领域提交函数。核心事实使用 `mutateTargetFacts` 串行提交，校验目标及必要依赖，
不要求全项目 expected revision。导航、项目设置、材料、生成配置、训练事实与生命周期的现有 HTTP 接口
继续使用各自的 revision 契约；通用 HTTP 命令不自动刷新版本后重提旧请求。

上游合法修改可以留下下游诊断；生成检查当前页面实际依赖。Prompt 保存不能修改 LoRA，LoRA read/save
使用独立 lora 入口，修改前仍需用户明确同意；这些命令不授权 Agent 开始或继续训练。

## 项目创建

新对象没有旧事实基线，使用 template/create：

```powershell
node app/scripts/create-project.mjs template <project-id> > project-draft.json
node app/scripts/create-project.mjs create project-draft.json
```

template 返回 `{ project_id, document }`，document 包含 metadata、lettering_settings、outline、characters。
修改 document 后提交完整对象；create 支持 JSON 文件或 `-`（stdin），验证后原子发布项目，已存在的 ID 拒绝覆盖。
对应 POST `/api/agent/project-create/template` 接收 `{ project_id }`，`/api/agent/project-create/create` 接收完整模板对象。
模板读取不创建项目或草稿目录。细节见[项目创建](../dev/project-creation.md)。

## 返回与传输

领域命令成功输出 JSON，完整保留 warnings、downstream_diagnostics、audit、identity_impact 等结果。
合法保存后的审计错误不回滚保存。失败以非零退出码结束，stderr 输出 `{ error, message, status?, details? }`，
stdout 不混入错误或进度日志。直接解析输出时使用 node 或 `npm --silent --prefix <仓库根>/app run …`。

通用 HTTP CLI 的 `--body` 接受 JSON 文件或 `-`；成功返回 `{ value, revision }`，领域 read 命令直接返回草稿。

```powershell
'{"project_id":"demo","target_id":"page-001"}' | node app/scripts/workbench-api.mjs POST /api/agent/facts/story/narrative/read --body -
```

## 生成与候选

```powershell
npm --silent --prefix <仓库根>/app run visual:produce -- render page <project-id> v3/<page-id> --count 3 --seed 42
npm --silent --prefix <仓库根>/app run visual:produce -- render page <project-id> v3/<page-id> --count 3 --wait
npm --silent --prefix <仓库根>/app run visual:produce -- candidate delete <project-id> <PageKey> <candidate-id>
```

也可使用现有裸 page-id；命令通过工作台视图解析，出现歧义时应改用完整 PageKey。
count 为 1–3；seed 可选。默认立即返回 queued 任务与 task_id、task_directory、计划的 candidate_paths；
排队时路径不代表图片已经存在。`--wait` 只轮询服务，返回时 candidate_paths 只包含实际可用成果；
失败或取消时以非零退出并在错误 details 中保留任务和已经生成的成果。
停止等待不会撤销服务任务。候选删除仍接受已有的绝对图片路径，也可直接使用 candidate-id。

## 直接使用已有 HTTP 能力

```powershell
npm --silent --prefix <仓库根>/app run workbench:api -- GET /api/projects
npm --silent --prefix <仓库根>/app run workbench:api -- GET /api/projects/<project-id>/workbench
npm --silent --prefix <仓库根>/app run workbench:api -- POST /api/projects/<project-id>/workbench/page-render-inspection --body <临时JSON文件>
npm --silent --prefix <仓库根>/app run workbench:api -- PUT /api/projects/<project-id>/project --body <临时JSON文件> --revision <已读取的revision>
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
