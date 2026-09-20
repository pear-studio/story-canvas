# 生成配置

`render_profile` 是模型、Prompt 策略、生成参数、workflow 和风格 LoRA 的组合入口。
模型与 LoRA 使用稳定语义 ID 的对象映射；operation 和输入来源使用固定 route，不再保存
重复的能力布尔值，也不通过数组下标定位可调整项。

当前只保留两个 Anima profile：`anima-base-v1` 与 `anima-aesthetic-v1-1`。
每个 profile 直接声明 `dit`、`text_encoder`、`vae` 三份模型、Prompt policy、候选 route
和候选 recipe；编译器、Render Plan 与任务快照都只面对同一份 `operations`。

两份 Anima profile 共用候选工作流骨架，但各自引用独立 recipe。`steps`、CFG、sampler、
scheduler 和尺寸是当前验证前的起步值，不等于模型作者对所有场景的硬性要求。

新增或修改生成配置时：

1. 在 `library/resources/catalog.json` 登记模型精确身份，并在 profile 中引用相同路径与 SHA-256；
2. 复用或新增 `library/prompt-policies/` 与 `library/render-recipes/` 中的稳定资产；
3. 为每个实际支持的 operation/input source 显式声明唯一 route；
4. 按模型资源规范补齐安全预览图；
5. 校验 profile、policy、recipe JSON，并核对所有 workflow 和资产引用存在。

当前 `anima-base-v1` 与 `anima-aesthetic-v1-1` 只声明生成候选图的 `empty_latent` route。
