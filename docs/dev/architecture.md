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

分镜页沿用独立 PageKey 生成单格，目录投影隐藏带 `parent_page_id` 的内部格子。`comic-layout.mjs` 统一切分几何，生成提交据已保存布局冻结单格尺寸；整页成品冻结各格选图、裁切和嵌字后确定性合成。图片按格裁切，文字使用单格相对坐标并允许跨格，字号以画布短边的 1024 单位为基准，竖屏保留原有大小，分镜按整页短边统一；普通预览、全屏、译文检查与成品输出复用同一换算。

分镜工作台的“整页”标签维护合成布局与预览，各分镜标签直接复用普通页面工作区和候选交互；切换时保留草稿，只有当前标签响应快捷键。候选通过“用于整页”明确选图，分镜保存同时提交待保存的整页设置。

页面通过 `use-page-changes` 注册保存入口，切页统一提供保存、放弃或取消；整页布局、隐藏分镜草稿与译文都纳入未保存检测，保存失败不导航。`use-draft-history` 维护当前编辑身份的草稿撤销／重做，连续输入与拖动合并为一步；新增分镜造成的身份变化建立新的历史边界。整页与分镜使用相同的字号换算；布局和嵌字模式切换控件及交互。全屏合成画布复用 `ImageLightbox` 的缩放、拖动、触屏和退出逻辑。

## 并发与独立工具

`project-operations.mjs` 统一剧情项目 mutation lock、revision 和移动保护，不在领域内部另建事实锁。

`fact-storage.mjs` 只依赖 Node 内置模块，提供文件读写、路径检查和候选媒体锁；目标读据检查归 `edit-fingerprint.mjs`。`fact-commit.mjs` 在调用者持有的项目写锁内统一译文裁剪、引用检查、写入回滚及保存后的素材清理。译文文档规则位于 `page-translation-document.mjs`，不依赖译文保存或剧情编辑入口；领域调用者直接导入所需能力。

| 入口 | 条件 |
|---|---|
| `readFacts` | 一致性读取，期间变化有界重读 |
| `mutateTargetFacts` | 校验目标及必要依赖指纹 |
| `mutateFacts / deriveFromFacts` | 校验 expected revision |
| `mutateDerived` | 持锁但不要求或改变事实 revision；提交时冻结最新事实 |
| `copyProject / renameProject` | 校验源 revision，并协调生命周期 |

revision 是实时磁盘事实签名，不写项目 JSON；媒体和缓存不推进它，通知缓存不替代提交检查。浏览器只接纳当前项目及写入代次的快照，媒体独立刷新。

角色／场景的主保存与 Ctrl/Cmd+S 共用 `use-setting-editor`，仅提交当前基础页或子设定的当前模型；参考图先进入草稿。`setting-save.mjs` 在一次项目写锁内校验并提交档案、子设定 ID 连带引用与 Prompt，其他范围草稿保留。独立名称／描述字段可保守合并；同范围 Prompt 或必要基础依赖变化时丢弃过时草稿并提示，不拼接 Prompt、不自动重试写入。

真正的过时读据通过 `fact-conflict.mjs` 标记 `refresh_required`；浏览器据此作废排队的旧写入，普通业务 409 不触发刷新。`page-persistence.mjs` 和 `setting-persistence.mjs` 分别统一网页与 Agent 的归一化／校验；整页提交可以同步清理布局，局部内容提交仍拒绝破坏未授权范围的引用。落盘后的旧素材清理失败不改变保存成功状态；`saved-fact-receipt.mjs` 区分保存后的读取失败，返回 `saved:true` 和重读入口，不要求重复提交。

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
