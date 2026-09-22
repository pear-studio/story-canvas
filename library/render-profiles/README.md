# 生成配置

`render_profile` 是模型、全局 Prompt 文字、生成参数、workflow 和风格 LoRA 的组合入口。
模型与 LoRA 使用稳定语义 ID 的对象映射；operation 和输入来源使用固定 route，不再保存
重复的能力布尔值，也不通过数组下标定位可调整项。

当前剧情生成只有 `qwen-image-2-1` 一个 profile，使用 Qwen-Image-2.1 自由文本整段 Prompt。
每个 profile 直接声明 `dit`、`text_encoder`、`vae` 三份模型、`prompt.text` 全局文字、候选 route
和候选 recipe；编译器、Render Plan 与任务快照都只面对同一份 `operations`。

`prompt.text` 是拼在各设定之前的全局基础 Prompt，项目可以通过 render-profile override 的
`prompt.text` target 整段替换或清空；清空时编译直接省略这段文字。

新增或修改生成配置时：

1. 在 `library/resources/catalog.json` 登记模型精确身份，并在 profile 中引用相同路径与 SHA-256；
2. 复用或新增 `library/render-recipes/` 中的稳定资产；
3. 为每个实际支持的 operation/input source 显式声明唯一 route；
4. 按模型资源规范补齐安全预览图；
5. 校验 profile、recipe JSON，并核对所有 workflow 和资产引用存在。

`qwen-image-2-1` 为候选图声明 `empty_latent` 与 `reference_image` 两条 route。
