# Agent 直接操作工作台

日常事实写入、项目创建与生命周期、生成和候选操作由正在运行的本地 Node.js 服务执行，不需要打开网页。
命令从 `Config/local.json` 的 `port` 连接本机服务，缺省为 3000；连接失败返回 `workbench_unavailable`，
不自动切换为离线写入，不自动重放失败请求。

同一契约有两种传输方式，编辑纪律完全相同（读取上下文、保留指纹、只改正文、冲突后重读判断）：

- **CLI**：`node <仓库根>/app/scripts/<脚本>.mjs …`，草稿通过 `--out <文件>` 与文件输入做 UTF-8 传输；
- **DSH 原生工具**：安装本仓库 [DSH 预设 bundle](../../.dsh/presets/README.md)，选择创作或极简预设后使用统一 `story_canvas`。

工具使用 `operation:help` 一次返回分组总目录，加 `target` 可直接查询操作详情或查看指定分组；
`operation:status` 检查已加载版本。说明与执行由 `app/scripts/workbench-actions/` 各领域模块共同维护。
本页保留 CLI 与底层协议说明，不重复维护 DSH 操作清单。
有 `story_canvas` 时优先使用该工具及其分级 help；脚本通过
`node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs -h` 进入同一套语义操作。
使用 `<操作名> --args <参数JSON> --out <回执JSON>` 执行；参数与工具 args 相同，输入输出分开。
这个语义 CLI 成功和失败均写回执，错误或批量部分失败退出码为1；脚本必须检查退出码和逐项结果。
操作名、字段主题、示例与限制以工具或 CLI 的分级 help 为准，不在本页重复维护。
长任务等待从 `help task.wait` 查询，参数、续等及取消语义由工具详细帮助维护。
动态页可直接使用 `help` 的 `target:video`，一次取得导入、编辑、生成、等待和成品流程及当前参数定义。
`task.wait` 默认按图片/视频及批量大小选择固定经验等待档位，不读取历史或拟合参数，终态立即返回。手动 `wait_ms` 优先，具体规则见工具帮助。
中止等待不取消生成；超时沿用返回的 `wait.args`。状态读取错误立即返回，不重复提交生成。

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
| story:page | narrative | page-id | 对应页面内容 |
| character:fact | profile、visual | character-id | 对应角色事实 |
| character:fact | page-index | 不传 | 角色视觉页顺序与归属 |
| character:fact | page-goal | page-id | 对应角色视觉页内容 |
| fact:edit | scene 的 profile、visual | scene-id | 对应场景事实 |
| fact:edit | page 的 content、render、text-sources | page-id | 统一页面事实 |

`fact:edit`（`node <仓库根>/app/scripts/agent-fact.mjs`）是通用事实 CLI，覆盖服务端支持的全部
domain/kind：`read <domain> <kind> <project-id> [target-id]`、`save <domain> <kind> <JSON文件|->`。
story:page、character:fact 的 read/save 是它的薄转发；领域与 kind 的合法性以服务端为准，
不支持的组合返回 400 `fact_draft_not_supported`。场景当前没有 scene/index 事实，场景列表顺序由
工作台接口维护。

Prompt 使用统一语义操作 `prompt.read`／`prompt.save`，按页面模型、设定基础或单个子设定读写。
read 返回该范围的完整 `document` 和可带回的保存参数；不返回或要求回传整个 `models` 容器。
`changes` 合并对象、替换数组，`null` 删除字段；恢复继承须删除覆盖字段。需要继承词及来源版本时按需查 `prompt.sources`。
修改引用或组合模式引入新来源，必须携带实际读取的来源版本。参数、批量入口及示例由 `help prompt` 维护。
按角色编辑本页词使用现有 `prompt.save` 的 `person_groups` 投影；项目范围问题查询用 `prompt.check`，
详细字段规则分别查询操作帮助和 `person_groups` 主题。检查摘要不是保存凭证。
旧 Agent Prompt 写入口返回升级指引；其他事实仍使用下表 read/save 契约。
页面 `render` 草稿包含 `version/model_id/profile_id/canvas`；更换模型或画幅使用同一 read/save 契约，
不要直接写文件。首次 Anima→Qwen 会复制有效全文，已有输入不会被重新初始化。
完整编辑上下文返回 `model_id`、`render`、`page.model_input`，Anima 还提供生效分类词和逐词调整；
下列文本、override 与图片说明主要描述 Qwen。具体模型契约见[模型适配器](../dev/model-adapters.md)。

修改指定章节或单元的文本时，提交对应逻辑目标；调整整份骨架时提交 outline。服务内部仍维护一个
outline.json，并在锁内只更新局部目标，不要求 Agent 回传其他章节。sequence 的归属变化会使旧草稿失效。
索引保存调整现有页面的顺序与归属；创建、删除页面使用语义命令维护页面文件与索引的配对关系。

当前创作上下文使用 `node <仓库根>/app/scripts/story-page.mjs context read <project-id> <sequence-id>`：只返回 synopsis、
所属 chapter 的标题/摘要和该章全部 sequence 的标题/摘要，不返回其他章节。它是只读查询；
后续仍需按项目创作规则读取当前 sequence 的全部 narrative 和职责所需事实。

