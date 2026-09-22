# 开发文档导航

开发者先阅读 [开发入口](guide.md) 和 [架构](architecture.md)。两者分别维护当前代码入口、验证
方式，以及已经实现的系统边界；不要用讨论稿或一次性交接页替代当前事实。

## 当前实现

| 文档 | 作用 |
|---|---|
| [开发入口](guide.md) | 代码位置、常用搜索、验证命令和改动联动范围 |
| [架构](architecture.md) | 当前组件职责、API、数据边界与明确非目标 |
| [Prompt 编写与审计](../reference/prompt.md) | 自由文本整段契约、override 语义、编译与图片编号、审计和单页 Agent 上下文 |

当前实现以架构、Schema、代码和测试为准。稳定的用户与 Agent 操作边界放在创作和运行文档，
不保留已经完成的一次性设计稿或开发汇报。

## 当前已实现契约

- [成品输出](finished-pages.md)：选定候选超分、嵌字、当前成品记录、替换与系列 ZIP 导出。

- [Agent 直接操作工作台](../reference/agent-interfaces.md)：在线命令、stdin 与 read/save、现有 HTTP 能力与返回契约。

- [项目操作执行](project-operations.md)：已实现。所有项目路由共享
  `readFacts`、`mutateFacts`、`deriveFromFacts`、`mutateDerived`、`copyProject` 和 `renameProject` 的
  执行边界；文档说明项目级 mutation lock、revision、媒体边界与生命周期 Interface 的稳定语义。

- [渲染计划目标契约](render-plan.md)：生成配置拆分、项目稀疏调整、统一编译 seam 与冻结任务
  契约已实现；文档以当前 Schema、代码和测试为准。
- [对比实验](comparison-experiment.md)：全局独立对比实验的轴、笛卡尔 cell、manifest 身份、
  执行前整体预检、执行计划冻结、持久化、API、工作台和串行执行已实现。
- [剧情事实读写](story-facts.md)：outline 局部/整体、索引、narrative/Prompt 的统一 read/save 和内容指纹冲突。
- [角色事实读写](character-facts.md)：profile、visual、Prompt 分权编辑及角色创建、删除归档的本机 CLI。
- [角色视觉页与文字样式窄写入](character-page-facts.md)：角色视觉页 index/goal/Prompt 分权、模板一次性复制、页面归档和字段级颜色命令；工作台通过当前窄接口编辑 goal、Prompt 和文字样式。
- [页面渲染与候选删除](page-render.md)：从当前页面事实编译候选、返回完整候选路径，并提供单候选删除命令。
- [项目工作台](project-workbench.md)：普通项目入口使用原工作台布局编辑页面内容、Prompt 和嵌字布局，并生成、预览和删除候选。
- [新建项目](project-creation.md)：通过 runtime 临时文件建立干净项目，不复制其他项目的页面、Prompt 或派生物。
- [领域语境](../../CONTEXT.md)：统一生成配置、配方、工作流清单、画面修饰、有效配置和渲染计划
  等架构名称。

## 创作与运行文档

- [任务入口](../start-here.md)：按用户目标选择文档和 Agent 技能；
- [创作指南](../creative/guide.md)：故事、分页、视觉制作与复盘的统一创作入口；
- [视觉页面参考](../reference/visual-pages.md)：页面事实、候选和嵌字机制；
- [Prompt 编写与审计](../reference/prompt.md)：所有生成 Prompt 的统一编写、审计和编译边界；
- [LoRA 训练](../reference/lora-training.md)：训练任务、协作权限、结果保存和文件边界；
- [项目文件](../reference/project-files.md)：项目事实、任务和媒体契约；
- [环境搭建](../reference/setup.md)：Node.js、ComfyUI、模型和本机配置；
- [Agent 配置管理](../agent/README.md)：规则、技能和投影同步。

项目注册与磁盘边界见[本地项目管理](../reference/local-projects.md)。
