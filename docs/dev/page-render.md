# 页面渲染与候选删除

日常命令需要本地工作台服务在线，无需打开网页。统一入口、返回结果和并发语义见[Agent 直接操作工作台](../reference/agent-interfaces.md)。


所有视觉页渲染只从 `content.characters` 解析角色视觉配置与 Prompt。`dialogue[].speaker` 会在
启动前针对项目角色索引校验，但仅有画外对白的角色不会进入编译结果。

单页命令直接读取当前项目事实，启动渲染时不要求项目 revision，不接受临时 Prompt 或 negative Prompt；seed 可用 `--seed` 固定，与网页一致。

每次提交冻结独立任务快照。同页已有排队或运行任务时仍可编辑、再次提交与删除已发布候选；GPU 执行仍由统一队列调度。
网页只在保存／提交请求期间防止重复点击，不等待生成终态。候选删除与发布共用短时锁，删除状态持久化后执行器不得重新发布该候选。
批量删除逐张尝试，部分失败时分别返回 `deleted_candidate_ids` 与 `failed_candidates`；文件占用已在工具内短时重试，不要求 Agent 空等或重放生成。

## 命令

生成一至三张候选，缺省为一张：

```powershell
npm --prefix <仓库根>/app run visual:produce -- render page <project-id> <page-id> [--count 1..3] [--seed N] [--wait]
```

命令经服务从最新持久化事实解析页面，冻结任务并交给同一调度器。默认立即返回 queued；需要直接读图时加 `--wait`。结果中的 `task_directory` 和 `candidate_paths` 都是完整绝对路径；任务目录中的 `manifest.json` 冻结执行输入，`state.json` 保存生命周期与候选摘要。Agent 应直接使用返回路径读图，不得通过短 ID 猜文件名。指定 `--seed` 时多张候选从该种子连续分配（n, n+1, …），不指定则随机；seed 只存在于任务和候选元数据中，不写回页面事实。

只编译不渲染，输出当前页面编译结果的 JSON（positive/negative、sections 来源、编号参考图、route、recipe、审计与 blockers），不创建任务：

```powershell
npm --prefix <仓库根>/app run visual:produce -- preview page <project-id> <page-id>
```

输出中的 `inspection.generation_signature` 与候选 `result.json` 的 `generation_signature` 使用同一签名，可直接比对候选是否对应当前生成条件。

删除一张不需要的候选：

```powershell
npm --prefix <仓库根>/app run visual:produce -- candidate delete <project-id> <page-id> <absolute-candidate-path>
```

删除命令接受完整绝对路径或 candidate-id，调用网页相同入口，把仍存在的任务条目标为 `discarded` 后移走候选目录。所有已发布候选均可删除，不受所属任务是否结束限制。该便捷命令只删除单张候选；已有批量 API 可经通用命令调用，操作范围仍按用户授权。

## Resolver 与 Prompt 语义

Resolver 通过 `pages/index.json` 与项目内唯一 page_id 定位页面。PageKey 为 `{ page_id }`，编码为 `v3/<page-id>`。
归属不决定生成输入；归属失效的页面仍可编辑、修复和生成，实际参与生成的角色／场景子设定引用失效时阻止生成。

三种归属统一读取 content、页面 Prompt、明确引用的角色和场景子设定，页面之间不继承。
最终文本按全局文字、逐角色段、场景段、附图用途和本页描述确定性组合，负向恒空。
移除引用需同时删除对应 override key，残留 key 保存被拒绝；画外对白不会自动引入人物。
移动页面归属不改写引用、Prompt、候选或成品。已有任务始终消费冻结快照。

生成提交与事实保存共用[项目操作协调器](project-operations.md)的项目操作锁。提交操作实际执行时
读取最新事实，编译一次并冻结任务；排队期间已保存的变化会进入本次快照，冻结后的事实变化不会改写
该任务。项目操作锁只覆盖提交阶段，不跨越 ComfyUI 执行期。

单张与批量候选删除共享跨进程 candidate mutation 文件锁。锁顺序固定为 candidate mutation → page → candidate media；临时 busy 可有界退避重提；内容冲突必须重新读取判断。删除只根据当前项目目录、PageKey、candidate ID 和任务中的规范相对 `file` 重建候选身份；`absolute_file` 只是方便 Agent 读图的展示值，项目移动后其中的旧路径不会参与删除判定。

当前工作台与 Agent 命令使用同一页面事实契约、服务生成入口与任务调度器。

## 工作台流程预览

`POST /api/projects/:id/workbench/page-render-inspection` 使用完整 PageKey 读取当前页面和角色事实，复用当前
Prompt compiler、有效生成配置和 route 解析，返回 Positive、Negative（恒空）、按 sections 来源分段、
编号参考图、出场角色及 variant、画布、候选 route、recipe、workflow、Prompt 审计和结构化阻断。它是只读预览，
不建立渲染任务，也不要求项目 expected revision。

请求可以额外携带工作台内尚未保存的 `prompt`。该草稿只在内存中校验和临时正规化，不会写回项目。
Prompt 不完整、override 冲突、模型缺失时仍返回
HTTP 200 的 inspection，并在 `blockers` 中说明原因，因而页面可以继续展示已经能够编译的流程信息；PageKey
错误、页面不存在或既有项目事实损坏仍按普通项目读取错误返回。

页面编译与写后审计共享 `capturePagePromptSnapshot`、`compilePagePromptSnapshot`。Agent 侧通过
`visual:produce preview page` 复用同一投影，输出相同的编译结果 JSON。审计结果显式包含
`status: complete | unavailable`，有效配置冲突时不以基础配置回退结果冒充通过。
`blockers`、`warnings` 保留原审计 issue 的精确位置信息；不同位置
的同类问题不会合并。流程预览展示完整来源，生成禁用提示使用同一短说明。
