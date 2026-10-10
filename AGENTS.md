# StoryCanvas Agent 规则

本文件只维护跨任务纪律；专项规则按下表读取，不要求通读所有文档。

- 完成当前委托，不自动扩大范围；已授权的普通操作自行完成。用户原文和要求原样留存的材料不得擅改。
- 项目事实可直接读取，不得直接写入；修改使用 `story_canvas` 语义接口。只读必要范围，未变内容不重复读；任务状态和 Agent 判断不冒充项目事实。
- 不自动记录经验，不创建临时经验文档；具体经验经用户确认才能写入通用文档。
- 不猜本机路径、不回显凭据；不递归清理配置指向的外部目录，不使用 `git clean -fdx`。读取忽略目录时排除子项目 `.git/`。
- 临时脚本、下载中转和回执放根 `Saved/Agent/<任务名>/`，测试临时文件放 `Saved/Tests/`；唯一素材和必需成果不能只放可清理目录。
- 仓库脚本一律用绝对路径。未经明确要求，不创建远程仓库、提交或推送；项目与工具 Git 分开管理。
- 文档用中文、只写关键事实；每项知识一个维护位置，其他位置链接。参数和副作用维护在工具 help，格式维护在 Schema，具体身份和版本维护在配置。

| 任务 | 必读入口 |
|---|---|
| 故事、分页、seq、角色与场景 | `story-editing` → [创作规则](docs/creative/guide.md) |
| Prompt、图片或视频生成 | `prompt-authoring` → [Prompt 与生成规则](docs/creative/prompt-generation.md) |
| 参考图搜寻 | `lora-material-sourcing` |
| 训练素材、Caption、训练与分析 | `lora-training` → [训练知识](docs/reference/lora-training.md) |
| ComfyUI、模型与环境 | `comfyui-runtime` → [环境](docs/reference/setup.md) |
| 项目、资料归属与备份 | [项目事实](docs/reference/project-files.md)、[资源登记](library/resources/README.md) |
| 软件开发 | [开发指南](docs/dev/guide.md) |
| Agent / DSH 配置与工具接入 | [集成说明](docs/agent/README.md) |

技能源在 `.agents/skills/<名称>/SKILL.md`；有技能工具时按名称加载，否则按路径读取。只有用户当前明确调用 `agent-sync` 才同步 Claude 投影，普通文档或技能修改不触发同步。
