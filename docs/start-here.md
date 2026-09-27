# 从这里开始

Agent 日常操作需要本地工作台服务在线；命令与 API 统一说明见[直接操作入口](reference/agent-interfaces.md)。

StoryCanvas 是由多 Agent 协作操作的本地系列图片视觉化工作台。用户通过浏览器查看项目、
手动选择候选和调整文字样式；Agent 通过项目 JSON 与本机 CLI 维护故事、角色和生成结果。

普通创作先读[创作指南](creative/guide.md)。团队职责、分歧处理和文件写入边界都在该页集中说明；
技能按任务意图选择，不按工作台按钮拆分。

## 任务入口

| 当前任务 | 入口 |
|---|---|
| 第一次接手、长期恢复，或用户只说“开始”“继续”“下一步” | `project-orientation` |
| 建立或调整 synopsis、chapter、sequence 和角色 profile | `story-direction` |
| 把当前 sequence 拆页、合页、重排或修改 narrative | `story-editing` |
| 从用户已验收页面提炼可复用视觉叙事解法 | `story-craft-review` |
| 需要角色或整组视觉方向、分页机位建议 | `visual-production` |
| 编写或审计 Prompt 原型、生成和严重问题检查 | `prompt-authoring` |
| 比较画风、角色形象、构图、色彩、氛围等主观方向 | `visual-exploration` |
| 验证动作、朝向、服装、镜头或 Prompt 是否可靠 | `generation-testing` |
| 安装、启停或诊断 ComfyUI、模型和自定义节点 | `comfyui-runtime`，阅读[环境搭建](reference/setup.md) |
| 准备、诊断或分析 LoRA 训练 | `lora-training`，阅读[LoRA 训练](reference/lora-training.md) |

用户主导故事、审美和推进节奏。明确小任务直接使用专项技能，完成当前要求后交付，不默认继续下一阶段。完整骨架先讨论，单元分页草案带基础文案分配与简短机位建议，经用户修改确认后执行。

保留剧情导演、剧情编辑、视觉导演、Prompt Agent 四种职责，按任务需要使用，不要求每次启动完整团队。普通出图每页三张，全部交给用户；严重问题检查和一次修正规则集中见[创作指南](creative/guide.md)。角色子设定单独经用户验收后使用。文案优化、探索、测试与复盘按用户需要独立开展。

项目的位置、临时复制、提升与备份见[本地项目管理](reference/local-projects.md)。

## 当前项目事实

- outline 只保存 synopsis、chapter 和 sequence 粗骨架，后续走向可以存在但不预先分页；
- 剧情页面 index、narrative 与 Prompt 分开；角色 profile、visual 与 Prompt 分开；
- 角色、场景及页面 Prompt 使用 `{$schema, models:{anima:…,qwen:…}}` 容器，分别保留模型输入；
  Anima 使用基础设定、分类词条与 Prompt／LoRA 继承；Qwen 使用 prompt_name、子设定自由文本和有序参考图。
  字段及覆盖规则见[模型适配器](dev/model-adapters.md)，编辑前用 `page.editor.read` 读取相关页面文件；引用展开和最终输入按需查询 `prompt.context`；
- 场景在“场景”页维护共享环境描述，剧情页单选引用；Qwen 可整段 override 引用文字，Anima 可调整继承词条及 LoRA；
- 验证图由系统自动编号；角色 visual 只维护子设定名称，具体视觉以 Prompt 为准；
- 页面 Prompt 按当前模型保存词条或自由文本、引用与覆盖，不把只读展开结果写回；
- 稳定项目 JSON 可以直接读取，但只能通过 Node.js read/save或语义命令写入；
- 渲染每次生成一至三张候选，返回任务和图片的完整绝对路径，不携带项目 revision；
- 普通原型保留全部候选，不替用户筛选、选择或写文字样式；候选删除功能仅在用户明确要求清理时使用；用户可在浏览器编辑并手动保存；
- LoRA 修改必须先取得用户明确同意。

项目完整边界见[项目文件](reference/project-files.md)，页面流程见
[视觉页面参考](reference/visual-pages.md)，Prompt 结构见 [Prompt 编写与审计](reference/prompt.md)。

## 第一次启动

```powershell
npm --prefix <仓库根>/app ci
npm --prefix <仓库根>/app run setup
npm --prefix <仓库根>/app run dev
```