## 编辑页面 Prompt 的完整读取入口

普通 Prompt 编辑用 `prompt.read` 完整读取本次涉及的页面模型范围；页面内容用 `page.editor.read`。
以下完整组装入口仅用于按需理解引用、覆盖或诊断最终输入，不作为每次编辑的前置步骤：

```powershell
node <仓库根>/app/scripts/visual-production.mjs context page <project-id> v3/<page-id> --out <仓库根>/Saved/Agent/<任务>/prompt-context.json
# 或：node <仓库根>/app/scripts/agent-fact.mjs prompt-context <project-id> v3/<page-id> --out <同上文件>
```

对应 `POST /api/agent/prompt-context`，body 为 `{ project_id, page_key }`。CLI 接受 v3 PageKey 或项目内唯一页面 ID，不扫描归属来猜页面身份。

返回只读页面标识与 `context`：

- 本入口只用于诊断；编辑范围及保存参数另从 `prompt.read` 获取。
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

## 可选的单页最终 Prompt 优化

Agent 可在本页事实保存后调用工作台语义接口。请求 JSON 只含 `page_key`，例如 `{ "page_key": { "page_id": "page-001" } }`：

```powershell
node <仓库根>/app/scripts/workbench-api.mjs POST /api/projects/<project-id>/workbench/page-rewrite --body <仓库根>/Saved/Agent/<任务>/rewrite-request.json --out <仓库根>/Saved/Agent/<任务>/rewrite-result.json
```

也可用 `GET /api/projects/<project-id>/workbench/page-rewrite?page_key=%7B%22page_id%22%3A%22page-001%22%7D` 读取状态。返回 `original_prompt`、独立的 `rewrite` 和 `status`（`missing`、`current`、`stale`）。优化调用本机 ComfyUI 的 Qwen-Image-2.1 PE-T2I INT8 模型，不向优化器发送图片；模型正文写入 `pages/<page_id>.rewrite.json`，读取与出图时由工作台固定补上图片编号及用途。生成前检查与单页候选生成可在请求中选 `prompt_source: "rewrite"`；默认 `original`，过期结果仍可显式选择用于生成，stale 仅作提示。Agent 不直接写优化文件。

完整上下文仅用于阅读，不再通过旧 `save-context` 或 `facts.save` 保存 Prompt。修改前用 `prompt.read` 获取对应范围和保存参数。

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
| 任务状态与历史 | `GET /api/tasks`、`GET /api/tasks/history`、`GET /api/tasks/:projectId/:taskId`（`view=summary` 仅读状态，默认 detail 含冻结输入） |
| 任务控制 | `POST /api/tasks/:projectId/:taskId/cancel` |
| 项目设置与生成配置 | `/api/projects/:id/project`、`render-profile`、`render-profile-override` |
| 材料与创作约定 | `/api/projects/:id/materials`、`materials/item`、`creative-agreement` |
| 对比实验、结果索引、拼图与冻结输入差异 | [对比实验](../dev/comparison-experiment.md#agent-结果读取拼图和输入差异)；`comparison-experiments/review`、`sheet`、`diff` |
| 数据集、Caption、训练方案、预检与结果 | [LoRA 训练](lora-training.md) |
| 环境与全局资源 | `/api/health`、`/api/resources`、`/api/lora-resources`；维护见[环境搭建](setup.md) |

API 本身沿用领域响应，不为与 CLI 外观一致而增加重复包装；页面身份、校验与保存规则由现有领域模块共同维护。

## DSH 原生工具

DSH 适配层只注册 `story_canvas`，不承载领域知识；各领域操作把参数契约、摘要、详细帮助与执行放在同一声明中。
总入口仅列分类，分类帮助列操作摘要，单项帮助提供参数与规则。分页摘要用于浏览，完整草稿和 Prompt 编辑上下文不截断。
常用语义操作内部处理路径；设置类编辑使用读取时返回的 revision，不能临写前换成最新版本掩盖陈旧读取。
冲突不自动重试。完整能力由同一插件提供，极简限制插件按 Agent 禁用模型生成与训练执行能力，
帮助标记 `availability: disabled`，执行入口也会拒绝。普通编辑不受此限制，不提供任意 HTTP 绕过入口。
训练修改使用 ETag/If-Match；导入、应用与恢复素材可以显式跳过自动模型处理，工作台界面默认行为不变。
具体设置、资源、媒体、对比和训练操作以各自工具 help 为准。

失败保持工具失败状态，将错误码、状态、诊断、帮助入口与恢复建议放入异常文本，避免 DSH 丢失异常附加字段。
媒体、流式下载与 multipart 上传仍走专用路径。具体参数只查工具 help。

### 统一工具的编辑回执

`facts.read` 返回非 Prompt 事实草稿；`page.editor.read` 按页面内容或生成设置返回全文及保存回执。`prompt.read` 返回单模型范围，`prompt.context` 只读。
局部保存只提交变化字段，由服务端在版本校验后合并，成功回包返回更新后的相关文件全文用于核验。
默认不组装上游引用。非 Prompt 的 CLI 文件式 read/save 契约保持不变；具体参数、删除与数组规则只维护在工具 help 中。
