# 角色事实读写

日常命令需要本地工作台服务在线，无需打开网页。统一入口、返回结果和并发语义见[Agent 直接操作工作台](../reference/agent-interfaces.md)。


读取稳定 JSON 不受影响；修改统一使用 read/save。read 返回正文、目标和依赖指纹；只修改 document，
save 接收完整草稿对象的 JSON 文件或 stdin。服务不托管草稿，网页和命令共用领域提交函数。

## 职权与命令

剧情导演编辑角色的非视觉事实：

```powershell
npm --prefix <仓库根>/app run character:fact -- profile read <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- profile save <完整草稿JSON文件|->
```

视觉导演编辑角色视觉描述和 variant 身份：

```powershell
npm --prefix <仓库根>/app run character:fact -- visual read <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- visual save <完整草稿JSON文件|->
```

Prompt Agent 使用 `prompt.read/save` 编辑设定基础或单个子设定；按当前模型返回完整范围与保存参数。
新增子设定、引用及来源版本的要求由统一操作帮助维护，不回传整个 models 容器：

```powershell
node <仓库根>/app/scripts/story-canvas.mjs help prompt
node <仓库根>/app/scripts/story-canvas.mjs prompt.read --args <读取参数JSON> --out <读取回执JSON>
node <仓库根>/app/scripts/story-canvas.mjs prompt.save --args <保存参数JSON> --out <保存回执JSON>
```

Prompt 保存使用读取回执的保存参数加 `changes`，旧 `character:fact prompt read/save` 返回升级指引。冲突后重新读取并判断，不自动覆盖。
角色 visual 是上游，合法的 variant 变更可以造成
下游悬空，并在结果中返回结构化 diagnostics。角色 Prompt 是下游，不允许未知 variant；Prompt 可暂缺部分 variant 并返回诊断。实际生成检查本次依赖是否完整。

Prompt 保存后的审计只检查本次范围，不遍历关联页面；审计错误或不可用不改变保存成功。详细状态见[Prompt 写入流程](../reference/prompt.md)，返回字段以统一操作帮助为准。

## 创建与删除

角色 ID 是调用者给出的可读、严格 ASCII kebab-case 语义 ID：

```powershell
npm --prefix <仓库根>/app run character:fact -- character create <project-id> <character-id> [name]
```

命令原子创建 profile、visual、prompt 三份最小合法事实并追加到 `characters/index.json`。Prompt
的 `prompt_name` 复制显示名称，自带一个 `{id: "default", name: "默认"}` 子设定（空文本、空参考图）。

删除角色前必须先得到用户明确确认：

```powershell
npm --prefix <仓库根>/app run character:fact -- character delete <project-id> <character-id>
```

删除只移出该角色的三份核心事实和 index 条目，不级联修改剧情引用、角色视觉页、文字样式或媒体。
命令返回这些下游悬空诊断，并将事实按原相对路径归档到
`Saved/state/deleted-characters/<project-id>/<deletion-id>/`。`deletion.json` 记录原 ordinal 和
相邻角色，归档清理函数只清理超过 7 天的记录；当前不提供 restore，Agent 可参考归档重新创建。

## 并发边界

角色事实与其他项目事实共用[项目操作协调器](project-operations.md)，同一项目内的写入串行执行，
不同角色和无依赖页面也需要排队。实际执行时核对目标与必要上游指纹；冲突后由 Agent 重新读取和判断，
不自动覆盖。

variant 身份、visual description 或角色配置变化通过必要上游指纹使相关旧草稿失效，不再逐一锁定
引用页面，也不自动改写下游事实。角色删除仍返回下游悬空诊断。
