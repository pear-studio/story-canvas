# LoRA 自动打标器

本目录登记可复现的自动打标器身份和输入输出语义，不存放模型权重。本机权重放在
`models_root/captioning/<captioner-id>/`，并按清单中的文件大小和 SHA-256
核验；权重和 `Config/local.json` 都不进入 Git。

统一位置与迁移要求见[模型目录规范](../../../docs/reference/setup.md#模型目录规范)。下方命令参数中的 `D:/Models/ComfyUI` 是示例模型根目录，必须替换为本机 `models_root`；命令参数不会自动展开配置变量。不要把权重安装回 `app/data.local/` 或 Python 环境。

## AnimeTimm EVA02 dbv4-full

`animetimm-eva02-db4-full.json` 固定了已验证的模型 revision、文件身份、预处理、类别阈值与
Prompt 排序。官方 Hugging Face 仓库可能要求用户先取得访问权限；可以从其他来源取得文件，
但只有清单中的 SHA-256 全部匹配时才视为同一模型。

适配器入口为 `app/scripts/lora-caption-anime-eva02.py`。它从 `LORA_CAPTION_INPUT` 指向的
version 1 JSON 读取图片清单，并只向标准输出写入 Captioning 协议 JSON。标准错误用于诊断，
非零退出码表示本次运行失败。

## 自动结果与训练 Caption 的边界

自动打标结果是逐图复核的起点，不是最终训练文本：

- `raw_tags` 保留标签、类别、分数和阈值，供审查错误标签、漏标签和阈值偏差；
- 输出中的 `prompt` 是本次运行生成的只读基础 Prompt；
- 图片旁的同名 `.txt` 才是当前实际训练 Caption，允许用户删除固定身份特征、补充逐图变化因素
  或修正模型家族格式。

角色 LoRA 至少要复核四件事：标签是否真的出现在图片中；稳定身份是否被重复绑定；服装、姿势、
表情、镜头和背景是否按图片变化；Caption 是否和目标底模的标签／自然语言约定一致。不要用标签数量
代替复核质量。

本机配置示意如下；相对路径按仓库根解析，权重文件仍保存在被忽略的本机目录：

```json
{
  "lora_training": {
    "captioning": {
      "id": "animetimm-eva02-db4-full",
      "version": "dbv4-full@onnx-a9c51fd22bca",
      "command": "app/data.local/material-tools/.venv/Scripts/python.exe",
      "args": [
        "app/scripts/lora-caption-anime-eva02.py",
        "--model",
        "D:/Models/ComfyUI/captioning/animetimm-eva02-db4-full/model.onnx",
        "--labels",
        "D:/Models/ComfyUI/captioning/animetimm-eva02-db4-full/selected_tags.csv",
        "--thresholds",
        "D:/Models/ComfyUI/captioning/animetimm-eva02-db4-full/thresholds.csv",
        "--batch-size",
        "4",
        "--providers",
        "CUDAExecutionProvider",
        "--intra-op-threads",
        "1",
        "--inter-op-threads",
        "1"
      ],
      "timeout_ms": 600000
    }
  }
}
```

AnimeTimm 打标器要求使用 `onnxruntime-gpu==1.21.1`，并将 `CUDAExecutionProvider` 配置为首选
Provider；CPU-only ONNX Runtime 不属于受支持环境，配置也不得显式请求 `CPUExecutionProvider`。
如果 CUDA Provider 不可用，适配器和工作台环境诊断会直接失败，不会静默切换到 CPU-only 执行。
ONNX Runtime GPU 包仍可能为模型中少量 shape 算子保留内部 CPU fallback；这是模型会话的实现细节，
不等于允许使用 CPU-only 运行时。

输出 Prompt 保留下划线，角色标签排在通用标签之前，各类别内按分数降序及标签名排序。
`rating` 标签不进入 Prompt，但会连同类别、分数和实际阈值保存在 `raw_tags` 中，供工作台审查。

这套输出是 Danbooru 标签流程的打标起点；当前 Qwen-Image-2.1 训练原样使用 Caption（标签或自然语言均可），不按模型家族维护不同的 Caption
Profile，也不会自动改写 Caption；具体标签仍由用户或 Agent 在训练前审查。
