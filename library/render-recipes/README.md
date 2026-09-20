# 生成参数

生成参数资产只保存尺寸与采样参数，不保存 workflow、模型、Prompt、能力开关或项目状态。生成配置的
每条 operation route 显式引用一份 workflow 和一份配方；需要不同参数时建立具有稳定 ID 的另一
份配方，不在 profile 内叠加 `defaults`、候选和最终参数。

当前 Anima profile 只声明 candidates 的 `empty_latent` route。配方不保存 workflow 拓扑，也不描述整图
派生、latent hires 或第二遍采样；这些能力当前没有开放。配方 ID 是项目调整、任务冻结和来源追踪使用的身份；修改参数时保留 ID，建立
不同用途时使用新 ID。
