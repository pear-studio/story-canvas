# 剧情事实读写

日常命令需要本地工作台服务在线，无需打开网页。统一入口、返回结果和并发语义见[Agent 直接操作工作台](../reference/agent-interfaces.md)。


`pages/<page>.content.json` 中的 `characters` 只列画面实际出现、会参与 render character
config/Prompt 的角色。`dialogue[].speaker` 表示对白归属，可以是未出现在画面中的项目角色；除 `npc`
外仍必须存在于当前 `characters/index.json`。画外 speaker 不会隐式加入画面角色或生成 Prompt。
对白排版按 speaker 的角色 ID 从 `lettering/settings.json` 读取显示颜色。

状态：已实现当前项目契约的底层 CLI、冲突边界和浏览器读取。

narrative/Prompt/text-sources 的 read/save 返回完整正文和两个指纹，可通过 stdin 提交，无需文件草稿。
网页保存与 read/save 共用领域提交函数，服务不创建草稿或 sidecar。

出处映射已不再用于默认创作流程，计划通过独立功能变更移除；以下仅记录当前仍存在的接口，不要求新文案维护映射。

text-sources 保存文案条目的语料出处映射（dialogue_id → `{ source_file, offset, original_sentence }`），
是可选的参考索引：无条目即自写，heart 条目挂出处被拒绝。保存时按语料文件字节偏移核验原句真实存在
（拒绝对路径、`..` 逃逸、符号链接与偏移不符），不做相似度校验；上游指纹是该页 narrative，
narrative 变化后旧草稿保存返回冲突。narrative 保存后对 text-sources 的悬空引用与 heart 挂出处返回
`downstream_diagnostics` 警告，不阻止写入。语料根为 `library/writing-corpus/`，
检索工具见 `app/scripts/corpus-search.mjs`，方法见 `library/writing-policies/copy-from-corpus.md`。

剧情页 narrative 使用 `scene_description` 简单白描画面中应有的事实，不自由发挥，不添加创意、
表现意图或设计感。由剧情编辑维护，创作规范要求填写且不超过 20 字（含标点）；技术契约只要求
字段存在且为字符串，空白或超长不阻止保存、生成。画面内容不会自动编译成 Prompt。
角色与场景验证页使用相同 content 契约。模板将目标物化为 scene_description。

`narrative save` 成功时输出 JSON `{ target_file, warnings }`，退出码为 0。画面内容超过
20 字时，`warnings` 包含 `code: "scene_description_too_long"`、`field: "scene_description"`、
`actual_length`、`max_length` 和中文 `message`；正常长度返回空数组。警告按本次已保存文本计算，
不进入项目事实，不阻止后续生成。Agent 必须读取警告，需要精简时重新 read 当前事实和指纹。
浏览器与写入命令共用计数规则：按 Unicode 字符计数，包含标点及空白。

Agent 平时可以直接读取项目内稳定 JSON。修改前通过 read 获取正文、目标及依赖指纹；
页面创建和删除使用语义命令：

```powershell
npm --prefix <仓库根>/app run story:page -- outline read <project-id>
npm --prefix <仓库根>/app run story:page -- outline save <完整草稿JSON文件|->
npm --prefix <仓库根>/app run story:page -- index read <project-id>
npm --prefix <仓库根>/app run story:page -- index save <完整草稿JSON文件|->

npm --prefix <仓库根>/app run story:page -- narrative read <project-id> <page-id>
npm --prefix <仓库根>/app run story:page -- narrative save <完整草稿JSON文件|->

npm --prefix <仓库根>/app run story:page -- text-sources read <project-id> <page-id>
npm --prefix <仓库根>/app run story:page -- text-sources save <完整草稿JSON文件|->

npm --prefix <仓库根>/app run story:page -- prompt read <project-id> <page-id>
npm --prefix <仓库根>/app run story:page -- prompt save <完整草稿JSON文件|->

npm --prefix <仓库根>/app run story:page -- page create <project-id> <sequence-id>
npm --prefix <仓库根>/app run story:page -- page delete <project-id> <page-id>
```

read 返回完整草稿对象，save 接收该对象的 JSON 文件或 stdin；只修改 document，原样保留指纹。
`save -` 从 stdin 读取草稿，read 的输出可以一条管道直接回写，无需落盘临时文件：

```bash
npm --prefix <仓库根>/app run story:page -- narrative read <project-id> <page-id> \
  | <修改 document 的命令> \
  | npm --prefix <仓库根>/app run story:page -- narrative save -
```

直接 `node app/scripts/story-page.mjs ...` 调用时 argv 不带 `--`。命令失败时错误 JSON 输出在
stderr、退出码为 1、stdout 为空；管道中消费 stdout 前先检查退出码。读取格式合法但不存在的
页面返回 `story_page_not_found`（422），格式非法返回 `invalid_story_page_id`（422）。

完整 outline、index 以及局部 synopsis/chapter/sequence 均使用相同协议。局部 chapter/sequence 只包含
标题和摘要，服务在项目操作锁内修改对应节点；sequence 归属变化会使旧草稿失效。
`context read` 返回 synopsis、所属章摘要和该章全部单元摘要，不展开其他章节。

同一项目的事实写入由 ProjectOperations 串行执行，排队后在实际执行时核对目标与必要上游指纹。
目标文件或必要上游变化时返回冲突，不自动重试或覆盖。其他页面、未引用角色及角色视觉文案变化
不会使 narrative 草稿失效，但同一项目内无依赖关系的写入也需要排队。统一边界见[项目操作协调器](project-operations.md)。

Prompt 写入在原子保存后捕获本次页面与必要上游快照，基于快照完成只读编译与审计。
审计异常只进入返回值 `audit`，不回滚事实。CLI 输出
`{ target_file, audit }`，具体状态与错误语义见[Prompt 写入流程](../reference/prompt.md)。

outline 是可独立写入的上游；写入造成 pages index 悬空时会返回 `downstream_diagnostics`，但不会阻止写入。
剧情 index 是统一 pages/index.json 中 story 归属的投影；写入只更新剧情归属，保留角色／场景页面。
剧情 index 写入必须针对当前 outline 有效，并与当前剧情 content/Prompt 文件严格配对。结构写入
同样在项目操作锁内执行；目标或必要上游指纹冲突后，由 Agent 重新读取和判断，不自动覆盖。

`page create` 由服务端生成页面 ID，写入一对最小合法 narrative/Prompt 并追加到指定 sequence。
`page delete` 从 index 移除页面，把页面事实和当前新 PageKey 布局下可明确归属的派生媒体移动到
`Saved/state/deleted-pages/<project-id>/<deletion-id>/`，归档清理函数只清理超过七天的记录。当前归档范围仅包括：

- `pages/<page-id>.{content,prompt,text-sources}.json`；
- `Outputs/pages/<page-id>/`（图片、结果和生成详情一起归档）。

归档内 `deletion.json` 记录原 `sequence_id`、从零开始的 `ordinal`，以及可为空的
`previous_page_id` / `next_page_id`，供 Agent 参考后重新创建；当前不提供 restore 命令。

不移动无明确页面归属的任务或缓存；旧项目先执行一次性离线存储迁移。
