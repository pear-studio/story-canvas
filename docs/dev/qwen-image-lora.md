# Qwen-Image-2.1 训练环境

独立 DiffSynth-Studio 环境已完成本机 100 步短程训练验证，尚未接入 StoryCanvas 训练调度。
真实训练须取得用户授权；本次短训和产物验证已获授权。当前工作台训练入口仍使用原有训练器。

## 安装位置与版本

- 源码安装在工具仓库外，与剧情项目目录平级的 `story-canvas-trainer/DiffSynth-Studio/`，虚拟环境位于其下 `.venv/`。
- 设备实际路径记录在 `Config/local.json` 的 `lora_training.diffsynth.trainer_root` 和 `python`；当前仅用于独立环境管理，工作台训练调度尚未消费这两个字段。原有 `trainer_root` 与 `python` 仍属于旧训练器。
- 固定源码身份：`library/lora-training/diffsynth.json`。网络无法进行 Git fetch 时，可使用该提交的官方源码归档，核对归档 SHA-256；不要把空 Git 目录当作成功检出的版本。
- 依赖使用独立环境，不修改 ComfyUI 或原有训练器。NVIDIA 环境采用清单中的 CUDA PyTorch 版本。
- 完整依赖快照为 `app/python/diffsynth.lock`；DiffSynth 自身从上述固定源码安装，不包含在锁文件中。
- 模型权重及 processor 等必需配套文件仍放外部 `models_root`，按 `docs/reference/setup.md` 分类。不要让示例脚本在训练器目录默认下载 `models/`。
- 安装日志、探针和源码下载中转位于 `Saved/Agent/qwen-lora-research/`，可清理，不作为正式训练依赖。

源码准备完成后，可按以下方式复现依赖（只安装，不启动训练）：

```powershell
$trainerSettings = (Get-Content Config/local.json -Raw | ConvertFrom-Json).lora_training.diffsynth
uv venv --python 3.11.14 (Join-Path $trainerSettings.trainer_root '.venv')
uv pip sync --python $trainerSettings.python app/python/diffsynth.lock --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match
uv pip install --python $trainerSettings.python --no-deps -e $trainerSettings.trainer_root
```

## 验证边界

依赖检查、Qwen 2.1 模块导入、GPU BF16 运算、Flex Attention 前向／反向和训练入口已验证。
仅通过导入或 `--help` 不能证明可训练：本次真实加载时发现并修复了以下两个问题，均发生在首次优化器更新前。

