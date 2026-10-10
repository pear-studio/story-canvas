---
name: lora-training
description: 为 StoryCanvas 准备 LoRA 素材与 Caption，配置、预检、诊断和分析训练；明确授权后发起训练。当前工作台可新建 Qwen 训练，Anima 恢复另行委托。
---

# LoRA 训练

先读 [训练参考](../../../docs/reference/lora-training.md)；决定标签时查 [激活标签](../../../docs/reference/lora-activation-tags.md)。训练为迭代任务，不把当前配方或少量样本效果当作定论。

- 读取登记项目的训练目标、当前设置、有效素材集合和预检。仅委托导入、裁剪或分组时止于该范围，不自动扩展标注或训练；网上补图用 `lora-material-sourcing`。
- 当前工作台新训练为 Qwen-Image-2.1；历史 Anima run 只读，恢复 Anima 训练另开任务，不假定已有可用入口。
- Caption 可用标签或自然语言，不自动改格式或增删触发词。按训练目标检查可见身份与变化因素，不猜图片没有的信息。
- Caption 审计按参考文档的有效集合、图片 hash 和数据集 ETag 执行；实际看图及最终文本后才登记，阻断项不标记已审计。不直接写训练事实或审计 JSON。
- 设置通过工作台结构化入口保存，核对确切底座、recipe 和运行预算。环境缺失按 [环境搭建](../../../docs/reference/setup.md) 诊断。
- 启动前通过预检；数据准备或分析不等于授权训练。已授权的轮数、预算和停止条件沿用，不重复请示，也不因失败无限重跑。
- 启动后核对结构化进度和 run 状态；停止、最新完整恢复状态与冻结参数续训按训练参考处理，不把参数或数据变化伪装为续训。
- 分析读取 manifest、status 和比较条件；不从文件名猜 checkpoint 身份，不自动选定或删除结果。

用户选定结果并授权后，按 [资源规范](../../../library/resources/README.md) 登记正式 LoRA；不要假设网页存在“保存为 LoRA”按钮。训练权重、归属与跨项目读取遵循 AGENTS。
