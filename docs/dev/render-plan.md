# 生成配置与冻结执行

本文维护当前配置资产、模型接入和执行契约。页面操作见 [Agent 接口](../reference/agent-interfaces.md)，
模型文字语义见 [Prompt](../reference/prompt.md)，Qwen 专用说明见 [Qwen](../reference/qwen.md)。

## 资产归属

| 资产 | 维护事实 |
|---|---|
| `library/render-profiles/` | 精确模型身份、模型专用 Prompt 配置、LoRA 与 operation/input source route |
| `library/render-recipes/` | 采样和画幅参数，不选择模型或工作流 |
| `library/workflows/*.api.json` | 可执行 ComfyUI API 模板 |
| 同名 `*.manifest.json` | 架构、operation、输入来源、modifier 与节点绑定 |
| 项目生成配置调整 | 一层稀疏 override：稳定语义 target、基础值与项目值 |
| 页面 render 设置 | 页面独立模型、profile 与画幅；创建时取项目默认，之后独立 |

字段和可用值以 `library/schemas/` 及当前资产 JSON 为准，不在文档复制完整样例。
模型与 LoRA 的来源和身份登记见[资源目录](../../library/resources/README.md)。

profile 直接组合资产，不使用 `extends`。绑定只放 workflow manifest；加载时验证节点路径存在。
route 明确选择 operation 和输入来源，未声明 route 的输入不能生成。
modifier 只在已选工作流上接入确定性变换，不另选工作流。
语义 ID 冲突直接报错，不靠数组顺序覆盖。
override 按稳定 target 定位，保留基础值用于冲突判断；编译有效配置，不持久化全量副本。

## 编译与执行

1. `page-render-resolver.mjs` 按完整 `PageKey` 读取提交时的页面、引用、Prompt 和配置。
2. 模型适配器编译输入；`render-profile-compiler.mjs` 解析资产并应用 override。
3. `render-task-contract.mjs` 冻结有效配置、来源身份、输入文件、Prompt、LoRA、seed、route 与执行单元。
4. `page-render.mjs` 原子建立 queued 任务并进入队列。
5. `render-project-runtime.mjs` 只按 task ID 消费已验证快照，执行预检、提交和收集成果。

最终 ComfyUI workflow 和输入输出映射在入队前实例化；执行和恢复不重新读取页面、profile、recipe 或 override。
契约错误、输入身份变化或缺少启用资源会阻止执行，不静默跳过或替换生成路线。
队列恢复失败必须进入明确终态，避免留下永久排队任务。

候选输出由 `render-media.mjs` 的 descriptor 统一定义文件身份和映射；运行时验证路径及成果完整性。
页面内容编辑不会改写既有冻结任务。成品制作通过独立入口进行，不增加“最终图”扩散 operation。
对比工具有自己的冻结执行计划和输出，见[对比工具](comparison-experiment.md)。

## 模型接入

当前适配器显式注册 Anima、Qwen 与 H3；公共层处理页面、保存、队列和候选，模型层持有原生输入与编译。

- 服务端注册：`app/server/model-adapters.mjs`；原生实现：`app/server/models/<model>/`。
- 模型容器与范围保存：`model-prompts.mjs`、`prompt-scope.mjs`。
- 前端注册：`app/src/models/registry.tsx`；编辑器只修改宿主草稿。
- 工作流及配方修改：同步 Schema、资产引用、编译和冻结测试。

新增模型沿现有注册路径接入；当前没有外部插件加载器。旧项目恢复工具不属于日常读写或新模型接入流程。
涉及参考图、LoRA 或采样变化时，验证实际冻结工作流和输出映射，而非只验证配置能解析。
