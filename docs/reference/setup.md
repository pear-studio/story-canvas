# 环境搭建

StoryCanvas 的代码、故事项目和本机生成环境彼此独立。两台设备可以使用不同的
ComfyUI 安装、版本和模型集合；项目只要求当前选择的生成配置在执行设备上可用。

## 初始化应用

```powershell
npm --prefix <仓库根>/app ci
npm --prefix <仓库根>/app run setup
```

`setup` 创建工作区、应用日志与状态目录、本地词库、LoRA 训练器目录和独立 LoRA 资源记录目录，
并在缺失时从示例生成 `Config/local.json`。

## 本机配置

```json
{
  "port": 3000,
  "workspace_dir": "workspace",
  "comfyui_urls": [],
  "comfy_cli": "C:/Users/<用户名>/.local/bin/comfy.exe",
  "comfyui_root": "D:/Tools/ComfyUI-workspace",
  "comfy_install_source": "",
  "models_root": "D:/Models/ComfyUI",
  "civitai_api_key": "",
  "lora_training": {
    "diffsynth": {
      "trainer_root": "../story-canvas-trainer/DiffSynth-Studio",
      "python": "../story-canvas-trainer/DiffSynth-Studio/.venv/Scripts/python.exe"
    },
    "quality": {
      "python": "app/data.local/material-tools/.venv/Scripts/python.exe"
    },
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
        "CUDAExecutionProvider"
      ],
      "timeout_ms": 600000
    }
  },
  "prompt_dictionary": {
    "preset": "a1111-tagcomplete",
    "tags_file": "app/data.local/prompt-dictionaries/danbooru.csv",
    "translations_file": "app/data.local/prompt-dictionaries/zh.csv"
  },
  "prompt_rewrite": {
    "model": "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
    "system_prompt": "C:/Workspace/Qwen-Image-2.1/prompt_rewrite/prompts/system_prompt_t2i.txt"
  }
}
```

- `comfyui_urls`：仅填写当前设备自己的直连地址；没有本机 ComfyUI 时保持空数组。跨设备地址与优先级统一保存在进入 Git 的 `app/comfyui-endpoints.json`；
- `comfy_cli`：当前设备的 comfy-cli 可执行文件，缺失时不能启停或维护 ComfyUI；
- `comfyui_root`：comfy-cli 管理的 ComfyUI workspace；
- `comfy_install_source`：可选的 HTTPS Git 镜像地址或本地 Git 仓库路径，只在安装时作为
  `comfy install --url` 的来源；留空时使用 comfy-cli 默认上游；
- `models_root`：包含 `checkpoints/`、`loras/` 等子目录的模型根目录；
- `civitai_api_key`：可选的 Civitai API Key，供 Agent 认证下载模型或调用 Civitai API；
- `lora_training.diffsynth.trainer_root` 与 `lora_training.diffsynth.python`：固定 commit 的
  DiffSynth-Studio 源码目录和其独立 Python；缺省时按同级默认路径
  `../story-canvas-trainer/DiffSynth-Studio` 解析；
- `lora_training.quality.python`：指向共享的素材处理环境 `app/data.local/material-tools/.venv/Scripts/python.exe`，与打标、抠图共用，和训练环境分离；依赖由下述 uv 清单管理。优先使用 CUDA，无 CUDA 时使用 CPU。权重清单在 `library/lora-training/quality/musiq.json`，文件放在 `models_root/quality_assessment/musiq_koniq_ckpt-e95806b9.pth`，大小约 104 MiB；工作台校验 SHA-256，不自动下载。代码与清单进入 Git，Python 环境和权重不进入 Git。缺少配置时暂停图片自动准备；检查显示路径与权重已配置不代表 Python 依赖已经通过实际运行验证；
- `lora_training.captioning`：可选的 LoRA 数据集基础 Prompt 打标器配置；当前提交的
  `animetimm-eva02-db4-full` 适配器使用素材处理环境的 `onnxruntime-gpu` 和 `CUDAExecutionProvider`，具体版本见 `app/python/materials.lock`，
  不支持 CPU-only ONNX Runtime，使用本机 ONNX 权重、标签和阈值文件，权重目录不进入 Git；
