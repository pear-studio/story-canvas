# 项目文件与资料归属

本页维护目录、事实归属与项目生命周期。操作见 [Agent 接口](agent-interfaces.md)，字段以 `library/schemas/` 为准。

## 存储边界

| 位置 | 内容与管理 |
|---|---|
| 工具 `app/`、`library/`、`docs/` | 应用、全局资产和说明，进入工具 Git |
| `Config/local.json`、`Config/projects.json` | 本机环境和显式项目登记，忽略并单独备份 |
| 工具 `workspace/` | 临时项目，不初始化 Git |
| 正式项目外部目录 | 各自独立 Git，不进入工具仓库 |
| 项目 `Outputs/`、`Training/` | 生成成果、训练冻结输入与结果，忽略并单独备份 |
| 工具及项目 `Saved/` | 任务、缓存和可清理派生物，忽略 |

项目 ID 是本机登记句柄，目录由登记决定，不扫描磁盘发现项目。权重不属于项目，位置见 [环境搭建](setup.md)。

## 剧情项目事实

| 文件或目录 | 唯一职责 |
|---|---|
| `project.json` | 标题、新页默认画幅与生成配置 |
| `creative-agreement.json` | 用户确认的项目约定 |
| `render-profile.override.json` | 本项目生成配置覆盖 |
| `story/outline.json` | 故事、章节、seq 粗骨架，不含分页 |
| `characters/`、`scenes/` | 索引及各设定的 profile、visual、prompt；visual 管理子设定身份 |
| `pages/index.json` | 稳定页面 ID、归属和顺序 |
| `pages/<id>.content.json` | 标题、画面内容、角色引用与嵌字；文字页另有正文和排版 |
| `pages/<id>.prompt.json`、`.render.json` | 各模型输入，以及本页模型、配置、画幅 |
| `pages/<id>.rewrite.json`、`.text-sources.json` | 改写稿、可选语料出处；普通创作不要求维护出处映射 |
| `lettering/` | 项目文字样式与逐页文案布局 |
| `finished/<id>.json` | 当前成品制作记录；媒体在 `Outputs/finished/` |
| `materials/` | 正式参考输入，只支持一层文件；`index.json` 只保存可选标题 |
| `writing-corpus/`、`resources/loras/` | 本项目唯一持有的语料、LoRA 元数据和预览 |

模型输入语义见 [Prompt](prompt.md)，页面操作见 [视觉页面](visual-pages.md)。

## 训练项目事实

一个项目持有一份素材集合和唯一当前 `settings.json`：`project.json` 管素材组织，`assets/` 管图片与 Caption，`captioning/` 管审核事实。启动时冻结输入形成 run，后续编辑不改旧 run。当前训练路线见 [LoRA 训练](lora-training.md)。

## 单一资料归属

语料和项目 LoRA 只保留一个所属项目。跨项目 LoRA 按资源 ID 读取，语料检索显式指定所属项目；不复制、不同步。所属项目必须继续登记且可用，重新定位后按新路径读取。

临时项目复制不复制所属语料和 LoRA，继续读取原所属项目；提升保留临时项目的整个目录。资料迁移使用 `asset.transfer.plan/apply`，核对计划后移动资料目录，不移动权重；源变化或目标冲突会拒绝。资源身份见 [资源目录](../../library/resources/README.md)。

## 生命周期与 Git

- 添加：登记已有绝对目录，不复制；剧情项目须有 `project.json`，训练项目还须有 `settings.json`。
- 新建／复制：在 `workspace/` 创建临时项目；复制只带事实和输入，不带 `.git`、成果、训练历史或缓存。
- 提升：复制到不存在的外部目录并核对，保留本次成果，初始化 Git 后移除临时目录。
- 重新定位：更新登记路径；移除登记只改本机列表，不删除目录。
- 删除：工作台只提供临时项目删除；活动任务会限制生命周期操作。

正式项目 Git 保存事实与输入，包括参考图、语料、训练素材和 Caption；不保存运行状态、成果或权重。当前使用普通 Git，材料、语料和训练素材通过 `.gitattributes` 保护字节身份。

Git 状态只读本机仓库，不 fetch；领先／落后相对本机 upstream 引用。备份分别覆盖正式项目（含必要成果和 `.git`）、`Config/`、本机资源及外部权重；项目复制与 Git 均不能代替成果备份。
