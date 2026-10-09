# 领域语境

本文只统一架构讨论和代码中的领域名称。当前实现与已经确认但尚未完成的目标能力，仍以
[开发架构](docs/dev/architecture.md)为准。

## 浏览器工作台

- **显式事实保存（explicit fact save）**：页面内容、页面 Prompt、嵌字、角色 profile、角色 visual
  和角色 Prompt 分别维护草稿，只有用户点击对应保存按钮时才写入。保存请求携带目标文件内容
  指纹；冲突时保留草稿并要求重新读取，不自动保存或覆盖。
- **项目请求保护（project request guard）**：`app/src/project-request-guard.ts` 为项目切换和载入
  请求保存 generation，拒绝旧项目的迟到响应。工作台状态组合位于 `app/src/App.tsx`，事实 HTTP
  入口位于 `app/src/project-workbench-client.ts`。
- **任务状态入口（runtime task status）**：根组件统一串行轮询本机任务状态，`app/src/RuntimeStatusBar.tsx` 消费状态并提供页面入口；当前页媒体使用独立版本刷新，不用全量 workbench 代替媒体查询。

## 项目操作领域

- **项目操作执行（project operation execution）**：本地 Node.js 服务对单一项目执行一致性事实
  读取、项目事实写入、事实派生操作和本机派生变更的统一 Module。它在 Interface 后隐藏 revision、
  项目 mutation lock、项目移动保护和写入后的状态计算，不负责领域事实校验。
  当前实现位于 `app/server/project-operations.mjs`；剧情事实、渲染与媒体路由均接入。LoRA 训练由独立 `TrainingOperations` 和 ETag / If-Match 保护。
- **项目凭据（project credential）**：执行项目事实写入或事实派生操作时使用的浏览器
  `expected revision`；原始 HTTP request 不进入项目操作 Interface。
- **项目事实写入（fact mutation）**：直接修改项目事实或持久输入的操作，必须校验 expected
  revision，成功后通过响应头返回写后 revision。
- **事实派生操作（fact derivation）**：`deriveFromFacts` 读取当前项目事实建立派生物，校验 expected revision，但自身可以不改变 revision；普通候选生成经 `mutateDerived` 读取提交时最新事实并冻结任务，不要求项目 revision。LoRA run 使用训练项目 ETag。
- **本机派生变更（derived mutation）**：只修改已经冻结或可重建的本机任务、媒体和缓存状态的
  操作。它使用项目 mutation lock 和移动保护，但不校验项目凭据，也不改变
  项目 revision；可以在锁内读取事实做完整性校验或冻结生成任务，但不写入创作事实。训练素材、Caption 和设置属于独立训练事实；正式 LoRA 记录可由仓库、本机或唯一所属项目持有，权重始终在外部模型目录。

## 生成配置领域

> 状态：最终格式的 `render_profile`、独立 recipe、显式 operation route、
> workflow manifest、项目稀疏调整、请求级完整 Effective Render Plan、冻结渲染任务契约和 task-only
> 执行器已经实现。扩散／视频生成路径只保留候选；成品制作和导出另走显式输出入口。

- **生成配置（`render_profile`）**：一套可复用的生成选择入口。它直接保存精确模型身份，
  并组合全局 Prompt、生成配方、工作流和 LoRA；它不保存项目页面事实。
- **全局 Prompt（`prompt.text`）**：生成配置保存的一段全局文字，编译时放在各设定文字之前。
  项目调整通过 `prompt.text` 语义目标整段替换；进入最终 Prompt 的文字必须显式存在于配置或
  项目事实中，不能藏在代码前缀里。
- **生成配方（render recipe）**：可复用的采样与尺寸参数，包括 steps、CFG、sampler、scheduler、
  CLIP skip、画面比例尺寸和需要时的二次采样参数；它不选择模型或工作流。
- **有效配方实例（effective recipe instance）**：某条 route 应用项目稀疏调整后的实际配方参数。
  它保留来源 recipe ID，并以有效参数的 canonical SHA-256 区分同源但参数不同的路线；任务注册表
  按实例身份冻结，不能按来源 ID 折叠。
- **工作流清单（workflow manifest）**：与 ComfyUI API JSON 配套的语义说明，声明结构家族、
  operation、输入来源、LoRA modifier、固定字段绑定和动态接入点。节点绑定只属于工作流清单。
- **operation**：用户明确发起的生成动作，当前固定为生成候选（candidates）。
- **输入来源（input source）**：operation 读取 latent 或图片的方式：`empty_latent`（空白画布）、`reference_image`（页面有序参考图；H3 使用单图输入）。route 不存在即该能力不存在。
- **画面修饰（modifier）**：在基础工作流上按清单声明接入的确定性变换。画面修饰不能自行
  改选工作流；Qwen 候选工作流声明 `lora.model_only`，按配置加载模型 LoRA。
- **项目生成配置调整（project render-profile override）**：项目针对所选基础生成配置保存的
  稀疏修改。每项同时记录稳定语义目标、原值和项目值，不保存基础配置全量副本。
- **有效生成配置（effective render profile）**：解析生成配置所引用的配方和工作流后，
  再应用项目稀疏调整得到的完整配置。它是派生结果，不另存为项目事实。
- **渲染计划（render plan）**：一次生成请求的完整、已校验、可冻结执行说明。它包含有效生成配置、
  operation、输入来源、Prompt、seed、精确模型、工作流、LoRA 和输入文件及其身份。
- **冻结渲染任务契约（frozen render task contract）**：对 version 2 完整渲染任务执行一次性的契约
  校验与执行投影。它集中检查 effective profile 来源身份、Prompt 可重审计证据、route 与 registry、
  execution unit 及其输入输出映射；执行器只消费通过该契约的冻结任务，不重新选择生成路径。