- `prompt_rewrite`：可选的单页最终 Prompt 重写配置。`model` 是 ComfyUI `text_encoders` 目录中 PE-T2I INT8 权重的文件名，`system_prompt` 是 Qwen-Image-2.1 原版 t2i 系统提示词；复用本机 `comfyui_url`。ComfyUI 需提供 `CLIPLoader`、`TextGenerate` 和 `SaveText` 节点。缺少配置或 ComfyUI 未运行时仍可编辑并使用原始 Prompt，但无法运行重写。此功能不向重写器发送参考图片，暂不支持 edit 路线；建议画幅只展示，不改变项目画幅。
- 图片后处理模型不由 `setup` 自动下载。清单位于
  `library/lora-training/upscalers/real-esrgan-x4plus-anime-6b.json`，首版权重应位于
  `models_root/upscale_models/RealESRGAN_x4plus_anime_6B.pth`，工作台和 `doctor`
  会提前检查文件大小与 SHA-256；`setup` 只提示清单位置，不读取大模型。缺失时只显示可选能力警告并禁用超分，不影响裁剪、训练环境
  诊断或普通项目编辑；用户通知 Agent 后按模型下载规则处理，不提供应用内安装器；
- 路径可以是绝对路径，也可以相对仓库根目录；
- 这些路径只存在于被忽略的本地配置，不创建 `Saved/comfyui` 或 `Saved/models` 链接。

`civitai_api_key` 只保存在 `Config/local.json`。Agent 可以按需读取，但不得在回答、
日志、命令行参数或可提交文件中回显；密钥泄漏后应立即在 Civitai 撤销并轮换。

`Saved/` 只保存 StoryCanvas 自己的日志和状态。不要将外部 ComfyUI 或模型目录放进
仓库，也不要让清理命令递归进入外部目录。

## 模型目录规范

以下是正式目录规范，不是设备上的临时约定。所有供工作台使用的正式权重及必需配套文件统一安装在外部 `models_root`，由 ComfyUI、训练器和素材处理工具按需共用；目录名字含 ComfyUI 不表示只能供 ComfyUI 使用。

| 相对 `models_root` 的目录 | 内容 |
|---|---|
| `checkpoints/` | 完整生成模型 checkpoint |
| `diffusion_models/` | 分体 diffusion / DiT 权重，如 Qwen-Image-2.1 |
| `text_encoders/`、`vae/` | 文本编码器与 VAE |
| `clip_vision/`、`controlnet/`、`embeddings/` | 视觉编码器、控制模型与嵌入 |
| `loras/` | LoRA；未登记训练权重放 `loras/training/<task-id>/<run-id>/` |
| `upscale_models/` | 超分权重；素材准备使用 Real-ESRGAN Anime 6B，成品超分使用 AnimeSharp V4 2× |
| `quality_assessment/` | 图像质量评分权重，如 MUSIQ |
| `background-removal/` | 抠图权重，如 IS-Net |
| `captioning/<captioner-id>/` | 打标权重及对应标签、阈值、预处理等配套文件 |

打标器的 `model.onnx`、`selected_tags.csv`、`thresholds.csv`、`preprocess.json` 和 `categories.json` 作为同一模型包保存，不能混用不同版本。当前 ID 为 `animetimm-eva02-db4-full`，文件身份以 `library/lora-training/captioners/animetimm-eva02-db4-full.json` 为准。

环境诊断默认从 `models_root/captioning/<captioner-id>/` 校验模型包，不再回退到工具目录。若显式填写 `lora_training.captioning.model_root`，它必须与命令 `args` 中实际使用的模型包目录一致，并遵循上述分类规范。

