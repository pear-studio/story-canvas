# 极简预设操作速查

本文件按需读取，不常驻模型上下文。项目规则唯一来源是仓库 `AGENTS.md`，完整接口见
`docs/reference/agent-interfaces.md`。遇到未覆盖的创作要求，读取对应项目技能；不要猜接口。
本预设按用户明确要求将 Prompt 每条动作/关系的上限改为20个英文词，覆盖原15词要求；不拆条绕过。

## 定位项目与读取事实

- `story_canvas_api`：`{method:"GET",path:"/api/projects"}` 查询项目；返回 `{value,revision}`。
- `story_canvas_facts`：`{operation:"read",domain:"story",kind:"outline",project_id:"实际ID"}` 读骨架。
- `story/index` 读页面顺序；`story/narrative` 加 `target_id` 读指定页。
- `character/profile`、`scene/profile` 加 `target_id` 读角色或场景；不要猜字段或目标 ID。
- 设计某单元前，先读骨架和该单元页面，再补需要的角色设定。机械修改只读必要依赖。

## 编辑事实与 Prompt

read 返回 `{project_id,target_id,document,expected_sha256,expected_context_sha256}`。
只改 `document`；save 传 `{operation:"save",domain,kind,draft:完整草稿}`。
冲突后重新读、判断差异，不把新指纹贴到旧草稿上强行提交。
回执里的保存成功与诊断分别说明；有诊断不等于没保存，不能盲目重放请求。

编辑 Prompt 使用 `{operation:"prompt-context",project_id,page_key:"v3/实际页面ID"}`。
阅读完整 `context` 的引用、覆盖、参考图、编译结果、审计及当前模型，修改 `draft.document`。
保存时取返回的 `save.domain`、`save.kind` 和完整 `draft`，不要提交只读 `context`。
页面可能使用 Anima 或 Qwen，沿用读出的模型结构，不覆盖其他模型的数据。
Prompt 写法详见 `docs/reference/prompt.md`，不要将读出的上游展开文本写回本页。

## 创建与管理页面

创建、复制、删除页面用导航语义接口，不能只改 index 模拟创建/删除。
先 GET `/api/projects/实际项目ID/revision`，取 `value.revision`。
再用 `story_canvas_api` POST `/api/projects/实际项目ID/workbench/navigation/操作名`，
传相应 `body` 和刚读取的 `revision`：

| 操作名 | body |
|---|---|
| `create-sequence` | `{chapter_id:"实际章节ID",title:"用户确认的标题"}` |
| `create-story-page` | `{sequence_id:"实际单元ID"}` |
| `duplicate-story-page` | `{page_id:"实际页面ID"}` |
| `delete-story-page` | `{page_id:"实际页面ID"}` |

每次写入后版本会变化；下次写入使用最新读取或回执提供的版本。409 后重新判断，不自动重放。
排序通过 `story/index` 的 read/save，保留读取的字段结构。
新建项目先 POST `/api/agent/project-create/template`，body `{project_id:"新ID"}`；
修改返回模板的 document 后，将完整模板 POST `/api/agent/project-create/create`。
新增故事分页须先由用户确认草案，不顺手扩展后续单元。

## 能力范围

`read` 支持 `file_path`、`offset`（从1开始）、`limit`（最多100行）；分页读取所需文档。
`read` 不能列目录。未知文件路径先用 `glob`：例如 `{path:"仓库绝对路径/docs",pattern:"**/*.md"}`。
`glob` 查找文件路径，单次内联最多40项；尽量缩小目录和模式，再读取匹配文件。
它不是完整目录树工具；尤其不要在仓库根用 `*`，DSH 会递归匹配整个目录树。
项目页面与角色列表优先查工作台事实/索引，不通过扫描文件猜业务 ID。
`read_image` 接收本地图片绝对路径，模型必须支持图像。图片本身也占用上下文，按需要读取。
没有通用 `write` 不影响工作台事实编辑：`story_canvas_facts.save` 会调用服务保存，导航接口负责页面生命周期。
任意文件编辑、Shell、联网、上传下载等能力并未提供。生成、训练、环境维护和开发请用户交给其他 Agent。
发现缺少必要或方便的工具时，说明缺口并请求用户提供工具，或交给其他 Agent，不反复尝试低效绕路。
长会话支持自动压缩及 `/compact`；重要目标和已确认决定仍应保存到项目事实。
