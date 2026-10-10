# Agent 与 DSH 接入

本文负责规则加载、工具连接与本机投影；任务入口在 [AGENTS](../../AGENTS.md)，领域规则不复制进 persona。

## DSH 创作模式

`.dsh/presets/cordis.patch.yml` 声明 bundle，通过 Plugin Manager 安装，或运行：

```powershell
dsh plugin --profile web add <仓库根绝对路径>/.dsh/presets
```

- `story-canvas` 是完整创作预设；`story-canvas-lite` 仅开放文件查找、读文／读图和工作台工具，禁用生成及训练执行。具体能力以工具 help 为准，不绕过禁用项。
- persona 只声明沟通方式、知识入口和工具边界。工具提供 `story_canvas_root`，会话目录在外部项目时也能定位工具仓库；先读其 AGENTS，再加载相关技能和专项规则。
- 创作预设的工作区指令只加载 AGENTS 系列，避免旧 CLAUDE 投影干扰。项目技能由 filesystem provider 发现；目录缺少技能时直接读取工具仓库 `.agents/skills/<名称>/SKILL.md`。
- `story_canvas` 与 CLI 共用操作注册表；未知操作先查 help，操作细节再查 topic，不搜索旧脚本或猜 HTTP。
- `status` 检查工具加载版本与磁盘版本；不代表 persona 或服务端版本。预设／工具更新后重启 DSH，恢复会话按原预设 ID 加载；压缩不会重载插件。检查新会话实际提示词及技能目录，不能只看磁盘文件。
- 模型提供方、设备路径和 profile 属于部署配置；bundle 不保存本机凭据。

## 工具与 CLI

有 `story_canvas` 时直接使用。CLI 连接本机 Node 服务，连接失败没有离线写入后备；命令使用仓库绝对路径：

```powershell
node <仓库根绝对路径>/app/scripts/story-canvas.mjs help
node <仓库根绝对路径>/app/scripts/story-canvas.mjs help <分类或操作> [字段主题]
node <仓库根绝对路径>/app/scripts/story-canvas.mjs <操作> --args <参数JSON绝对路径> --out <回执JSON绝对路径>
```

分类、参数、保存冲突、部分失败及长任务恢复以 help 和结构化回执为准。输入输出分开，回执用 `--out`，不通过 shell 管道或重定向搬运 JSON；操作完成但回执写盘失败时先查结果。

多语言嵌字由当前 Harness 会话按[嵌字翻译规则](../creative/translation.md)处理：用 `translation.*` 读取、保存译文，`translation.inspect` 检查排版，再用 `finished.*` 制作成品；字段、原文变化及副作用以各操作 help 为准。工作台只编辑、预览和输出，不提供翻译生成按钮。资料查询工具按实际 help 使用；未提供多语言查询时读取参考来源的同 ID 文本。

语义操作未覆盖的现有能力才查代码并使用 `app/scripts/workbench-api.mjs`，不另维护路由清单；上传和流式媒体走专用入口，极简模式不提供任意 HTTP。

## Codex 与 Claude

`.agents/skills/` 是技能源，Codex 项目配置在 `.codex/config.toml`。Claude 的 `CLAUDE.md`、技能链接和同步状态是被忽略的本机投影，不反向修改源。

AGENTS 中规定的显式同步委托使用 `agent-sync`：

```powershell
node <仓库根绝对路径>/docs/agent/sync.mjs report
node <仓库根绝对路径>/docs/agent/sync.mjs apply --dry-run
node <仓库根绝对路径>/docs/agent/sync.mjs apply
node <仓库根绝对路径>/docs/agent/sync.mjs doctor
```

只维护同步器登记的投影，未知链接、普通目录或手工文件冲突时停止；Windows 用目录联接，其他平台用符号链接，不静默复制。技能修改校验 frontmatter、UI 元数据和引用，不因普通编辑执行同步。
