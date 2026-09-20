---
name: comfyui-runtime
description: 管理 StoryCanvas 使用的本机或远程 ComfyUI、comfy-cli workspace、模型、自定义节点、后台进程和健康状态。用户要求安装、连接、启动、停止、更新或诊断生成环境，或者生成请求因运行时和模型缺失而失败时使用。
---

# ComfyUI 运行环境

先阅读 `docs/reference/setup.md`，再读取目标 `render_profile` 和有关工作流。本机路径只在
`Config/local.json`，`Saved/` 只保存应用日志和状态。

先读取进入 Git 的 `app/comfyui-endpoints.json` 与当前设备 `config.local.json` 中的本机直连
`comfyui_urls`，再按工作台当前选择的地址区分运行方式：

- 共享地址命中当前主机名时由工作台以本机直连地址替代，不检测自己的 Tailscale 入口。
- 本机地址继续执行下方完整检查、启停和维护流程。
- 远程地址只检查 `/system_stats` 和实际生成错误。Windows 生成端首次以管理员运行 `配置远程生成[Tailscale][管理员].bat`，
  日常以普通权限运行 `启动ComfyUI.bat`（或使用工作台启动按钮）；
  Linux 工作台直接使用仓库共享地址并运行 `bash ./start-remote-workbench.sh`，不要求本机模型目录。
- 远程资源只表示可以提交，模型、LoRA 和自定义节点由 Windows ComfyUI 在提交时验证；缺失时报告
  原始错误，让用户在 Windows 补齐后重试。
- 远程只用于普通页面和角色候选生成。对比实验、LoRA 训练和超分仍走 Windows 本机环境。

## 检查顺序

1. 本机模式验证 `comfy_cli`、`comfyui_root`、`models_root` 与 ComfyUI 地址；远程模式只验证地址可达。
2. 读取 `/system_stats` 和队列接口，优先复用已有健康实例。
3. 启停时核对 CLI workspace、主机、端口和进程身份。
4. 对照目标生成配置检查工作流、自定义节点和所需模型。
5. 只报告必要的缺失项，不因为设备路径或版本不同而判定环境不兼容。

日常启动不运行 `doctor`，也不自动安装或更新。只有出现实际环境问题时才显式运行
`npm --prefix <仓库根>/app run doctor`。

## 变更运行环境

- 安装和更新只由用户或 Agent 显式发起；安装通过 comfy-cli 选择设备并跳过 Manager，更新不固定
  comfy-cli 或 ComfyUI 版本。安装失败后先检查 workspace：完整仓库以 `--restore` 恢复，半成品
  保留现场并报告，不自动删除；网络受限时可以在本机配置 `comfy_install_source`。
- 下载模型前核对来源、文件名、空间、预计大小和校验值。
- 使用 `.partial` 临时文件，校验通过后再改名；不静默覆盖同名不同文件。
- 安装或启用自定义节点后记录来源、精确提交版本和状态。
- 生成配置引用的模型发生变化时，直接更新该 `render_profile` 的身份记录。
- 新增模型后按 `library/resources/README.md` 用脚本把安全级预览图和来源写入资源目录；
  `render_profile` 只引用模型精确身份，不拥有预览图。
- 外部安装路径只写入本地配置，不写入可提交文件或目录链接。

## 进程安全

- comfy-cli 是 ComfyUI 生命周期的唯一管理路线；生成仍直接使用 HTTP/WebSocket。
- 启动时显式传 workspace、监听地址、端口和 `--disable-auto-launch`，随后验证健康地址。
- 停止前确认工作台 GPU 活动与 ComfyUI 队列为空，并核对 CLI dry-run 的 workspace、主机、端口
  和 PID；不只信任 PID。
- 不按 `python`、`node` 等宽泛进程名批量终止进程。
- 不递归删除本地配置指向的 ComfyUI、模型或词库目录。
- 发生链接损坏、文件锁定、校验失败或身份不明时停止并报告，不用更强的清理方式重试。

完成后读取健康接口。本机模式报告地址、版本身份、所需模型是否齐备及仍存在的警告；远程模式
报告在线或离线、版本以及提交时返回的实际缺失项。只有发现实际问题时才运行应用 `doctor`。
