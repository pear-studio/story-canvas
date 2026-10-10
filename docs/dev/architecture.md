# 架构

本文维护当前组件职责和并发边界。通用规则见 [AGENTS](../../AGENTS.md)。

## 组件

| 组件 | 职责 |
|---|---|
| 外部 Agent | 讨论、语义编辑、调用工具与判断生成结果 |
| React 工作台 `app/src/` | 项目导航、显式草稿保存、候选与成品查看、全局工具 |
| Node 服务 `app/server/` | 项目操作、确定性编译、资源查询、任务调度和媒体访问 |
| 模型适配器 | 模型原生输入、编译与专用编辑器 |
| ComfyUI | 消费已实例化工作流，执行图片和视频生成 |
| 训练模块 | 训练事实、计划冻结、子进程运行与训练媒体 |

只有一个本地 Node 服务。前端开发由 Vite 中间件接入，生产提供 `app/dist/`。
HTTP Adapter 解析请求并调用领域入口；领域模块持有事实校验和保存语义。

## 数据流

```text
项目事实 + 可复用配置
          ↓ 领域读取、模型编译
      冻结任务 → 队列 → ComfyUI → 候选 → 显式成品制作
```

项目事实、可复用资源和可清理派生物的目录及 Git 归属只在[项目文件](../reference/project-files.md)
和[资源目录](../../library/resources/README.md)维护。
页面以完整 `PageKey` 定位，剧情、角色、场景共用编辑和候选工作区；页序由 index 派生。
内容、Prompt 与 render 设置分开保存；模型容器允许保留不同模型输入，适配器只消费当前模型。
生成冻结机制见[渲染计划](render-plan.md)，模型写法见 [Prompt](../reference/prompt.md)。

## 项目操作

`project-operations.mjs` 统一项目 mutation lock、revision 与移动保护；
路由明确选择操作语义，不在领域内部另建事实锁。

| 操作 | 并发条件 |
|---|---|
| `readFacts` | 一致性读取；读取期间变化时有界重读 |
| `mutateTargetFacts` | 领域入口校验目标及必要依赖指纹，不因无关事实变化拒绝 |
| `mutateFacts`、`deriveFromFacts` | 校验 expected revision |
| `mutateDerived` | 使用项目锁，不要求或改变事实 revision；候选提交在此读取最新事实并冻结 |
| `copyProject`、`renameProject` | 校验源 revision，另有生命周期协调 |

revision 是磁盘事实签名，不写入项目 JSON。HTTP 在响应头返回 revision，目标内容指纹由领域回执返回。
文件通知缓存仅优化浏览器查询，提交仍核对实时事实；媒体、队列和缓存变化不推进事实 revision。
浏览器只接纳当前项目及写入代次的快照，媒体有独立版本。调用规范见 [Agent 接口](../reference/agent-interfaces.md)。

## 独立工具

- [对比工具](comparison-experiment.md)持有独立冻结输入，共用生成队列，不写项目页面或候选。
- LoRA 训练项目通过 `TrainingOperations` 和 ETag / If-Match 协调，不使用剧情 revision。
  `lora-training-module.mjs` 对外组合 `facts`、`plan`、`runtime`、`media` 和启动协调；
  运行时消费冻结 manifest，续训建立新 run，不接管旧进程。
  当前支持情况见[训练指南](../reference/lora-training.md)，不在架构文档维护训练路线。
- 成品制作消费明确选定的候选；图片嵌字与视频导出使用不同输出路径，详见[页面指南](../reference/visual-pages.md)。

当前实现和操作入口分别以领域模块、Schema 与工具帮助为准。开发命令见[开发指南](guide.md)。
