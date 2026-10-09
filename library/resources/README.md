# 资源目录与预览图

`catalog.json` 是仓库内维护的通用模型浏览元数据来源。模型文件仍以 `relative_path` 与
SHA-256 确定精确身份；`preview.images` 归模型资源所有，可以被模型页和生成配置共同读取。

公开发布的 LoRA 也属于仓库资源：每个 LoRA 各自保存一份
`library/resources/loras/<resource-id>/resource.json` 以及 `previews/` 图片。该记录是 LoRA
完整说明的事实来源，直接包含底座、触发词、建议权重与采样参数、训练摘要、来源、预览和完整
示例条件；SafeTensors 内嵌元数据只作备份。权重本身仍由本机 `models_root` 管理，不进入 Git。

通用画风资源保留在工具 `library/resources/loras/`；本机 slider 等资源放在被忽略的
`app/data.local/lora-resources/<resource-id>/`；角色资源可由唯一所属项目的
`resources/loras/<resource-id>/` 持有，元数据与预览进入所属项目 Git。分类按用途，不按 NSFW。
服务端只从显式登记且可用的项目发现资源，按资源 ID 合并，显示所属项目；其他项目与独立实验
通过相同 ID 读取，不复制、不自动同步。项目记录优先，其次仓库、最后本机记录。
所属项目重命名或重新定位后按登记的新路径读取；移除登记后，不再提供其资源详情和预览。

已有 LoRA 可以由 Agent 计算权重 SHA-256 后建立同样的记录。Civitai 的模型／版本 ID、版本名称、
版本页 URL、底座声明、trained words 和示例图 generation data 应映射进这份记录；工作台直接显示
可点击的来源与版本。缺失的底座哈希或建议参数明确保留为 `null` 或 `unknown`，不能从文件名猜测，
也不使用冗长说明重复描述已经结构化展示的字段。当前工作台不会在发现裸权重后自动联网补全，
也不提供网页安装或导出按钮。

已有完整资源归属移动用 `asset.transfer.plan/apply`，核对计划和指纹后移动整目录；不移动权重。
项目临时复制不复制所属资源，仍读取原所属项目。资料应随所属项目单独备份；本机资源目录也需单独备份。

正式 LoRA 必须至少包含一张 `previews` 预览图或一张带完整生成条件的 `examples` 示例图；项目
生成设置会使用这些图片作为选择卡片，并同时展示触发词、标签、适用底座、推荐权重和采样建议。
公开 LoRA 图片保存在对应的 `library/resources/loras/<resource-id>/previews/` 中，与配置一同提交；
本地训练或私有 LoRA 图片仍保存在 `app/data.local/lora-resources/<resource-id>/`。两者都由 LoRA
资源 API 提供，不复制到 `app/public/resource-previews/`。

## 中文浏览信息与选择器

LoRA 记录可补充 `name_zh`（中文名）、`summary_zh`（一句话详情）和 `purpose`（主要用途）。
用途固定为画风、角色、服装／道具、场景、外观调节、动作／效果、未分类；未填写时显示未分类。
中文信息只用于浏览，不替换原始名称、说明、`activation.tags` 或触发词，也不参与生成编译。
Agent 根据已有来源整理这三个字段；不根据预览图推断未说明的效果。

项目和比较实验共用选择器，支持中文名、原名、说明、原始标签与路径搜索，以及用途和登记范围筛选。
默认显示已登记资源，未登记文件与训练 checkpoint 在独立范围中浏览。项目使用单选，实验比较轴
使用多选并确认；切换筛选保留已选项，取消弹窗不改变实验的已选列表。实验基础 LoRA 也复用单选器。

## 预览图规则

- `catalog.json` 中的基模等通用模型可以配置 **1～3 张** jpg 预览图，放在
  `app/public/resource-previews/`，继续遵循通用模型的安全级规则。
- LoRA 预览放在各自资源目录的 `previews/preview-001.jpg` 等文件中，文件名由资源记录引用，通常
  保存 1～3 张 Civitai 发布图。
- Civitai LoRA 按用户明确选择的发布图保存，包含 NSFW 的图片也可以提交；不以 `nsfw=None` 作为
  默认过滤条件。每张图在资源记录中保存来源 `source` 和 Civitai 的 `nsfw_level`（若网站提供）。
- 每张图片记录本地文件、无障碍 `alt`、来源页 `source` 和可选的 `nsfw_level`，不把内容级别丢失在
  下载日志中。
- 图片属于可提交的 library 资产；项目候选、导出结果等生成媒体仍不提交。

## 工具

在 `app/` 目录运行：

```powershell
# 下载指定 Civitai 模型版本的图片并写回资源目录
node scripts/fetch-resource-preview.mjs --resource <resource-id> --civitai-model <模型id> --version <版本id> --write-catalog --proxy http://127.0.0.1:10808

# 检查资源引用、文件命名与孤儿图
node scripts/fetch-resource-preview.mjs --check
node scripts/fetch-resource-preview.mjs --check --prune
```

API key 从 `Config/local.json` 的 `civitai_api_key` 读取，不会回显。缺少 `--write-catalog`
时，脚本只下载图片并打印可写入的 `preview` 块。删除资源时同步移除其预览图，或在确认范围后
使用 `--check --prune` 清理。