- 工具 Git 只保存模型清单、来源、SHA-256、配置示例和受管安全预览。权重不进入工具或项目 Git，也不放在 `app/data.local/`、Python 环境、项目 `captioning/` 或 `Saved/` 中。项目 `captioning/` 保存的是审核事实，不是打标模型。
- 设备实际路径只写入 `Config/local.json` 及外部 ComfyUI 自己的路径配置。上方 JSON 是示例，使用时把 `D:/Models/ComfyUI` 替换为实际 `models_root`。打标命令的 `args` 当前不展开 `${models_root}`，应填写实际绝对文件路径。
- ComfyUI 通过 `extra_model_paths.yaml` 映射所需分类；不能因根目录已配置，就假定所有分类都已映射。MUSIQ、IS-Net 和打标器直接读取模型库，不要求 ComfyUI 注册这些分类。
- Hugging Face、Torch 等下载缓存不作为正式权重的唯一安装位置。需要的 tokenizer 等辅助缓存可保留或重新获取，但不与已登记模型包混为一谈；新增下载按清单校验后安装到上述分类。
- 迁移采用“复制、核对大小和 SHA-256、更新配置、验证加载、清理原安装文件”的顺序；不创建工具目录到模型库的链接。修改打标命令路径后，在相关任务空闲时重启工作台，避免服务继续使用启动时读取的旧配置。
- 备份模型库与 `Config/`；重建 Python 环境只安装依赖，不复制或重新下载已有正式权重。

## Python 环境维护（uv）

本机保留三套功能环境：ComfyUI 生成、DiffSynth 训练、素材处理（MUSIQ、打标、抠图）。所有安装、依赖检查和同步使用 uv；不通过 `.pth`、`PYTHONPATH` 或复制 `site-packages` 借用另一套环境。comfy-cli 作为 `uv tool` 管理的命令工具，继续是 ComfyUI 启停入口，不与模型依赖混装。

| 用途 | Python | 环境位置 | 依赖清单 |
|---|---|---|---|
| ComfyUI 生成 | 3.13.12 | 已配置 ComfyUI workspace 的 `.venv` | `app/python/comfyui.lock` |
| DiffSynth 训练 | 3.11.14 | `../story-canvas-trainer/DiffSynth-Studio/.venv` | `app/python/diffsynth.lock` |
| 评分、打标、抠图 | 3.11.14 | `app/data.local/material-tools/.venv` | `app/python/materials.lock` |

先安装 uv 并确认 `uv --version` 可用；本轮维护使用 uv 0.10.7。实际外部路径只写入被忽略的 `Config/local.json`，表中仓库内路径是默认布局。

`app/python/diffsynth.lock` 和 `comfyui.lock` 是当前 Windows 可用环境的精确包版本快照，素材依赖由 `materials.in` 解析为 `materials.lock`。训练器源码版本由 `library/lora-training/diffsynth.json` 固定 commit 管理；ComfyUI 源码仍由 comfy-cli 管理。这些锁文件不承诺 Linux 或其他 Python 版本可直接使用。升级时显式更新对应锁文件并验证功能，不在日常启动时自动升级或同步。

在仓库根目录运行，先确认相关训练、生成和图片处理任务已结束：

```powershell
uv python install 3.11.14 3.13.12
uv tool install comfy-cli==1.16.0 --python 3.13.12
# 将 uv tool dir --bin 返回目录中的 comfy.exe 写入本机 comfy_cli。
uv venv --python 3.11.14 app/data.local/material-tools/.venv
uv pip sync --python app/data.local/material-tools/.venv/Scripts/python.exe app/python/materials.lock --extra-index-url https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match
uv pip check --python app/data.local/material-tools/.venv/Scripts/python.exe
```

已有环境不重复执行 `uv venv`。训练环境沿用清单规定的源码与 Python，使用 `uv pip sync --python <训练Python> app/python/diffsynth.lock --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match`，然后执行 `uv pip install --python <训练Python> --no-deps -e <训练器目录>`。锁文件不绑定 editable 源码路径；实际路径读取 `Config/local.json`。ComfyUI 使用 `uv pip sync --python <ComfyUI的Python> app/python/comfyui.lock --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match`。同步是精确匹配，会移除清单外的包；安装自定义节点或改变依赖前应先更新相应清单，不能用旧锁覆盖新增功能。

新建训练环境时先按 `library/lora-training/diffsynth.json` 取得固定 commit 的 DiffSynth-Studio 源码
（Git 检出或核对该清单 `source_archive` 的 SHA-256 后解压），再运行
`uv venv --python 3.11.14 ../story-canvas-trainer/DiffSynth-Studio/.venv` 和上述同步命令；复现命令见
[Qwen 训练环境](../dev/qwen-image-lora.md)。ComfyUI 源码安装与 workspace 选择仍走 comfy-cli；需要重建 Python 环境时在已核对的 workspace 下用 `uv venv --python 3.13.12 <ComfyUI目录>/.venv`，再同步对应清单。配置完 Python 路径后重启工作台，使评分和打标读取新配置。

