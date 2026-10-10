# 模型与 LoRA 资源登记

本页维护身份、来源与预览。权重目录见 [环境搭建](../../docs/reference/setup.md)，项目生命周期见 [项目文件](../../docs/reference/project-files.md)。权重不随元数据归属移动。

## 登记范围

| 类型 | 仓库 | 本机（忽略） | 项目 |
|---|---|---|---|
| 普通模型 | `library/resources/catalog.json` | `app/data.local/model-resources/catalog.json` | 不支持 |
| LoRA | `library/resources/loras/<id>/resource.json` | `app/data.local/lora-resources/<id>/resource.json` | `<所属项目>/resources/loras/<id>/resource.json` |

画风等通用 LoRA 可留工作台；角色 LoRA 按所属项目登记，slider 等可留本机。用途与归属不以 NSFW 分类。

普通模型汇总 repo / local，按 ID 和权重路径去重，仓库优先；LoRA 按资源 ID 合并，项目优先于仓库，仓库优先于本机。项目资源只从显式登记且可用的目录发现，跨项目按 ID 读取。

归属迁移、所属项目登记和备份要求见 [项目文件](../../docs/reference/project-files.md)，不另维护资源副本。

## 身份与说明

普通模型遵守 `resource-catalog.schema.json`，LoRA 遵守 `lora-resource.schema.json`。身份由权重相对路径与 SHA-256 决定，不从文件名猜底座或校验值。

LoRA 的 `resource.json` 是底座、触发词、建议参数、训练摘要、来源与预览的唯一说明来源，权重内嵌元数据只作备份。来源能确认的 Civitai 模型／版本 ID、URL、trained words 和示例条件按 Schema 登记；缺失值明确 unknown / null，不编造。

中文名、简短摘要和用途只用于浏览，不替换原名或触发词，不参与编译；已有结构字段不再用长段说明重复。不根据预览推断未说明的能力。

选择器汇总已登记资源，裸权重与训练 checkpoint 分开浏览；裸权重不自动联网补全，清单不自动创建生成配置。操作和字段查 `help resources`。

## 预览

| 资源 | 位置 |
|---|---|
| 仓库普通模型 | `app/public/resource-previews/` |
| 本机普通模型 | `app/data.local/model-resources/previews/`，src 仍用 `/resource-previews/<文件名>` |
| LoRA（三种范围） | 各自资源目录 `previews/`，经 LoRA API 读取 |

普通模型通常 1–3 张 jpg；LoRA 至少一张预览或一张带完整条件的示例。登记本地路径、alt、来源页及来源提供的内容级别，第三方许可按来源处理。图片随所属范围进入 Git 或备份，候选仍按项目成果管理。

LoRA 按用户指定来源整理，不默认筛选 `nsfw=None`；普通仓库模型下载脚本固定筛选 `nsfw=None`，不代表 LoRA 分类规则。

## 普通仓库模型预览工具

脚本只维护仓库普通模型清单和公共预览，不维护 LoRA 或本机清单：

```powershell
node C:/Workspace/story-canvas/app/scripts/fetch-resource-preview.mjs --help
node C:/Workspace/story-canvas/app/scripts/fetch-resource-preview.mjs --check
```

下载指定资源和来源版本，`--write-catalog` 才写清单；参数查脚本 help，API key 来自本机配置。删除资源后检查孤儿图，核对范围再用 `--prune`。
