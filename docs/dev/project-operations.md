# 项目操作执行

本文记录当前实现的项目级并发边界。代码以
`app/server/project-operations.mjs` 和 `app/server/project-write-coordinator.mjs` 为准，不在领域
模块中复制并发控制。

## 操作 Interface

每条项目路由在服务端直接选择一个项目操作 Interface，不把语义交给请求 Header：

- `readFacts`：在一致的磁盘 revision 下读取项目事实；读取前后 revision 不一致时最多重试一次。
- `mutateTargetFacts`：目标及必要依赖由领域入口检查的窄事实写入，不要求全项目 expected revision；成功返回当前 revision。
- `mutateFacts`：修改项目事实或持久输入，必须携带 `x-story-canvas-expected-revision`。
- `deriveFromFacts`：按当前事实建立冻结的渲染或训练任务，也必须携带 expected revision。
- `mutateDerived`：修改任务、候选、媒体和缓存等可重建派生结果，不要求项目 revision。
- `copyProject`、`renameProject`：项目生命周期操作，必须携带源项目 expected revision。
- `state`：读取事实 revision；`GET /api/projects/:id/revision` 使用文件变化通知驱动的缓存，
  不变时不重复扫描。事实读写的并发校验仍读取实时磁盘签名，不依赖此缓存。

项目媒体、静态材料文件和非项目接口不属于项目操作 Interface。

## Revision 与锁

协调器为每个项目维护由事实文件磁盘签名得到的单一 revision，并在同一项目内使用 mutation lock
串行执行操作。需要项目凭据的事实写入和事实派生进入锁后重新计算当前 revision；expected revision 缺失返回
428，过期返回 409 `project_revision_conflict`。成功结果通过
`x-story-canvas-revision` 响应头返回新的 revision；revision 不写入项目 JSON。

浏览器写队列按项目串行发送 `mutateFacts`、`deriveFromFacts`、`copyProject` 和 `renameProject`，
从成功响应头保存下一次 expected revision。已失效的旧请求不会继续发送。
网页核心事实保存和 Agent read/save通过 mutateTargetFacts 共用提交过程，无关页面变化不阻止保存。
浏览器发现其接口要求的 revision、目标或依赖指纹过期时拒绝旧保存并标记后台同步，不自动重放写入。
每三秒的串行 revision 查询发现变化后重新获取 workbench 数据快照；替换前检查项目身份和
在途写入，旧响应不能覆盖新保存或推进客户端 revision。仅当前事实确实变化时覆盖对应未保存输入，
不做冲突合并或比较界面。Agent 的 read/save 入口仍需在目标或依赖指纹冲突后重新读取并判断。
材料与生成配置同时准备同版本项目事实，统一应用后才推进写入版本，不能让独立旧缓存
借用根工作台的新 revision。媒体投影的查询与缓存不进入事实 revision 扫描，不推进写入版本。

LoRA 工具页使用独立的 `/api/lora-training` 与 ETag / If-Match，不参与项目快照、复制或重命名。

revision 缓存按需观察已读取项目，覆盖独立 Agent CLI 写入；候选、任务、缓存和输出变化不使
事实缓存失效。服务关闭或项目移动时释放观察资源，文件通知不可用时查询回退到实时磁盘签名。

本机派生变更仍使用同一项目 mutation lock，但不改变项目 revision，也不校验浏览器凭据。项目复制
和重命名另有生命周期锁，重命名会登记旧目录，避免已移动项目继续写入。
候选展示不参与候选 mutation lock；真正修改候选的操作继续互斥。
事实写入只由单个 Node 服务执行；剧情、角色、页面与 Prompt 的互斥统一归项目 mutation lock，
领域内部不再获取角色引用、页面或 Prompt 依赖锁，也不再为分层加锁重复读取依赖。
目标与必要上游内容指纹继续检查，排队结束后过期草稿仍拒绝保存。候选与任务执行器保留所需的跨进程锁。
候选的 resource 写锁在执行操作之前最多退避等待约一秒，拿到锁后仍重验目标，
不重试整个操作。持续占用返回 `story_edit_target_busy`，与内容冲突分别显示。

## 读写返回值

`ProjectOperations.readFacts` 返回 `{ value, revision }`；事实写入和事实派生返回同样的结构。
HTTP Adapter 将 `value` 写入 JSON 正文，将 `revision` 写入响应头。`mutateDerived` 只返回派生领域
结果，不把本机状态伪装成项目 revision。

所有领域校验、原子保存、任务状态和文件安全规则继续由各自的领域模块负责；本 Module 不引入
批量事务，也不在 revision 冲突后替调用者自动合并或重试。

## 失败码

| 状态 | 错误码 | 含义 |
|---:|---|---|
| 400 | `invalid_project_credential` | 请求凭据结构无效 |
| 409 | `project_revision_conflict` | expected revision 已过期 |
| 409 | `project_changed_during_read` | 一致性读取期间事实持续变化 |
| 409 | `project_moved` | 项目已在生命周期操作中移动 |
| 428 | `expected_project_revision_required` | 事实写入或事实派生缺少 expected revision |
