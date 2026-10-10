# StoryCanvas

Agent 操作的本地系列图片视觉化工作台。用户在浏览器调整项目、Prompt、候选、嵌字和成品；Agent 通过语义接口编辑并生成。

## 入口

先读 [AGENTS.md](AGENTS.md)，再按任务读取：

| 任务 | 文档／技能 |
|---|---|
| 故事、分页、seq 重组、子设定与文案 | [创作入口](docs/creative/guide.md)，`story-editing` |
| Prompt、插画与动态页生成 | [Prompt](docs/reference/prompt.md)、[页面操作](docs/reference/visual-pages.md)，`prompt-authoring` |
| 素材搜寻与 LoRA 训练 | [素材搜寻](docs/reference/lora-material-sourcing.md)、[训练](docs/reference/lora-training.md)，`lora-material-sourcing` / `lora-training` |
| ComfyUI、模型安装与诊断 | [环境](docs/reference/setup.md)，`comfyui-runtime` |
| 项目、资源与操作契约 | [项目文件](docs/reference/project-files.md)、[资源目录](library/resources/README.md)、[Agent 接口](docs/reference/agent-interfaces.md) |
| 开发 | [开发指南](docs/dev/guide.md)、[架构](docs/dev/architecture.md) |
| Agent 集成 | [集成说明](docs/agent/README.md)，明确要求同步时用 `agent-sync` |

日常插画主线为 Anima Basic，动态页使用 H3；[Qwen](docs/reference/qwen.md) 的文生图和参考图生成保留作备用。LoRA 训练是主线任务，实际已接入能力见训练文档。项目支持临时复制与提升、独立对比、选图超分、嵌字以及成品 ZIP / 离线 HTML 导出。

## 启动

使用克隆位置的绝对路径；Node.js 版本见 [.node-version](.node-version)。

```powershell
npm --prefix <仓库根绝对路径>/app ci
npm --prefix <仓库根绝对路径>/app run setup
npm --prefix <仓库根绝对路径>/app run doctor
npm --prefix <仓库根绝对路径>/app run dev
```

默认打开 `http://127.0.0.1:3000`。未连接 ComfyUI 也能编辑项目和预览 Prompt；生成环境按环境文档配置。

代码在 `app/`，可复现资产在 `library/`；本机配置、个人项目、生成媒体与模型权重不随工具仓库分发。

## 许可

自有代码和说明文档采用 [MIT](LICENSE)。第三方模型、LoRA、预览、词库和引用素材沿用各自许可；软件许可不授予这些资料的商用或再分发权。
