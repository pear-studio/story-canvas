# 环境搭建

本文件负责本机安装、配置和模型目录；运行环境操作使用 `comfyui-runtime`。项目存储见[项目文件](project-files.md)，Qwen 专用安装见[Qwen](qwen.md)。

## 初始化与启动

Node.js 以 `.node-version` 和 `app/package.json` 为准。以下仓库路径按实际 checkout 替换：

```powershell
npm --prefix C:/Workspace/story-canvas/app ci
npm --prefix C:/Workspace/story-canvas/app run setup
```

`setup` 建立运行目录和缺失的 `Config/local.json`，不下载模型或训练器。
Windows 使用根目录 `启动工作台.bat`（开发）或 `启动工作台-prod.bat`（构建后运行）；会替换本仓库已登记实例，先结束活动任务。关闭窗口会停止服务。
Linux 使用 `start-remote-workbench.sh` 或开发入口 `start-remote-workbench-dev.sh`。
工作台只运行一个事实写入服务，网页和 Agent 连接同一实例。

## 本机配置

从 `app/config.local.example.json` 开始配置，实际路径和凭据只写被忽略的 `Config/local.json`。相对路径按工具仓库根解析。

| 配置 | 用途 |
|---|---|
| `comfy_cli/comfyui_root` | comfy-cli 可执行文件及其 workspace；只有此类本机实例可启停 |
| `comfyui_urls` | 当前设备自己的直连地址；无本机 ComfyUI 时留空 |
| `comfy_install_source` | 可选 ComfyUI Git 镜像或本地源码来源，不改变包源 |
| `models_root` | 外部正式模型库 |
| `lora_training.quality.python` | 独立素材处理环境 |
| `lora_training.captioning` | 打标器 `id/version/command/args/timeout_ms` |
| `prompt_dictionary` | 可选词库 CSV 覆盖；缺失不静默回退 |
| `civitai_api_key` | 可选认证密钥，不回显 |

Qwen 的 `lora_training.diffsynth` 和 `prompt_rewrite` 配置归[Qwen](qwen.md)。
跨设备生成地址优先级在 `app/comfyui-endpoints.json`；各设备分别配置直连地址。任务使用提交时选定实例，不随之后切换改变。

## 模型目录规范

正式权重及必需配套文件统一安装到外部 `models_root`：

| 子目录 | 内容 |
|---|---|
| `checkpoints/`、`diffusion_models/` | 完整 checkpoint 或分体主模型 |
| `text_encoders/`、`vae/` | 编码器、VAE 与 processor/tokenizer |
| `clip_vision/`、`controlnet/`、`embeddings/` | 视觉编码器、控制模型、嵌入 |
| `loras/` | LoRA；未登记训练产物位于 `loras/training/<task-id>/<run-id>/` |
| `upscale_models/` | 素材与成品超分模型 |
| `quality_assessment/` | MUSIQ 等评分模型 |
| `background-removal/` | IS-Net 等抠图模型 |
| `captioning/<captioner-id>/` | 同版本打标权重、标签、阈值及预处理文件 |

文件身份、来源和校验值以 `library/resources/catalog.json`、`library/lora-training/` 和 `library/material-tools/` 的清单为准；登记范围见[资源目录](../../library/resources/README.md)。
权重不放工具代码、项目、Python 环境或 `Saved/`；下载缓存不是正式安装位置。
ComfyUI 通过自己的 `extra_model_paths.yaml` 映射所需分类，设置根目录不代表全部已映射。
打标参数不展开 `${models_root}`，填写实际路径；显式 `model_root` 必须与参数使用的模型包一致。
迁移先复制、校验、改配置、验证加载，再清理旧安装；配置变更后在任务空闲时重启工作台。

## Python 与素材工具

ComfyUI、训练器和素材处理使用独立环境，由 `app/python/` 对应锁文件管理。
使用 uv，不通过 `.pth`、`PYTHONPATH` 或复制包目录借用环境。锁文件是受管环境快照，不承诺跨系统直接适用。
comfy-cli 用 `uv tool` 安装，与上述功能环境分开。
`uv pip sync` 会移除清单外的包，新增节点前先核对依赖；升级后同步清单并实际验证功能。
素材环境默认 `app/data.local/material-tools/.venv/`，依赖来源为 `materials.in/materials.lock`：

```powershell
uv pip sync --python <素材Python绝对路径> C:/Workspace/story-canvas/app/python/materials.lock --extra-index-url https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match
uv pip check --python <素材Python绝对路径>
```

MUSIQ、Real-ESRGAN 和 IS-Net 身份分别由 quality、upscalers 与 material-tools 清单维护，缺少可选模型只禁用对应处理。
AnimeTimm 使用 `library/lora-training/captioners/animetimm-eva02-db4-full.json` 的完整模型包和素材环境；要求 CUDA ONNX Runtime，不支持 CPU-only 配置。

### 素材抠图

明确需要时，用 `app/scripts/material-cutout.py` 的 `--input/--output` 生成透明 PNG，输出放任务 `Saved/Agent/`；检查边缘后导入。它不覆盖原图、不自动导入，不作为所有素材默认步骤。

## ComfyUI 与远程访问

安装、更新和诊断通过运行环境技能完成；安装显式选择设备类型，日常启动不自动安装或升级。
Windows `启动ComfyUI.bat` 启动或复用本机实例；远程实例只能连接。
首次 Tailnet 发布使用根目录两个 `配置…[Tailscale][管理员].bat`，只配置 Serve，不启动服务；日常不重复配置。
远端结果下载到发起工作台的项目 `Outputs/`，不由 Git 同步。
素材处理在本机执行，成品超分可用所选远端 ComfyUI。嵌字用工作台本机浏览器：Windows 已安装 Edge，其他系统安装 Playwright Chromium。

## 诊断

```powershell
npm --prefix C:/Workspace/story-canvas/app run doctor
```

`检查服务.bat` 读取工作台、本机 ComfyUI 和 Tailnet 状态。区分源码、依赖、权重和地址问题，不反复重装全部环境。
路径存在或 import 成功不证明实际评分、打标或训练可用；修复后验证对应功能，GPU 训练须在授权范围内进行。
外部模型库、训练器和本机配置独立备份；不对配置指向的外部目录执行未核对递归清理。
