# 生成参数

生成参数资产只保存尺寸与采样参数，不保存 workflow、模型、Prompt、能力开关或项目状态。生成配置的
每条 operation route 显式引用一份 workflow 和一份配方；需要不同参数时建立具有稳定 ID 的另一
份配方，不在 profile 内叠加 `defaults`、候选和最终参数。

工作台提供三种统一画幅：竖幅 3:4 为 960×1280、方形 1:1 为 1024×1024、横幅 4:3 为 1280×960。
Anima Basic 与 Qwen-Image-2.1 使用相同尺寸；`app/shared/canvas-presets.json` 提供界面选项，
模型适配器测试核对各候选路线的配方尺寸。旧项目使用的 2:3／9:16 配方键保留，避免改写既有项目。

当前 Qwen profile 的候选 route 共用 `qwen-image-2-1-candidate` 配方（约 1MP、25 步）。配方不保存
workflow 拓扑，也不描述整图派生、latent hires 或第二遍采样；这些能力当前没有开放。配方 ID 是项目
调整、任务冻结和来源追踪使用的身份；修改参数时保留 ID，建立不同用途时使用新 ID。
