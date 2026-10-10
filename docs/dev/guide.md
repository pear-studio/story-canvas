# 开发指南

通用规则见 [AGENTS](../../AGENTS.md)。先读[架构](architecture.md)，按改动范围查专项文档。

## 开发与验证

Node 版本以 `.node-version` 和 `app/package.json` 为准；依赖安装、环境配置见[环境搭建](../reference/setup.md)。

```powershell
npm --prefix C:/Workspace/story-canvas/app ci
npm --prefix C:/Workspace/story-canvas/app run dev
npm --prefix C:/Workspace/story-canvas/app run check
npm --prefix C:/Workspace/story-canvas/app test
```

`dev` 由同一个 Node 服务提供 API 与 Vite 中间件，后端源码变化触发重启。
生产运行使用 `build` 后的 `start`，不监视源码；修改后重新构建并重启。

验证入口：

| 改动 | 相关检查 |
|---|---|
| 服务端领域契约 | `app/tests/` 对应测试；用绝对路径调用 `node --test` |
| Prompt、继承、页面编辑 | `test:prompt-ui`、`test:anima-ui` |
| 导航、浮层、选择控件 | `test:navigation-ui`、`test:floating-ui`、`test:selection-ui` |
| 对比、训练、成品 | `test:comparison-ui`、`test:lora-ui`、`test:finished-ui` |
| 项目格式 | `validate:project -- --project <登记的项目绝对路径>` |

以上脚本均用 `npm --prefix C:/Workspace/story-canvas/app run <脚本>` 调用。
完整 `test` 已包含类型检查和构建。浏览器测试使用隔离测试页面；Windows 默认 Edge，
其他环境需可用的 Playwright Chromium，`BROWSER_CHANNEL` 可指定浏览器。

## 修改入口

- 项目事实与 Agent 操作：[项目文件](../reference/project-files.md)、[Agent 接口](../reference/agent-interfaces.md)。
- 页面输入与模型语义：[Prompt](../reference/prompt.md)；备用生成路线见 [Qwen](../reference/qwen.md)。
- 生成配置、工作流与冻结任务：[渲染计划](render-plan.md)。
- 全局对比工具：[对比工具](comparison-experiment.md)。
- 训练入口与当前支持情况：[LoRA 训练](../reference/lora-training.md)。

数据契约以 `library/schemas/`、模型原生契约和接口帮助为准。格式变化时同步修改当前创建器、
读写入口、编译器、受管项目与相关测试；不要增加读取时的隐式迁移。

## 前端约束

- 页面保存走领域客户端；模型编辑器接收草稿与 `onChange`，不直接写项目文件。
- `App.tsx` 接纳导航与工作台快照；新请求使用现有身份和写入代次保护，旧响应不能覆盖新保存。
- 本机健康、任务轮询由根组件协调；当前页媒体独立刷新，不用全量工作台刷新代替。
- 浮层复用 `floating-layer.ts`、`useFloatingLayer`、`FloatingPanel`；提示复用 `useTooltips`。
  不靠增加 `z-index` 或放开正文溢出处理遮挡；验证屏幕边缘、滚动、弹窗和 Escape。
