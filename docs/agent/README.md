# Agent 集成

`AGENTS.md` 是通用规则唯一来源，`.agents/skills/` 是项目技能源；职责和操作分别查源文件与工具 help，不在预设里复制。项目级 Codex 配置在 `.codex/config.toml`。

## Claude 投影

Codex 直接读取源文件。Claude 的根 `CLAUDE.md`、`.claude/skills/` 链接及 `.claude/.agent-sync.json` 由 `sync.mjs` 生成，均忽略；不反向修改源或管理用户级技能。

仅在当前请求明确使用 `agent-sync` 时运行：

```powershell
node <仓库根绝对路径>/docs/agent/sync.mjs report
node <仓库根绝对路径>/docs/agent/sync.mjs apply --dry-run
node <仓库根绝对路径>/docs/agent/sync.mjs apply
node <仓库根绝对路径>/docs/agent/sync.mjs doctor
```

同步器只维护自己登记的投影；普通目录、手工文件或其他来源链接发生冲突时停止。Windows 用目录联接，其他平台用符号链接，不静默复制。修改技能后校验目录名、frontmatter、UI 元数据和引用；无需仅因编辑技能而执行同步。

## DSH 预设

`.dsh/presets/` 是本地 bundle，声明在 `cordis.patch.yml`。通过 Plugin Manager 安装，或：

```powershell
dsh plugin --profile web add <仓库根绝对路径>/.dsh/presets
```

- `story-canvas` 是完整预设；`story-canvas-lite` 只呈现 `glob`、`read`、`read_image`、`story_canvas`，不提供通用文件写入和 Shell。
- 两者使用同一工作台客户端。极简预设禁用 `generation`、`training` 执行能力；普通编辑、参考图导入、候选清理、已有成品导出及训练素材编辑、只读预检仍可用。禁用项交给具备能力的 Agent，不绕过限制。
- 工作台用法由 `story_canvas` help 按分类、操作和 topic 提供；CLI 共用操作注册表，入口见 [Agent 接口](../reference/agent-interfaces.md)。
- `status` 返回客户端加载版本、磁盘版本和限制；不是服务端版本。更新后重启 DSH，恢复会话按原预设 ID 加载当前插件；压缩不重新加载插件。
- 模型提供方、本机路径与 profile 独立配置，不由 bundle 安装。提示词和压缩策略以预设声明为准，不在此复制数值或本机模型选择。
