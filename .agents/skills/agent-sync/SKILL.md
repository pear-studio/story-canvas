---
name: agent-sync
description: 仅当用户当前请求明确要求 agent-sync 时使用，管理 StoryCanvas 项目级规则、技能链接与 Claude 同步投影；修改相关文件本身不触发。
---

# Agent 配置同步

先读 [Agent 集成](../../../docs/agent/README.md)。以 `AGENTS.md` 和 `.agents/skills/` 为源，不从生成投影反向修改，也不安装用户级技能。

1. 用仓库绝对路径运行同步器 `report`、`apply --dry-run`，检查计划仅涉及受管规则、技能链接和同步状态。
2. 普通目录、未知链接或手工修改发生冲突时停止，不覆盖或删除。
3. 按已委托范围修改源规则或技能；名称、目录与引用保持一致，详细事实链接至所属文档。
4. 运行 `apply` 和 `doctor`；修改过的技能另用标准 `quick_validate.py` 校验。

命令示例与投影边界只在集成文档维护。汇报有效变化及未解决冲突，不粘贴完整回包。
