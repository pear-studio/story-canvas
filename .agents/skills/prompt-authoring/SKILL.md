---
name: prompt-authoring
description: 为 StoryCanvas 编写、编辑和生成页面 Prompt，根据图像错误优化表达；保持已确认画面内容不变，改变画面方案时另行讨论。
---

# Prompt 与生成

先读[Prompt 与生成规则](../../../docs/creative/prompt-generation.md)，依据已确认画面、实际引用的设定和生成配置工作。

1. 用 `prompt.read` 读取目标；字段按需查操作 topics，继承来源查 `prompt.sources`，最终输入问题再查 `prompt.context`。
2. 基于本次读据组织修改，按 save 回执提交；编写、修正、LoRA 确认遵循专项规则。
3. 已授权出图时预检、提交并等待同一任务；视频先查 `help target:video`。独立且输入稳定的页面可并发，依赖生成结果的方案不预排。
4. 实际查看成果；按专项规则判断是否修正，并按候选清理 help 保留所需结果。
5. 交付入口和必要问题；模型、素材或环境缺失交给 `comfyui-runtime`，不靠扩写 Prompt 掩盖。

备用 Qwen 才读[专用文档](../../../docs/reference/qwen.md)。没有工作台工具时用[集成说明](../../../docs/agent/README.md)的 CLI。
