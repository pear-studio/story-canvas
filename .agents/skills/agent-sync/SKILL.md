---
name: agent-sync
description: 仅当用户在当前请求中明确要求使用 agent-sync 时触发，不根据文件或任务类型自动触发。用于管理 StoryCanvas 的项目级 Agent 规则、技能链接与同步投影。
---

# Agent 配置同步

## 触发边界

只有用户在当前请求中明确要求使用 `agent-sync` 时才执行本技能。任务涉及 `AGENTS.md`、
`CLAUDE.md`、`.agents/skills/`、`.claude/skills/` 或 `docs/agent/`，本身不构成触发条件。

先完整阅读 `docs/agent/README.md`，以 `AGENTS.md` 和 `.agents/skills/` 为唯一事实
来源。不要从 `CLAUDE.md` 或 `.claude/skills/` 反向修改源文件。

## 检查

在写入前运行：

```powershell
node docs\agent\sync.mjs report
node docs\agent\sync.mjs apply --dry-run
```

确认所有计划操作只涉及根目录 `CLAUDE.md`、`.claude/skills/` 和同步状态文件。
遇到普通目录、未知链接或手工修改时停止并说明冲突，不覆盖或删除。

## 修改

- 仓库规则只修改 `AGENTS.md`，且使用中文。
- 技能只修改 `.agents/skills/<name>/`。
- 保持技能目录名、文档头部元数据中的 `name` 字段和所有引用一致。
- `description` 写清触发条件；正文只保留执行步骤，详细事实引用现有中文文档。
- 不创建或同步用户级技能，不写入用户主目录。

修改后执行：

```powershell
node docs\agent\sync.mjs apply
node docs\agent\sync.mjs doctor
```

再使用标准技能校验器检查所有变更过的技能。只汇报有效变化和发现的冲突，不粘贴
大段同步器原始输出。
