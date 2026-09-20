# Agent 配置管理

StoryCanvas 的 Agent 规则和技能都保存在仓库中，随代码一起同步。当前只管理项目
级配置，不安装或修改用户级技能。

## 唯一事实来源

| 路径 | 作用 |
|---|---|
| `AGENTS.md` | 整个仓库的持久 Agent 规则 |
| `.agents/skills/` | 跨 Agent 共用的项目技能 |
| `.codex/config.toml` | Codex 项目级并发容量配置 |
| `docs/agent/sync.mjs` | 生成规则投影并建立技能链接 |

Codex 直接读取 `AGENTS.md` 和 `.agents/skills/`，无需额外同步。Claude Code 使用：

- 根目录 `CLAUDE.md`：由 `AGENTS.md` 生成；
- `.claude/skills/<name>`：指向 `.agents/skills/<name>` 的本地链接。

`.claude/skills/` 和 `.claude/.agent-sync.json` 是本机投影，不进入 Git。生成的
`CLAUDE.md` 同样不进入 Git，由根目录 `.gitignore` 排除；新设备运行同步后即可获得
当前规则投影。

## Codex 并发容量

项目 `.codex/config.toml` 将 `agents.max_concurrent_threads_per_session` 设为 `12`，主协调 Agent
不计入该值，即最多十三个同时开放的任务。容量支持词库等批量任务的修订与独立审核并行，
按实际可拆分工作分配成员，不要求每次用满。创作保留四种职责，按需使用；不要求四个常驻实例。

此设置属于 Codex，不是 StoryCanvas 服务的任务调度器。项目配置仅在被信任的项目中加载；
已有任务可能保留初始化时的配置，修改文件不代表正在运行的团队已扩容。遇到容量报错先核对
实际加载值和已有成员，优先复用责任 Agent，不反复创建。不要为应用新配置中断正在进行的工作；
下一次初始化团队时确认容量。字段含义见 [Codex 官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 命令

```powershell
node docs\agent\sync.mjs report
node docs\agent\sync.mjs apply --dry-run
node docs\agent\sync.mjs apply
node docs\agent\sync.mjs doctor
```

- `report` 只读展示源技能、规则和投影状态；
- `apply --dry-run` 展示准备执行的操作；
- `apply` 更新 `CLAUDE.md`、建立技能链接并记录状态；
- `doctor` 检查规则漂移、缺失或冲突的技能链接，以及技能元数据。

同步器不会覆盖普通目录、手工文件或指向其他来源的链接，只会删除状态文件明确记录且
仍指向本仓库技能源的旧链接。Windows 使用目录联接，Linux/macOS 使用目录符号
链接；链接失败时明确报错，不静默复制技能。

## 新增或修改技能

1. 在 `.agents/skills/<skill-name>/` 中创建或修改技能；
2. 保证目录名与 `SKILL.md` 的 `name` 一致；
3. 使用中文编写 `description` 和正文，机器标识保持英文；
4. 详细事实优先引用 `docs/`、`library/` 或代码，不复制到技能中；
5. 运行标准技能校验器；
6. 仅在用户当前请求明确要求 `agent-sync` 时执行同步器的预演、应用和诊断；Codex 直接读取源技能；
7. 对复杂技能用真实任务做前向验证。

技能只描述可重复的 Agent 工作流。始终生效的仓库约束写入 `AGENTS.md`，面向用户的
产品说明写入 `docs/`，不要混入技能正文。

创作团队的职责与分歧处理只在[创作指南](../creative/guide.md)维护一张表；技能引用该表并按
当前任务分工明确写入范围，不重复建立角色定义，也不实现角色认证。

## 当前技能分工

| 技能 | 使用时机 |
|---|---|
| `project-orientation` | 新项目、恢复任务或存在多个合理起点时，了解现状并与用户确定本轮方案 |
| `story-direction` | 剧情导演维护粗 outline 和短篇角色 profile |
| `story-editing` | 剧情编辑把当前 sequence 滚动拆分成页面并维护 index 与 narrative |
| `story-craft-review` | 从用户明确验收的页面提炼解法，经再次确认后更新生成解法库 |
| `visual-production` | 提出角色与整组视觉方向、机位建议，组织用户验收子设定 |
| `prompt-authoring` | 编写 Prompt 原型、通过机位控制设置镜头、出图与有限修正；LoRA 改动需用户同意 |
| `visual-exploration` | 用可比较候选校准画风、角色形象、构图和其他主观偏好 |
| `generation-testing` | Prompt Agent 受控验证动作、镜头或 Prompt 是否可靠，与视觉导演确认视觉目标 |
| `comfyui-runtime` | 安装、启动、停止或诊断本机生成环境 |
| `lora-material-sourcing` | 按 LoRA 专项目标搜寻、核查、去重并整理角色参考图 |
| `lora-training` | 准备和诊断 LoRA 任务，整理素材与 Caption，分析 run 和 checkpoint |
| `agent-sync` | 仅在用户当前请求明确要求时，修改规则、技能或 Agent 投影并验证同步结果 |

这些技能按任务意图使用，不按按钮拆分。四种职责不要求四个独立常驻实例；单 Agent 可依次调用相关技能，多 Agent 仅在当前任务需要且获授权时使用。容量不是自动派发或扩大工作范围的理由。

普通制作的范围、用户确认、生成与停止规则统一见创作指南。探索、受控测试、复盘及运行环境维护按明确需要单独使用，不形成默认长期工作链。