调整素材依赖时运行 `uv pip compile app/python/materials.in --python-version 3.11 --python-platform windows --index-strategy unsafe-best-match --output-file app/python/materials.lock`。验证包括 MUSIQ 实际评分、CUDA 打标、抠图以及 `uv pip check`。训练和生成还需分别验证训练器入口与 ComfyUI 健康接口。环境和模型保留在本机，不提交 Git。

Windows 的 uv 默认从全局缓存硬链接安装，同一文件系统上的相同 wheel 可以共享磁盘数据；不同 Python ABI、Torch/CUDA 构建不能保证复用。保持缓存和环境在同一文件系统，不使用 symlink 模式，也不要手工改包文件。

### 素材抠图

`app/scripts/material-cutout.py` 使用本地 IS-Net 和 CPU ONNX Runtime，生成独立透明 PNG；不覆盖原图、不自动下载、不自动导入数据集。模型放在 `models_root/background-removal/isnet-general-use.onnx`，来源和 SHA256 见 `library/material-tools/isnet-general-use.json`。

```powershell
uv run --no-project --python app/data.local/material-tools/.venv/Scripts/python.exe app/scripts/material-cutout.py --input <原图> --output Saved/Agent/<任务名>/cutout.png
```

仅在用户委托包含抠图时使用，不能作为全部训练素材的默认处理。检查透明边缘、头发、饰品和手指后，再通过工作台决定是否导入；抠图不属于搜寻阶段的原图收集步骤。

## 远程候选生成

Linux 可以只运行工作台，把普通页面与角色候选图提交给同一 Tailnet 内的 Windows ComfyUI。
两端使用同一份仓库和生成配置，但 `Config/local.json` 各自独立。

Windows 生成端保留上面的完整本机配置，首次以管理员身份运行：

```bat
配置远程生成[Tailscale][管理员].bat
```

该脚本只读取 `config.local.json` 中的本机直连端口，将 `127.0.0.1:<端口>` 发布为 Tailnet 内统一的 `:8188`，
不启动 ComfyUI。Serve 后台配置会保留，重启后随 Tailscale 恢复；只有首次配置、本机端口变化或映射被移除时才需要运行。
Windows 如需在用户尚未登录时保持 Tailscale 在线，应启用 Tailscale 的 Run unattended。

日常以普通权限运行：

```bat
启动ComfyUI.bat
```

它通过与工作台按钮相同的 comfy-cli 控制器启动或复用本机 ComfyUI，不修改 Serve 映射。
已运行且身份、健康检查通过时直接报告已运行，不重启、不打断生成；未运行时才启动。
两个脚本都会显示执行结果并暂停，启动成功后关闭窗口不会停止后台 ComfyUI。脚本不负责安装或下载，
要求 Node.js、依赖、本机配置以及各自所需的 ComfyUI 或 Tailscale 已准备好。
ComfyUI 的回环监听与 Serve 的 Tailnet 监听可以使用相同端口；身份检查区分监听地址，并保留对全地址监听的占用检查。

跨设备 ComfyUI 地址按优先级保存在仓库的 `app/comfyui-endpoints.json`，由 Git 同步。例如：

```json
[
  "http://desktop-home.tail6c2b26.ts.net:8188",
  "http://gih-d-27166.tail6c2b26.ts.net:8188"
]
```

每台生成设备仍在自己的 `Config/local.json` 中填写本机直连地址。工作台发现共享地址指向当前主机时，
不会经 Tailscale 检测自己，而是在同一优先级位置使用该设备的本机直连地址；没有本机 ComfyUI 的 Linux
工作台将 `comfyui_urls` 保持为空即可。

工作台启动时并行检测解析后的全部地址，默认使用列表中第一个在线实例。环境面板会并列显示本机和远程实例，
可以选择任一在线地址；设备变化后点击“刷新”重新检测。刷新会保留仍然在线的当前选择，不会后台自动切换。
选择只影响之后启动的任务，已经进入调度器的任务继续使用原地址。

完成 `npm --prefix <仓库根>/app ci` 后运行：

