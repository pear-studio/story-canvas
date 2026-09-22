# ComfyUI 工作流

这里保存经过审核的 ComfyUI API JSON 工作流。每份 `<id>.api.json` 必须配套
`<id>.manifest.json`；manifest 是结构家族、operation、输入来源、modifier 和节点绑定的唯一
事实来源，生成配置不复制节点绑定。工作流文件体积小并进入 Git；模型权重和 ComfyUI 安装属于
仓库外运行依赖。

`qwen-image-2-1-text.api.json` 服务无参考图候选（empty_latent），
`qwen-image-2-1-reference.api.json` 服务带参考图候选（reference_image），使用
`TextEncodeQwenImage21` 接收最终整段提示词与有序参考图。提交前由生成脚本写入模型、提示词、
尺寸、种子和采样参数；负向槽保持空字符串。多参考图按冻结顺序连接 `images.image_N`。
