---
name: prompt-authoring
description: 为 StoryCanvas 编写、编辑和生成页面 Prompt，根据图像错误优化表达；保持已确认画面内容不变，改变画面方案时另行讨论。
---

# Prompt 与生成

先读 [Prompt 参考](../../../docs/reference/prompt.md)；生成操作查 [页面参考](../../../docs/reference/visual-pages.md)。依据当前确认稿、相关角色与场景子设定、有效生成配置工作；仅委托文本时不自动出图。

- 修改前用 `prompt.read`；查继承来源用 `prompt.sources`，排查最终输入再用 `prompt.context`。保存沿用读取回执并提交 `changes`，不写回只读展开结果。
- 优先复用稳定上游内容，页面只补当前画面需要的表达；按 AGENTS 控制整页描述总量与关键限制。
- 自动修正针对结构错误、主体或关系歧义；重新审视整页并替换无效表达，不叠加补丁。改变动作瞬间、镜头、姿态或故事内容时只提出建议。
- 先排除模型、素材或配置缺失；这些问题转给 `comfyui-runtime`，不靠扩写 Prompt 掩盖。
- 生成数量、修正上限、候选清理及视频规则统一遵循 AGENTS；检查实际结果后交付入口和必要问题，不排名或推荐候选。

当前模型专用语义按参考文档处理；备用 Qwen 的文本、参考图与改写见 [Qwen](../../../docs/reference/qwen.md)，不把整段模型改写当作图像纠错。

命令与保存契约查 [Agent 接口](../../../docs/reference/agent-interfaces.md) 和操作 help。输入稳定且独立的已授权页面可并发提交，后续依赖生成结果的方案不预排。
