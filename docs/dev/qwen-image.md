# Qwen-Image-2.1 接入

生成设置可选择 `qwen-image-2-1`，保留 Anima 配置供已有项目使用。默认约 1MP、25 步、
Euler / simple、CFG 1；沿用原有候选任务、逐张队列、种子、输出与历史记录。

## 页面输入

页面 Prompt 可选 `reference_image`，值为项目 `materials/` 中一个 PNG、JPEG 或 WebP 文件名。
剧情、角色和场景页面共用“参考图”选择器，支持缩略图、导入和移除；导入通过既有材料接口，
页面保存通过既有事实接口。未选择图片走文生图路由，选择后走单参考图路由。
输出尺寸始终取项目画布配方，参考图尺寸不改变画布。

结构化 Prompt、角色/场景继承、机位和自定义模式继续沿用。Qwen 的 `positive_avoid` 策略
把有效负向文本追加为正向末尾的 `AVOID: ...`，传给节点的负向输入为空。负向片段仍保留原始
来源与审计记录；流程预览中的最终文本包含转换结果。这只是自然语言提示，不等同于 CFG 负向引导。

首版不支持 Qwen LoRA、Anima 两步深度控制，以及把带参考图页面导入对比实验；这些情况明确报错。
已有 Anima LoRA 不会在切换模型后被静默忽略或套到 Qwen。

## 冻结与目录

- 正式权重及配套文件位于外部 `models_root/diffusion_models/`、`text_encoders/`、`vae/`；
  模型精确文件名、大小、SHA-256 与来源在 `library/render-profiles/qwen-image-2-1.json`。
- Prompt 策略、配方和两个工作流分别位于 `library/prompt-policies/`、`render-recipes/`、`workflows/`。
- 原始参考图是项目材料。创建任务时读取一次，按 EXIF 转正、最长边限制 1536 并转成 PNG；
  源文件与标准化图片分别记录 SHA-256，图片原子写入任务目录 `inputs/<sha256>.png`。
- 运行时只读取冻结图片并复核 SHA-256，通过 HTTP 上传至执行端 ComfyUI 的
  `input/StoryCanvas/references/<sha256>.png`；同一任务只上传一次。本机和远程共用此路线。
- 任务归档时图片随任务进入历史目录；候选仍存于项目 `Outputs/pages/`。临时脚本与检查结果位于根
  `Saved/Agent/qwen-integration/`，不作为正式生成依赖。

## 官方基础与验证

以 [官方文生图模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_t2i.json)
和 [官方参考图模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_image_edit.json)
为基础，使用 `TextEncodeQwenImage21`，参考图路由保留 `QwenImage21Cache`。工作台冻结自己的 API JSON，
无需用户编辑 ComfyUI 图。模型来自 [Comfy-Org 发布目录](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/main)。

2026-09-21 在 ComfyUI 0.37.0、RTX 4090 24GB 上通过正式工作台接口生成两页各三张：
文生图整组约 20 秒，单参考图整组约 28 秒（含队列、上传、下载和落盘；不能视作其他设备的保证）。
六张均为 832×1248。参考图组保持了发型、头饰和服装大体特征，小配件不保证精确复现。

自动化覆盖 AVOID 的任务冻结与复验、参考图路由、排队后材料替换、损坏检测、不支持配置阻断，
以及浏览器中的选择、保存和移除；Anima 使用原有回归测试。
