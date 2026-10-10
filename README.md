# StoryCanvas

Agent 操作的本地系列图片视觉化工作台。用户在浏览器查看和调整项目、Prompt、候选、嵌字与成品；Agent 通过语义接口编辑并生成。

DSH 日常使用「StoryCanvas 创作」预设，接入见[集成说明](docs/agent/README.md)。任务规则和按需阅读入口见 [AGENTS.md](AGENTS.md)。

## 启动

Node.js 版本见 [.node-version](.node-version)，使用实际仓库的绝对路径：

```powershell
npm --prefix <仓库根绝对路径>/app ci
npm --prefix <仓库根绝对路径>/app run setup
npm --prefix <仓库根绝对路径>/app run dev
```

默认打开 `http://127.0.0.1:3000`。未连接 ComfyUI 也能编辑和预览；设备、模型与诊断见[环境搭建](docs/reference/setup.md)。

应用代码在 `app/`，可复现资产在 `library/`。本机配置、个人项目、生成媒体和模型权重不随工具仓库分发，存储与备份见[项目事实](docs/reference/project-files.md)。

## 许可

自有代码和说明采用 [MIT](LICENSE)。第三方模型、LoRA、预览、词库和引用素材沿用各自许可；软件许可不授予这些资料的商用或再分发权。