```bash
bash ./start-remote-workbench.sh
# 开发时改用：
bash ./start-remote-workbench-dev.sh
```

两个脚本都把工作台的 `3000` 端口发布到 Tailnet，并自动停止本仓库旧工作台后重新启动。
`start-remote-workbench.sh` 每次先构建当前前端，再运行非 dev 服务；运行期间修改代码不会自动重启。
`start-remote-workbench-dev.sh` 运行 dev 服务，`app/server/` 与 `app/shared/` 源码变化后自动重启（监听范围不含 `node_modules/` 与仓库 `Saved/`，避免缓存与实例记录写入触发重启循环），前端由 Vite 更新。
启动时的最新状态指本地代码，不自动拉取 Git；构建失败会报错退出。生成完成后，Linux 会从 Windows ComfyUI
下载 PNG，候选仍保存在发起任务的 Linux 项目 `Outputs/` 中；`Outputs/` 与 `Saved/`
不由 Git 同步。

Windows 需要从手机或其他 Tailnet 设备访问当前开发版时，首次以管理员身份运行：

```bat
配置工作台访问[Tailscale][管理员].bat
```

该脚本读取本机配置中的工作台端口（默认 `3000`），通过 `tailscale serve --bg` 发布对应的
`http://127.0.0.1:<端口>`，不启动工作台；配置完成后显示 Tailnet 内的 HTTPS 地址并暂停。
本机端口变化或映射被移除时再运行一次。后台 Serve 配置会在工作台停止后保留。

日常只需以普通权限运行 `启动工作台.bat`（dev 模式）或 `启动工作台-prod.bat`（production 模式），本机浏览器和手机使用同一个工作台实例，
不再需要单独的 Tailscale 启动入口。`start-workbench.bat` 自动停止本仓库已登记的旧工作台及其 dev 监听进程，
再按所选模式启动服务；窗口持续显示日志，关闭窗口会停止该工作台。服务退出后显示退出码并暂停。

首次升级到支持实例登记的版本时，先手动关闭旧工作台及其 dev 监听进程或启动窗口，再使用新脚本。
旧版本没有实例登记，不做自动识别；此后由新入口启动的实例支持自动替换。Windows 和 Linux 均如此。

所有正式启动入口按仓库限制为一个事实写入服务，网页与多个 Agent 都连接该服务。
`启动工作台-prod.bat` 复用 `start-workbench.bat production`：先构建前端，成功后替换本仓库的旧实例并以 production 模式启动，不启用代码热重载。构建失败会保留错误窗口，且不会停止原工作台。训练期间保持启动窗口开启；切换模式或重复启动会中断现有工作台任务，应在任务空闲时操作。

直接执行 `npm run dev`、`npm run start` 或服务入口时，重复实例会被拒绝；使用以上启动脚本才会替换旧实例。
替换先请求正常关闭，超时后终止已核对 PID 与启动身份的旧进程，不按端口或进程名批量杀进程。
即使存在活动任务也不询问：LoRA 训练可能中断，生成任务按现有队列恢复机制处理，不保证无缝继续。

需要查看当前地址或判断哪个服务没启动时，运行 `检查服务.bat`。它只读取本机工作台健康接口、
本机 ComfyUI 的 `/system_stats`、Tailscale 连接状态与 Serve 映射，显示访问地址后暂停；
不启停服务、不改映射、不扫描远程 ComfyUI，也不替代从手机进行的跨设备连通性检查。

远程模式信任仓库登记的模型与 LoRA 身份，不在 Linux 校验 Windows 文件或 SHA-256。远端缺少
模型、自定义节点或工作流不兼容时，ComfyUI 会在提交时直接报错；用户在 Windows 补齐后重试即可。
当前远程路径只用于普通页面和角色候选生成。对比实验、LoRA 训练和超分仍必须在配置完整本机
生成环境的 Windows 上运行。

### LoRA 打标器 GPU 运行时

当前 AnimeTimm 打标器只支持 GPU 运行，使用上述素材处理环境。通过锁文件同步 GPU 发行包，
不要另装 CPU-only 的 `onnxruntime`，也不要再安装到训练环境：

```powershell
$materialPython = "app/data.local/material-tools/.venv/Scripts/python.exe"
uv pip sync --python $materialPython app/python/materials.lock --extra-index-url https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match
uv pip check --python $materialPython
```

