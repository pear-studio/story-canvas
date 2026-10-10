# 架构与生成实现

本文维护组件、并发和生成资产边界；开发取舍与验证见[开发指南](guide.md)。操作参数查工具 help，项目目录见[项目事实](../reference/project-files.md)。

## 组件与数据流

| 组件 | 职责 |
|---|---|
| 外部 Agent | 讨论、语义编辑、调用工具、判断成果 |
| React `app/src/` | 导航、显式草稿保存、媒体和全局工具 |
| Node `app/server/` | 事实校验与保存、确定性编译、资源、任务和媒体 |
| 模型适配器 | 原生输入、编译及专用编辑器 |
| ComfyUI | 消费实例化工作流，生成图片／视频 |
| 训练模块 | 素材与设置、冻结计划、子进程及训练媒体 |

单个 Node 服务持有事实写入；开发挂 Vite 中间件，生产提供 dist。HTTP Adapter 只解析并调用领域入口。

```text
项目事实 + 可复用配置 → 编译与冻结 → 队列 → ComfyUI → 候选 → 显式成品
```

页面由完整 PageKey 定位，归属和顺序由 index 管理；content、各模型 Prompt 和 render 独立保存。适配器只消费活动模型；内容描述不隐式写入 Prompt。

## 并发与独立工具

`project-operations.mjs` 统一剧情项目 mutation lock、revision 和移动保护，不在领域内部另建事实锁。

| 入口 | 条件 |
|---|---|
| `readFacts` | 一致性读取，期间变化有界重读 |
| `mutateTargetFacts` | 校验目标及必要依赖指纹 |
| `mutateFacts / deriveFromFacts` | 校验 expected revision |
| `mutateDerived` | 持锁但不要求或改变事实 revision；提交时冻结最新事实 |
| `copyProject / renameProject` | 校验源 revision，并协调生命周期 |

revision 是实时磁盘事实签名，不写项目 JSON；媒体和缓存不推进它，通知缓存不替代提交检查。浏览器只接纳当前项目及写入代次的快照，媒体独立刷新。

训练通过 TrainingOperations 和 ETag 协调，模块组合 facts、plan、runtime、media，不使用剧情锁／revision。对比工具独立冻结输入和成果，共用生成队列，不写来源页面；成品入口消费明确候选，不增加最终图扩散操作。

## 生成资产与冻结

| 资产 | 维护内容 |
|---|---|
| `library/render-profiles/` | 模型身份、模型 Prompt 配置、LoRA、operation 和输入 route |
| `library/render-recipes/` | 采样与画幅 |
| workflow API 模板及 manifest | 可执行节点、operation、输入、modifier 和节点绑定 |
| 项目 override | 稀疏稳定 target、基础值和项目值 |
| 页面 render | 独立模型、profile、画幅，创建后不继承默认变更 |

字段以 Schema 和资产为准。profile 直接组合、不使用 extends；绑定只在 manifest；route 必须显式声明。modifier 只变换已选 workflow，语义 ID 冲突报错。override 不存全量副本，保留基础值判断冲突。

`page-render-resolver.mjs` 读取最新事实，模型与 `render-profile-compiler.mjs` 编译；`render-task-contract.mjs` 冻结配置、来源、文件、Prompt、LoRA、seed、route 和执行单元。入队前实例化 workflow 及输入输出映射，`render-project-runtime.mjs` 只消费 task ID 对应快照，恢复不重读当前页面或配置。

契约错误、输入身份变化或启用资源缺失阻止执行，不静默跳过或换路线；恢复失败进入明确终态。候选由 `render-media.mjs` descriptor 定义身份与映射，并验证成果完整性。

## 模型接入

服务端注册在 `model-adapters.mjs`，原生实现位于 `models/<model>/`；`model-prompts.mjs / prompt-scope.mjs` 管容器及范围保存。前端注册在 `app/src/models/registry.tsx`，编辑器只修改宿主草稿。

新增模型沿现有注册路径，不另建插件加载器；修改 workflow／recipe 同步 Schema、引用、编译和冻结测试。参考图、LoRA 或采样变化须核验真实冻结工作流及输出映射。模型专有知识见[Qwen](../reference/qwen.md)，字段语义查 prompt 操作 topics。
