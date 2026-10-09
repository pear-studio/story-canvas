# ComfyUI 工作流

这里保存经过审核的 ComfyUI API JSON 工作流。每份 `<id>.api.json` 必须配套
`<id>.manifest.json`；manifest 是结构家族、operation、输入来源、modifier 和节点绑定的唯一
事实来源，生成配置不复制节点绑定。工作流文件体积小并进入 Git；模型权重和 ComfyUI 安装属于
仓库外运行依赖。

`qwen-image-2-1-text.api.json` 服务无参考图候选（empty_latent），
`qwen-image-2-1-reference.api.json` 服务带参考图候选（reference_image），使用
`TextEncodeQwenImage21` 接收最终整段提示词与有序参考图。提交前由生成脚本写入模型、提示词、
尺寸、种子和采样参数；负向槽保持空字符串。多参考图按冻结顺序连接 `images.image_N`。

Anima Basic 的候选工作流由 `anima-candidate-page` API／manifest 配对定义，消费分类词条编译的正负向和 LoRA。
H3 动态页使用 `minimax-h3-i2v`，消费单图、动作文字、时长、循环、质量档与步数；详情见[动态页](../../docs/dev/video-pages.md)。
各模型 LoRA 接入、固定绑定和输出种类以自己的 manifest 为准，不套用 Qwen 的空负向或参考图规则。