完成后，`onnxruntime.get_available_providers()` 必须包含 `CUDAExecutionProvider`；工作台环境诊断
还会核对清单文件、Provider 配置和打标器的 `--check` 结果。不要把 `CPUExecutionProvider` 作为
配置中的显式执行路径。GPU 发行包内部可能仍列出 CPU Provider，这是 ONNX Runtime 为少量 shape
算子保留的会话 fallback，不代表允许使用 CPU-only 运行时。

## 生成配置与模型

生成配置位于 `library/render-profiles/`。每个配置直接声明所需模型：

- `relative_path` 相对于 `models_root`；
- SHA-256 必填；
- 来源 URL 可以缺失；
- 文件缺失或校验不符时配置不可用，不静默使用同名文件。

模型与 LoRA 身份在项目和任务中统一使用正斜杠相对路径。提交工作流时，运行时读取目标 ComfyUI
实例的 LoRA 节点枚举，以忽略斜杠方向的方式匹配路径，再使用该实例返回的实际名称；不根据 Node
所在系统猜测远程 ComfyUI 的路径格式，也不把反斜杠写回项目事实。

配置还声明 `architecture_family`，支持能力由 `operations` 下存在的 input route 明确表达，不再
保存重复的 `capabilities`。当前生成侧唯一结构家族是 Qwen-Image-2.1，分别加载 `diffusion_models`、
`text_encoders` 与 `vae` 中的精确模型。当前 `qwen-image-2-1` 配置声明
文生图（`empty_latent`）与参考图（`reference_image`）两条候选 route；未声明的操作或输入会收到明确错误。

工作台的“资源 → 基模”和“资源 → LoRA”会合并 `library/resources/catalog.json` 中的人工登记项、
`library/resources/loras/` 中公开 LoRA 的完整记录、`app/data.local/lora-resources/` 中本机正式
LoRA 记录，再补充 `models_root` 标准子目录中发现的本机文件和训练 checkpoint。基模页把主模型与
文本编码器、VAE 等配套组件分开显示；LoRA 页把正式资源与未登记本机文件分开显示。模型结构家族由 Agent 入库时
显式填写，不自动识别；未登记文件可以正常保留和使用，训练目录内的权重明确显示为 checkpoint。公开 LoRA
记录和本地 LoRA 记录都是浏览信息来源，生成配置和项目仍保存用于复现的精确文件名与 SHA。

公开 LoRA 的 `resource.json`、来源信息和预览图属于仓库资源，可以进入 Git；权重仍属于当前设备，
不进入 Git。本机正式 LoRA 的记录和图片保存在 `app/data.local/lora-resources/`，也不进入 Git；
未登记训练 checkpoint 只保存在 `models_root/loras/training/`。
迁移任一 LoRA 时，都要同时复制对应记录目录和记录中 `file.relative_path` 指向的权重；每份记录都
包含自己的完整信息，不要求目标设备已有其他 LoRA 记录。SafeTensors 内嵌元数据仅作备份，不能替代
`resource.json`。

当前生成链只依赖 profile 中声明的基础模型、Prompt、LoRA、route 和 recipe，以及页面事实。

模型下载前检查来源、文件名、预计大小、磁盘空间和校验值。先写入 `.partial`，校验后
再改为正式文件名，不覆盖同名不同模型。

## ComfyUI 生命周期

