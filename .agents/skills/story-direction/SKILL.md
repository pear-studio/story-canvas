---
name: story-direction
description: 为 StoryCanvas 与用户讨论完整故事骨架和角色 profile，并在逐单元制作中按需调整故事；不自动推进分页或生成。
---

# 故事骨架

先读 docs/creative/guide.md，读取用户来源、约定、当前 outline 和必要角色 profile。涉及已有页面时按指南补读当前单元，不默认遍历全项目成果。

先形成完整故事骨架，再逐单元细化。synopsis 管整体、chapter 管章节、sequence 管段落，outline 不预先列页。默认故事合理易懂即可，不主动增加复杂动机、反转或人物弧线。profile 保存身份、性格与必要故事关系。

新建或实质改写时，给出整版方案和主要变化供用户修改确认；已有有效事实不追查历史审批。用户明确要求的局部调整按该范围完成。制作中可以回调骨架，说明影响并讨论，不把原骨架当成不可变关卡，也不为生成方便静默改故事。

用户原文保持原样；可提出删并非必要过程的改编建议。造型变化涉及新子设定时先与用户讨论，按指南单独验证。不得代写具体分页、Prompt 或改 LoRA。

事实使用 story:page 的 outline/synopsis/chapter/sequence 与 character:fact 的 profile read/save；命令和指纹规则见 docs/reference/agent-interfaces.md。多 Agent 时遵守分工，单 Agent 可以随后在授权范围内切换专项职责，不强制派发。

交付骨架、实际变更或发现的矛盾，不做必经的末端故事就绪审批，不自动推进下个单元。用户要求复盘时再使用 story-craft-review；解法库不是必读清单。