- 必须像官方示例一样显式传入 `--lora_target_modules ""`，自动选择目标层；省略会采用通用入口的其他架构层名并失败。
- Windows 环境需安装匹配 PyTorch 的 `triton-windows`；本机 PyTorch 2.13 使用 `3.7.1.post27`，已加入依赖快照。版本关系依据 [Triton Windows 发布说明](https://github.com/triton-lang/triton-windows/releases/tag/v3.7.0-windows.post26)。

DiffSynth 的专用示例使用官方原始权重，以 BF16 加载训练。本机生成侧的 Comfy INT8 权重不能直接视为训练权重。
原始模型及配套文件的来源、固定提交、大小与 SHA-256 见 `library/lora-training/qwen-image21-models.json`。
模型仍分类保存在外部 `models_root`；原始分片仅用于训练，没有改动现有生成配置。

## 2026-09-21 本机短训

RTX 4090 24GB、64GB 内存、Windows，使用洛克茜数据集的 10 张冻结副本和单独核对的自然语言描述。
原数据集 Caption 和训练设置未修改。试验归档位于该登记训练项目的
`Training/qwen-image21-validation/20260921-short-01/`，包括输入、参数、原始采样数据、检查点身份、验证图片与报告。
权重位于 `models_root/loras/training/qwen-image21-validation/20260921-short-01/`，没有自动固化为正式 LoRA。

- 分两阶段运行官方 `sft:data_process` 和 `sft:train`：先加载文本编码器与 VAE 缓存，再单独加载 DiT 训练。
- 最大 1MP、实际 0.52～1.05MP，batch 1，rank／alpha 16，重复 10 次共 100 步，梯度检查点开启；无 CPU offload、无量化训练。
- AdamW、名义学习率 `1e-4`，沿用上游 ConstantLR 默认行为：前 5 步为 `3.333e-5`，之后 `1e-4`；没有梯度裁剪。
- 缓存阶段含加载 84.0 秒；训练阶段含加载 260.4 秒。第 6～100 步平均 2.37 秒、中位 2.62 秒、P95 2.94 秒。
- 训练 PyTorch 峰值 allocated 15.70GiB、reserved 17.11GiB；这与包含桌面等占用的整卡显存指标不同，完整监控见归档。
- 第 50、100 步各保存约 84MB 权重；448 个张量均为有限值，224 组目标层形状匹配原始模型，全部 B 矩阵有非零更新。
- 现有 Comfy INT8 管线直接加载两份权重完成 15 张对照图，无未加载 LoRA 键警告；仅 LoRA 稳态约 6.5 秒／张，单参考图约 10.5 秒／张，LoRA 本身未显示明显速度负担。
- 50 步已改变发型、服装倾向；100 步部分脸部细节恶化。单参考图身份还原更明显，叠加 LoRA 的额外收益尚不清晰。完整图片及逐条件性能见上述归档的 `report.md` 和 `validation/comparison.jpg`。

这是训练及产物兼容性验证，不能据此认定 100 步已达到正式角色质量，或直接外推更高分辨率、多参考图训练的性能。

## 全 BF16 推理复验

同日按用户质量优先要求补做 21 张全 BF16 对照，归档在上述 run 的 `bf16-validation-01/`。
使用 Comfy-Org BF16 主模型与 Qwen3-VL 编码器、BF16 VAE，复现原五组条件，并比较官方指南的身份引用／重新构图写法。
新增两份模型从原始分片无损整理，完整 SHA 与官方单文件完全一致，来源已登记资源目录。

- ComfyUI 默认可能将 BF16 编码器转为 FP16。此次显式使用 `--bf16-text-enc --bf16-vae --disable-dynamic-vram`，日志确认实际精度；参考图 KV cache 使用默认无损存储，没有进一步量化。
- 初次默认运行配置被中断并单独归档，随后 21 张均成功，无 OOM、无未加载 LoRA 键警告。关闭动态显存属于装卸策略调整，不是降低模型精度；没有做该策略的独立性能消融。
- 832×1248、25 步下，无参考图后续出图约 22～24 秒，单参考图约 27～30 秒；每组释放缓存后的首张约 59～72 秒。整卡显存每 250ms 采样的峰值约 21.89GiB；整机内存峰值约 63.72GiB，已接近 64GB 机器的物理内存上限，不能只看显存判断余量。
- BF16 与 INT8 配对画面总体接近，100 步 LoRA 的悬空耳形细节和脸部重影仍存在，不能把这版权重的问题归咎于 INT8。
- 指南写法在本轮头肩近景用例中生效，保留了参考人物外观；全身用例仍沿用原姿势倾向。改写同时明确景别、省去重复长相描述，属于成套写法比较，不能证明某一个短语独立有效，也不是复杂构图可靠性结论。
- 单张参考图按指南用自然指代；多张才用 `<image1>` 等标签。指南改写组还省去了原触发词，因此不用于孤立评价 LoRA 收益。

这是独立复验配置，现有工作台 INT8 profile 与启动入口没有在试验中改写。复现实验需同时核对冻结工作流和上述启动参数；只选择 BF16 文件不能保证默认编码器运行精度相同。

## 上游依据

- [Qwen 官方列出的 ModelScope 支持](https://github.com/QwenLM/Qwen-Image-2.1#modelscope)
- [DiffSynth Qwen 2.1 文档](https://github.com/modelscope/DiffSynth-Studio/blob/main/docs/zh/Model_Details/Qwen-Image-2.1.md)
- [LoRA 训练示例](https://github.com/modelscope/DiffSynth-Studio/blob/main/examples/qwen_image_21/model_training/lora/Qwen-Image-2.1.sh)

示例约 1MP、rank 32、学习率 `1e-4` 只是起点，不是本机已验证配方。
文档的最低 7GB 显存说明属于推理；本机训练实测仅适用于上面的分阶段条件。