本机生成环境要求配置 `comfy_cli`；`comfyui_root` 是 comfy-cli workspace，`app/comfyui-endpoints.json` 是由 Git 同步的跨设备地址优先级，
`config.local.json` 的 `comfyui_urls` 只保存当前设备自己的直连地址。共享地址命中当前主机名时会被本机直连地址替代，不重复检测自己的 Tailscale 入口。
只有同时配置 `comfy_cli` 和 `comfyui_root` 的本机实例由工作台管理生命周期。工作台性能面板只对该实例提供
显式启动和关闭；服务不会在日常启动时
自动安装、更新或运行 `doctor`。需要安装或更新时由用户或 Agent 显式调用 API：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/comfyui/install -Method Post -ContentType 'application/json' -Body '{"device":"nvidia"}'
Invoke-RestMethod http://127.0.0.1:3000/api/comfyui/update -Method Post
```

首次安装必须在请求体显式指定 `device`：`nvidia`、`amd`、`m-series` 或 `cpu`；
工作台不会在非交互请求中猜测设备，也不会固定 comfy-cli 或 ComfyUI 版本。安装调用
`comfy --json --workspace <comfyui_root> install [--restore] --skip-manager [--url <source>] --<device>`，
不默认引入 Manager。workspace 不存在时执行首次安装；已有完整 ComfyUI 仓库时使用 `--restore`
补齐虚拟环境和依赖；无法识别的半成品目录会保留现场并明确报错，不会自动删除或覆盖。
启动调用 `comfy --json --workspace <comfyui_root> launch --background`，并显式
传递 `--disable-auto-launch`、监听地址和端口；Windows 子进程只临时扩展 comfy-cli 所在目录的
`PATH`，不会污染工作台进程。生成任务仍直接通过 ComfyUI HTTP/WebSocket 执行，不经过 comfy-cli。

启动前会验证配置、comfy-cli 可执行性、目标 workspace，并用监听端口、命令行和 `/system_stats`
确认 ComfyUI 身份。安装和更新由 ComfyUI 控制器自身串行，并要求目标 workspace 的 ComfyUI
未运行；不会检查或阻止其他 GPU 工作。安装成功但 CLI 没有 envelope 时会再验证目标 workspace
才报告成功。安装单独允许最长 90 分钟，更新允许
最长 30 分钟；失败会按源码取得、Python 虚拟环境、PyTorch 或普通 Python 依赖标记阶段，并保留
CLI 输出。超时只报告终止请求，后置状态未知，需要人工检查。关闭前会确认
ComfyUI 自身队列为空，先用全局 `stop --dry-run` 核对 comfy-cli 的背景记录，再用指定端口的
`stop --port <port> --dry-run` 核对实际监听 PID 与 workspace，并通过二次读取的父进程链确认两者
属于同一次启动，之后才调用绑定同一端口的 `comfy stop --port <port>`；即使外部命令在两次检查后
改写全局 background 记录，最终停止目标也不会随之改变。不只信任 PID，也不按进程名批量终止。
所有地址显示在线或离线状态及 `/system_stats` 返回的版本，远程实例不能由工作台启停，也不显示远端 GPU 或进程信息。
服务启动和用户点击“刷新”时才并行检测全部地址，常规状态轮询只读取最近结果；用户可以在环境面板选择任一在线实例。

comfy-cli 的后台 PID 在进程异常退出后可能被 Windows 复用，导致空闲端口仍被误报为
`server_already_running`。工作台只在目标端口已经确认没有监听、CLI 的全局记录与当前主机／端口一致，
并且记录 PID 不属于当前 workspace 的 ComfyUI 启动进程时，原子移除这一条陈旧记录并重试启动一次；
日志指针和其他 CLI 设置保留。该恢复不会调用全局 `comfy stop`，因此不会按复用后的 PID 结束无关进程。

跨设备网络不稳定时，优先把可访问的 HTTPS Git 镜像或事先准备的本地 ComfyUI Git 仓库写入该
设备自己的 `comfy_install_source`。工作台调用 comfy-cli 时会继承当前服务进程的代理以及
`PIP_*`、`UV_*` 环境变量，因此 Git、PyTorch wheel 源和 PyPI 可以分别使用设备已有的网络配置。
`comfy_install_source` 只替换 ComfyUI 源码来源，不会替换 PyTorch 或 Python 包下载源；如果失败
阶段是 `torch` 或 `requirements`，应调整对应代理／包源后再次调用安装，完整仓库会自动走
`--restore`。工作台不进行无限自动重试，也不会把 `doctor` 变成日常启动门禁。

## Prompt 词库

首版兼容 A1111 Tag Autocomplete：

```text
<name>,<type>,<postCount>,"<aliases>"
<English tag/alias>,<Translation>
```

仓库固定快照位于 `library/prompt-dictionaries/`，默认直接用于编辑候选、确定性审计和生成
门禁，并在清单中记录来源、日期与 SHA-256。`config.local.json` 可以显式指定本机 CSV
覆盖路径；覆盖文件缺失时不会静默回退仓库快照，环境诊断会给出警告，工作台仍可编辑
草稿，但正式生成会因无法完成词库审计而阻断。

## 可选 LoRA 训练环境

LoRA 训练使用独立 Python，不复用 ComfyUI Python，也不增加第二个本地服务。唯一训练路线是
Qwen-Image-2.1：训练器源码为固定 commit 的 DiffSynth-Studio，与虚拟环境放在工具仓库外、同级的
`story-canvas-trainer/DiffSynth-Studio/`；设备实际路径只保存在 `Config/local.json` 的
`lora_training.diffsynth.trainer_root` 与 `lora_training.diffsynth.python`。默认本机目录为：

```text
../story-canvas-trainer/DiffSynth-Studio/
└─ .venv/
```

- 固定源码身份、commit 与官方源码归档 SHA-256 位于 `library/lora-training/diffsynth.json`；
  依赖快照为 `app/python/diffsynth.lock`；DiffSynth 自身按上述固定源码以 `--no-deps -e` 安装，
  不包含在锁文件中。安装与复现命令见 [Qwen 训练环境](../dev/qwen-image-lora.md)；
- 训练使用官方原始 BF16 权重：DiT、文本编码器、VAE 与 processor/tokenizer 配套文件按
  [模型目录规范](#模型目录规范) 放入 `models_root`；逐文件相对路径、大小、SHA-256 与下载来源
  （Hugging Face `Qwen/Qwen-Image-2.1`）以 `library/lora-training/qwen-image21-models.json` 为准，
  预检逐文件校验；Comfy INT8 权重不能当作训练权重；
- 训练循环由仓库内 runner `app/python/qwen-image21-lora-runner.py` 执行，分缓存与训练两个独立
  子进程；不要把示例脚本下载的 `models/` 留在训练器目录。

普通 `setup` 不下载或更新训练器。用户请求后由 Agent 使用 `comfyui-runtime` 和
`lora-training` 技能显式安装、校验或修复；工作台只诊断和安全执行。

环境或模型缺失只禁用 LoRA 开始，不影响普通项目编辑和生成。
旧 sd-scripts 环境（同级的 `story-canvas-trainer/sd-scripts/`）不再被工作台使用，保留备查，不删除。
训练、普通生成、对比实验和 ComfyUI 超分之间不建立全局 GPU 准入；用户自行决定是否并发，显存不足
时由对应运行任务报告失败。空闲但占用显存的 ComfyUI 可由用户在性能面板关闭。

开发设备需要复核训练 HTTP 边界时，可以运行隔离目录冒烟（不创建故事项目、不启动 GPU 训练）：

```powershell
npm --prefix <仓库根>/app run smoke:lora
```

## 诊断

```powershell
npm --prefix <仓库根>/app run doctor
```

必需项失败时命令返回非零；ComfyUI 路径、模型目录、显式配置的词库覆盖和可选 LoRA 训练环境
缺失属于警告。LoRA
诊断会核对 DiffSynth 固定 commit（无 git 历史的 zipball 安装按 `diffsynth.json` 的 `identity_files`
关键文件内容指纹核对）、Python、Torch、CUDA/BF16 能力、依赖锁、仓库内 runner 与模型清单
逐文件 SHA-256。
工作台还会按
项目默认生成配置列出每个模型的文件、SHA-256、来源和本机状态。

## 成品超分与嵌字

成品使用 `models_root/upscale_models/2x-AnimeSharpV4_RCAN.safetensors`，模型来源和 SHA 在
`library/resources/catalog.json` 的 `animesharp-v4-2x` 中登记；下载大小 31,053,198 字节，来源页面标注许可 CC-BY-NC-SA-4.0。
模型缺失由 Agent 安装，工作台不提供安装器。嵌字在 Windows 使用已安装的 Edge，其他系统需
`npm --prefix <仓库根>/app exec -- playwright install chromium`。具体功能见 [成品输出](../dev/finished-pages.md)。

成品超分支持当前选中的远程 ComfyUI，通过 HTTP 上传与下载；权重必须安装在生成端。
工作台无需本机权重。嵌字仍由工作台服务运行，生成图片和制作记录保存在工作台的项目目录中，
ZIP 下载到正在访问网页的设备。此能力不改变 LoRA 素材超分的本机限制。