打开 `http://127.0.0.1:3000/?project=<project-id>&tab=story` 查看项目。稳定运行时先执行
`npm --prefix <仓库根>/app run build`，再使用 `npm --prefix <仓库根>/app run start`。

需要由 Linux 工作台调用 Windows 生成设备时，Windows 首次以管理员运行 `配置远程生成[Tailscale][管理员].bat`，
日常运行 `启动ComfyUI.bat` 或使用工作台启动按钮。跨设备地址在
`app/comfyui-endpoints.json` 中统一配置；Linux 运行 `bash ./start-remote-workbench.sh`。该入口与 Windows 工作台一致使用开发模式，
不需要预先构建前端。普通候选图会下载并保存在 Linux 项目中；
对比实验、LoRA 训练和超分仍在 Windows 本机运行。完整配置见[远程候选生成](reference/setup.md#远程候选生成)。

`app/comfyui-endpoints.json` 保存由 Git 同步的跨设备 ComfyUI 地址与优先级；`Config/local.json` 保存当前设备自己的 ComfyUI 直连地址，以及本机模式所需的 comfy-cli、模型和可选 LoRA 训练器路径及本机
凭据。这些内容被忽略，不进入 Git。环境安装、更新和诊断使用 `comfyui-runtime`，不要猜测路径
或回显凭据。

## 新建项目

```powershell
npm --prefix <仓库根>/app run project:create -- template <project-id>
npm --prefix <仓库根>/app run project:create -- create <完整草稿JSON文件|->
```

创建文件只描述项目 metadata、粗 outline 和最小角色 profile/visual。服务端生成完整项目目录、
空页面索引和空 Prompt 配置；不会复制旧项目页面、候选或临时判断。模板骨架不含 sequence，
建页前先创建情节单元：`npm --prefix <仓库根>/app run story:page -- sequence create <project-id> <chapter-id> <标题>`。

## 常用创作命令

```powershell
# 剧情导演
npm --prefix <仓库根>/app run story:page -- outline read <project-id>
npm --prefix <仓库根>/app run story:page -- outline save <完整草稿JSON文件|->
npm --prefix <仓库根>/app run character:fact -- profile read <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- profile save <完整草稿JSON文件|->

# 剧情编辑
npm --prefix <仓库根>/app run story:page -- page create <project-id> <sequence-id>
npm --prefix <仓库根>/app run story:page -- index read <project-id>
npm --prefix <仓库根>/app run story:page -- narrative read <project-id> <page-id>

# 视觉导演
npm --prefix <仓库根>/app run character:fact -- visual read <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- page create <project-id> <character-id> <variant-id>
npm --prefix <仓库根>/app run character:fact -- page-goal read <project-id> <page-id>
npm --prefix <仓库根>/app run fact:edit -- read scene profile <project-id> <scene-id>
npm --prefix <仓库根>/app run visual:produce -- candidate delete <project-id> <page-id> <absolute-candidate-path>

# Prompt Agent：编辑前先完整读取，返回 draft 用于后续 save
npm --prefix <仓库根>/app run visual:produce -- context page <project-id> v3/<page-id>
npm --prefix <仓库根>/app run story:page -- prompt read <project-id> <page-id>
npm --prefix <仓库根>/app run character:fact -- prompt read <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- page-prompt read <project-id> <page-id>
npm --prefix <仓库根>/app run visual:produce -- render page <project-id> <page-id> --count 3 --wait
npm --prefix <仓库根>/app run visual:produce -- candidate delete <project-id> <page-id> <absolute-candidate-path>
```

所有事实 read 命令返回正文与目标/依赖指纹；只修改 document，再将完整 JSON 交给同一 kind 的
`save <完整草稿JSON文件|->`。服务不托管草稿。busy 可有界退避；内容指纹冲突必须重新读取和判断。
草稿跨轮次保存时在各命令末尾加 `--out <绝对路径文件>` 落盘到 `Saved/Agent/<任务名>/`，
不用 shell 管道或重定向搬运 JSON；完整契约见 `docs/reference/agent-interfaces.md`。
outline 支持 synopsis/chapter/sequence 局部读写，具体范围见[Agent 接口](reference/agent-interfaces.md)。

开发入口见[开发文档导航](dev/README.md)。
