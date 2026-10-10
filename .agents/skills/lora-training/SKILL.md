---
name: lora-training
description: 为 StoryCanvas 准备 LoRA 素材与 Caption，配置、预检、诊断和分析训练；明确授权后发起训练。当前工作台可新建 Qwen 训练，Anima 恢复另行委托。
---

# LoRA 训练

先读[训练知识](../../../docs/reference/lora-training.md)；决定触发词时读取 `training.activation-guide`，网上补图用 `lora-material-sourcing`。

1. 读取训练目标、当前设置和有效素材。仅委托导入、裁剪或分组时，不自动增加打标或训练。
2. 使用训练数据／图像工具处理素材；按需要显式准备图像，实际看图和 Caption 后确认或登记审计。
3. 保存底座、配方和预算，读取运行参数并预检；环境缺失按[环境搭建](../../../docs/reference/setup.md)诊断。
4. 训练必须有用户授权并通过预检；沿用已授权轮数、预算和停止条件，不因失败无限重跑。
5. 核对结构化进度和 run 状态；停止和续训查对应 help，不把改数据或参数伪装为续训。
6. 按冻结 manifest 和比较条件分析，不从文件名猜身份，不自动选定或删除结果。

选定结果并获授权后按[资源规范](../../../library/resources/README.md)登记正式 LoRA；训练产物不自动成为全局资源。
