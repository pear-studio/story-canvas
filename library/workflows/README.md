# ComfyUI 工作流

这里保存经过审核的 ComfyUI API JSON 工作流。每份 `<id>.api.json` 必须配套
`<id>.manifest.json`；manifest 是结构家族、operation、输入来源、modifier 和节点绑定的唯一
事实来源，生成配置不复制节点绑定。工作流文件体积小并进入 Git；模型权重和 ComfyUI 安装属于
仓库外运行依赖。

`anima-candidate-page.api.json` 使用核心 `UNETLoader`、`CLIPLoader` 和
`VAELoader` 分别加载 Anima DiT、Qwen3 文本编码器和 Qwen Image VAE，只服务生成候选图。
工作流只使用 ComfyUI 核心节点。提交前由生成脚本替换 Anima 的三份模型，再统一替换提示词、尺寸、种子、采样参数和
CLIP skip。生成脚本还会按页面先串联风格 LoRA、再串联出场角色 LoRA，并把最终 model
和 CLIP 输出重新连接到文本编码与采样节点；零个、一个或多个 LoRA 不需要在工作流文件
中保留无效占位节点。
