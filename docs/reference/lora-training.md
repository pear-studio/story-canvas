# LoRA 训练

本文说明训练项目的素材、Caption、当前设置、预检和运行结果契约。正式训练项目独立存放并由本机 `Config/projects.json` 登记；接口统一读写，见[本地项目管理](local-projects.md)。

工作台通过顶部当前名称下拉菜单进入「LoRA 训练」，不需要加载剧情项目。选择训练项目后，在素材、训练设置、训练记录之间切换。桌面使用现有侧栏，手机使用现有目录抽屉；训练不占用项目底部翻页区域。

## 数据集

当前数据集契约为 version 5：

- `activation_terms` 是保持顺序的字符串数组；数组中的每个字符串必须非空，数组本身可以为空。
- `groups` 中每个分组只保存 `id`、`name`、`enabled`、`repeats`。
- `items` 中每个训练项只保存 `id`、`asset_id`、`group_id`、`enabled`。
- 图片、Caption、来源和处理结果属于素材文件及服务端投影，不写入 `project.json` 的训练项结构。
- 实际训练集合只包含启用的图片，并且图片所属分组也必须启用；分组的 `repeats` 决定重复次数。

图片上传后会为每个素材建立独立目录，保存原图、当前训练图、Caption 文本和元数据。复制训练项会得到独立的素材身份，不与原项共享文件。

### 筛选后的图片整理

用户只委托裁剪、分角色和导入时，完成图片整理即可，不自动扩展到 Caption、超分、训练方案或预检。完整准备到可训练状态是另一种委托范围。

- 以用户删选后留在最终验收目录的文件为输入，重新枚举并核对；不扫描整个临时采集区补回已删除候选。来源链接随素材导入保存，原始文件保持不变。
- 角色分别建立或选择数据集。按实际需要区分官方三维、二维动画、同人常服、换装和测试版等来源，不为每张图建立分组；无法干净分离的合图可放在禁用参考组。
- 裁剪优先去除无关人物、大片空白和可避开的 UI，同时保留有用的脸部、发型、手势和服装信息。构图完整的图不必裁；不为了统一比例强制切掉头发、手指或武器，也不从每张图机械生成多份近重复裁片。
- 合图只有在目标人物能被清楚分离时才分别使用。不能分离或裁后信息过少的保留参考，不强行当作有效单人样本。换装可以保留，后续标注实际服装差异，不能直接视为稳定性增益。
- 通过素材导入和 `postprocess/preview`、`postprocess/apply` 保存可恢复的裁剪。先确认预览，再检查实际保存结果；原图、裁剪坐标、尺寸和文件对应关系都应可核对。裁剪后再判断是否需要超分，不把放大后的尺寸当作原始细节。
- 收尾复核实际启用集合、文件可解码、重复图及低分辨率项，区分“已启用图片”和“已完成标注、可训练”。若另导出便于查看的图片目录，明确它是工作台当前训练图的副本，正式素材与原图仍在数据集中。

统计时分别报告源文件数、各角色有效图片数和禁用参考数；合图在两个数据集中出现不代表新增了两张独立源图。原图、处理图和导出副本也不重复计入训练图片数。

用户明确需要抠图时可使用[本地素材抠图工具](setup.md#素材抠图)，输出先放 `Saved/Agent/<任务名>/`；检查边缘后再导入，不把去背景作为所有训练素材的默认处理。

## Caption 工作流

Caption 投影使用三种状态：

- `unlabeled`：当前 Caption 为空，且没有可用的基础 Prompt 记录。
- `unconfirmed`：当前 Caption 非空，或已有基础 Prompt，但当前图片哈希与 Caption 哈希还没有完成绑定。
- `confirmed`：确认记录中的图片哈希和 Caption 哈希都与当前文件一致。

基础 Prompt 由配置好的打标器生成。默认操作只处理缺少 Caption 的图片；需要覆盖已有 Caption 时，工作台只能针对当前选中的单张图片发起重新打标，并在覆盖前请求确认。确认后旧当前 Caption、旧原始结果和旧确认状态一起丢弃，以新的打标结果重新建立当前 Caption。

工作台把“保存 Caption”和“确认当前 Caption”分成两个动作：

1. 保存 Caption 只写入素材目录的 `caption.txt`，并清除原有确认记录。
2. 确认当前 Caption 将当前文本和当前图片的哈希写入确认记录。

因此，手工修改或保存 Caption 后不能沿用之前的确认；图片裁剪、超分或恢复原图后也必须重新确认。禁用的图片和禁用分组不会进入实际训练集合。

Agent 的独立 Caption 审计另存为 `captioning/audit.json`，只记录已经实际检查过的当前图片 SHA-256，
不保存 Caption 哈希或逐标签历史。修改 Caption 不会清除审计记录；图片内容变化后因为 SHA-256 改变，
新图片会重新进入待审计。图片被禁用、移除或离开有效集合时，历史图片哈希仍保留，以便同一图片以后
重新加入时继续识别。审计是面向标签式 Caption 的独立历史功能（快照 scope 固定为 `anima`），
与 Qwen 训练Caption 的哈希确认门槛互不替代；当前训练路线不强制标签格式，标签与自然语言 Caption
都原样使用。

## 主要接口

以下路径均以 `/api/lora-training` 为前缀：

- `GET /datasets/:datasetId`：读取数据集、素材详情和 Caption 投影；实际 Caption 位于各素材目录的 `caption.txt`。
- `POST /datasets/:datasetId/caption-runs`：运行基础 Prompt；默认请求体使用 `{ "mode": "missing" }`。单图覆盖使用 `{ "mode": "single", "item_id": "item-...", "confirm_overwrite": true }`；服务端拒绝数据集级覆盖。
- `GET /datasets/:datasetId/captioning`：读取三态 Caption 投影与汇总数量。
- `GET /datasets/:datasetId/caption-audit`：按当前有效训练集合读取 `audited`、`pending` 和 `blocked` 审计投影。
- `POST /datasets/:datasetId/caption-audit`：把已经完成视觉与 Caption 检查的当前图片 SHA-256 写入独立审计快照；请求体为 `{ "image_sha256": ["..."], "prompt_family": "anima" }`。
- `PUT /datasets/:datasetId/captions/:itemId`：保存手工 Caption，请求体为 `{ "caption": "..." }`。
- `PUT /datasets/:datasetId/captioning/items/:itemId`：逐图更新当前文本并按请求体中的 `confirm` 决定是否绑定当前图片与文本哈希；确认请求使用 `{ "prompt": "...", "confirm": true }`。
- `POST /datasets/:datasetId/postprocess/preview` 与 `POST /datasets/:datasetId/postprocess/apply`：预览和应用图片后处理。
- `POST /tasks/:taskId/preflight`：按启用图片、Caption 状态和本机资源执行训练前检查。
- `POST /tasks/:taskId/runs`：冻结当前输入与配置并启动训练；`POST /tasks/:taskId/runs/:runId/stop` 请求优雅停止；`DELETE /tasks/:taskId/runs/:runId` 删除记录（保留外部权重）。
- `POST /tasks/:taskId/runs/:runId/resume`：从该 run 的最新完整恢复状态续训，请求体为 `{ "max_train_steps": 4000, "note": "...", "source_snapshot_id": "step-002000", "source_sha256": "..." }`；只改累计目标与备注，陈旧来源返回 409。

### 并发与媒体

数据集详情和训练设置详情的响应头 `ETag` 表示同一训练项目的当前事实版本；datasets 与 tasks 视图使用相同 ID 和共享 ETag。
更新素材、Caption、设置及启动 run 时，在 `If-Match` 中带上最新详情读取的 ETag；素材或设置变化后重新读取，训练启动仍重新预检并冻结实际输入。创建训练项目、停止和删除 run 不要求 ETag。tasks 不提供独立方案创建接口。
缺少版本返回 428，版本冲突返回 409；工作台保留草稿，由用户刷新后重新修改，Agent 不自动覆盖。
这些接口不使用项目 revision，也不进入项目锁。训练页的「刷新」独立读取训练事实。
素材地址为 `/api/lora-training/media/datasets/<dataset-id>/...`，不依赖项目媒体入口。

新建接口 `/datasets` 返回的 ETag 属于集合请求范围，不能直接用来更新新建的训练项目；创建后先 `GET /datasets/:datasetId` 获取项目 ETag。后续该项目请求使用最近成功响应的 ETag；遇到 `training_revision_conflict` 时重新读取并判断差异，不只替换版本后重放旧请求。

导入素材使用 `POST /datasets/:datasetId/assets` 的 multipart 请求，包含 `group_id`、`files`，可用 `source:<文件名>` 保存各图来源。裁剪预览传 `item_id`、`crop: { x, y, width, height }`、`upscale: false`；裁剪可用归一化坐标，服务端按原图转换为像素。应用时传相同处理参数及预览返回的 `preview_id`。完整画幅且不超分的图片无需调用后处理，否则返回 `lora_postprocess_no_changes`。

当前训练事实操作在单服务内串行执行；并行请求不同数据集不会加速这些操作。裁剪与导入使用现有批量入口或顺序请求，避免为等待中的操作重复发起写入。

## 预检与训练

预检会检查实际训练集合、图片分辨率、Caption 内容、模型资源、磁盘空间和本机运行环境。空 Caption 使用 `empty_caption` 阻断；有 Caption 但未完成当前哈希确认使用 `caption_unconfirmed` 阻断。禁用图片和禁用分组不产生这些阻断项。Caption 原样进入训练，标签或自然语言均可；runner 不改写、打乱或拼接触发词。独立 Caption 审计（`captioning/audit.json`）不是 Caption 确认门槛，不能代替当前哈希确认。

当前设置契约为 version 5，唯一训练路线是 Qwen-Image-2.1（BF16）；`settings.json` 保存 `target`（`family` 固定 `qwen-image-2-1`、`prompt_family`、`usage_defaults`、`base` 四个模型目录前缀）、`training_recipe`（`id` 与 `overrides`）和 `run_defaults`，不重复保存项目名称或素材引用。契约细节见 `library/schemas/lora-training-settings.schema.json`。

唯一 recipe 是 `library/lora-training/recipes/qwen-image21-lora-v1.json`，其 `semantic_config` 固定：
`max_pixels` 1048576（保留纵横比）、rank/alpha 32（alpha 恒等于 rank）、LR `1e-4`、AdamW
（betas `[0.9, 0.999]`、eps `1e-8`、weight_decay `0.01`）、ConstantLR（最初 5 次更新为基础 LR 的
1/3，之后基础 LR；每次 `optimizer.step()` 后调用 `scheduler.step()`）、底模/LoRA/优化器状态全部
BF16、梯度检查点开启；`lora_target_modules` 是固定 commit DiffSynth auto_detect 在官方 BF16 DiT 上的
展开结果，冻结在 recipe 中，不依赖运行时探测。方案可覆盖的键只有 `network_dim`、`learning_rate`、
`gradient_accumulation_steps`；Micro Batch 固定 1，有效 Batch 等于梯度累积次数，均为只读派生。
`run_defaults` 只保存 `max_train_steps`（默认 2000）、`save_every_n_steps`（默认 500）、`seed`（默认 42）；
梯度累积是语义训练参数，保存在 recipe overrides，不另设可写来源。默认 2000 是预算而非质量达标线或上限。

训练器不生成内置预览，也不保存预览 Prompt 或提供训练预览媒体接口；只按计划保存 checkpoint，
后续通过工作台对比实验验收。

训练项目的素材与 Caption 保存在 `assets/`，组织信息在 `project.json`；唯一当前设置在 `settings.json`。启动前通过预检，每次运行冻结当时的输入与配置。
执行状态、日志与工作副本位于项目 `Saved/Training/<task-id>/<run-id>/`（`cache/`、`control/`、`status.json`、`events.jsonl`、`console.log`）；冻结输入、实际配置和终态结果归档在项目 `Training/<task-id>/<run-id>/`（`manifest.json`、`inputs/`、`resume/`、`result.json`），终态同时归档完整事件和控制台日志。manifest 中图片与 Caption 路径相对 `paths.inputs_dir`。
两处均不进入 Git；清理 Saved 不影响已归档成果。checkpoint 直接写入
`models_root/loras/training/<task-id>/<run-id>/`，会作为通用、未登记 LoRA 出现在项目和对比实验选择器中。
删除训练记录不会删除这些权重，权重缺失或被替换也不会覆盖历史 checkpoint 身份。
用户可在工作台开始和停止训练，并从最新完整恢复状态继续训练（见下文「停止、恢复与续训」）；明确授权后，Agent 也可通过工作台接口在授权范围内发起一轮或多轮训练，每轮启动前保存配置并通过预检，不重复请求已有授权。
“训练设置”维护当前项目的配置；“训练记录”展示当前项目全部历史 run。`GET /api/lora-training/runs` 仍可聚合本机登记项目的归档记录。运行中的记录置顶，其余按结束时间倒序，缺失时使用创建时间；
详情使用冻结 manifest 的名称与参数。默认选择最新记录，轮询保留用户选择。Loss 曲线来自 runner 事件报告的
每次更新 loss，同一步保留最后一次有效值；可悬停查看 step 和数值。服务从完整日志读取历史，并在运行终态
归档到结果记录，不把 loss 当作生成质量评分。Python 训练输出统一使用 UTF-8；已有损坏日志不会自动修复。
Loss 曲线默认使用自动纵轴范围，可手动切换固定 0–0.2；超出固定范围的点会提示，
曲线只裁切显示，不改变原始数值。设置页保留直接编辑，本机执行参数始终展开。设置分组为训练设置、
LoRA 与优化器（rank、LR 与高级项中的梯度累积；Alpha、Micro Batch、优化器只读）、运行预算与保存；
统一「保存配置」之后才能预检。设置页只读展示有效 Batch 与本轮图片处理量（`max_train_steps × 梯度累积`，
例如 2000 更新 × 累积 4 = 8000 张次）。

项目唯一当前设置将 `training_recipe.overrides` 中的训练参数与 `run_defaults` 一起保存。创建训练项目时建立默认设置，运行时不读取上轮值覆盖当前设置。
预设仅显式应用到草稿，先展示变化；步数、随机种子及本机设置不受应用预设影响。优化器仍由预设固定。
启动区展示与上轮的参数差异，数据集内容不因此被判定相同。

`GET /tasks/:taskId/run-settings` 返回保存参数的展开值及上轮配置，仅供展示；不再返回逐项建议或继承来源。
预检、冻结和启动读取已保存的方案，请求体只需 `{ "run_settings": { "note": "本轮说明" } }` 或空对象。
请求若携带参数且与保存值不同，返回 `unsaved_lora_training_settings`，要求先保存；不会创建仅本轮生效的隐藏覆盖。
存储格式调整时，只对当前受管方案做一次性人工整理；不维护自动迁移、版本兼容层或迁移工具。历史 run 快照、素材和权重保持原样。
本次训练备注为可选的 `run_settings.note` 字符串，随运行清单冻结并在记录详情显示，不写入方案，也不自动沿用上轮备注。
同一训练方向的参数微调更新当前设置，历史输入由各次运行快照保留；只有用户明确要求独立方向时
才新建训练项目，不为每轮实验复制项目或素材。
对比实验由全局独立工具提供，支持页面一次性导入和自由文本输入。正式 LoRA 由 Agent 按需手工整理和登记。

### 训练条件比较

比较训练配置时，同时核对总步数、梯度累积、数据量与分组重复次数。当前调度器为 ConstantLR，
不依赖总步数：扩大预算的续训不会改变前段学习率轨迹；scheduler 不重新 warmup，采样也不回到第一张。
因此同一冻结输入下「连续训练到 N」与「训练到 K 后续训到 N」的前 K 段语义一致。

### 两阶段执行与事件

每次 run 由 Node 依次启动两个独立 Python 子进程，使用仓库内薄 runner
`app/python/qwen-image21-lora-runner.py`（`--phase cache|train`）：

1. **缓存阶段**：加载 BF16 文本编码器与 VAE，逐张编码冻结输入并写入 `cache/<item-id>.pth` 与
   `cache-manifest.json`（输入 hash、模型身份、`max_pixels`、runner 版本），完成后退出并释放显存；
2. **训练阶段**：校验缓存清单完整匹配后，只加载 DiT 并注入 LoRA 训练。训练时只做必要尺寸对齐，
   不再次任意裁剪。

UI、保存间隔、总预算、scheduler 与文件名中的 step 一律是完成的 optimizer update。累积 G 时做
G 次单图 forward/backward，loss 按 G 归一化，只做一次 optimizer/scheduler 更新；同时记录
`samples_seen`（已处理张次）。采样按启用分组的 repeats 建立加权索引序列，每轮用固定 seed 确定性
shuffle，耗尽后进入下一轮；不按总预算截断数据序列，一次更新允许跨轮次边界，也不把总预算再乘一遍
repeats。

runner 向 `events.jsonl` 输出有版本的结构化事件（每行 `{"v":1,"event":…,"time":…}`）：
`phase`、`cache_progress`、`optimizer_step`（step/target/loss/lr/samples_seen/seconds）、
`checkpoint`、`resume_saved`、`end`（含性能档案）与 `error`。上游 stdout/stderr 原样归档到
`console.log`，Node 只消费事件文件，不解析自由文本日志猜进度。

### checkpoint、恢复包与保留策略

每个保存节点（`save_every_n_steps` 边界、正常结束、优雅停止前）产出两类文件：

- 小型 LoRA 权重 `checkpoints_dir/step-NNNNNN.safetensors`（位于 `models_root`，键名去掉
  `pipe.dit.` 前缀，与上游一致），随保存即出现在记录列表，全部保留，供出图比较；
- 完整恢复包 `Training/<task-id>/<run-id>/resume/step-NNNNNN/`：`lora.safetensors`（完整可加载态）、
  `optimizer.pt`、`scheduler.pt`、`rng.pt`（Python/NumPy/Torch CPU/CUDA 随机状态）、
  `sampler.json`（采样顺序、游标与随机状态）、`state.json`（累计步数、已处理张数、语义配置指纹、
  trainer/runner 身份与各文件 SHA-256）。恢复包不包含冻结基础模型。

保存只在完整 optimizer 更新边界进行，先写临时位置、校验齐全后原子发布，再替换
`resume/latest.json` 指针。**同一训练任务只保留最新一份完整恢复状态**（含续训产生的后继 run）：
新指针发布成功后，runtime 才清理被取代的旧包；写入失败或中断始终保留上一份完整恢复点。旧包清理后，
历史记录显示权重可用但恢复状态已清理，不再标记可精确恢复。rank 32 时单份 LoRA 约 160 MiB、
恢复包另含约两倍于此的优化器状态，预检按缓存与新旧恢复包共存估算磁盘余量。

### 停止与续训

普通「停止」只写控制文件；runner 在下一个完整更新边界保存恢复包与最终 checkpoint 后退出，缓存阶段
在已完成条目的边界停止（不产生训练恢复点）。停止请求超时后服务才强制终止，强制终止可能回退到
上一次完整状态，不声称保存成功。服务重启不自动继续训练：核对存活的训练子进程身份，无法接管的有界
终止并把 run 标为中断，保留可用恢复点。

训练记录中的「继续训练」仅在该 run 的最新完整恢复状态可用时出现。续训通过
`POST /api/lora-training/tasks/:taskId/runs/:runId/resume` 创建新 run，请求体只有
`max_train_steps`（累计目标步数，必须大于已完成步数，如 2000 → 4000 表示追加 2000 次更新）、
可选 `note` 和已读取的恢复包身份（`source_snapshot_id`、`source_sha256`）；服务端串行校验该快照
仍是本任务最新完整状态且无活动 run，陈旧来源返回 409。新 run 冻结 `parent_run_id`、来源快照身份与
`start_step`，并归档自己的输入副本，沿用父 run 冻结的图片、Caption、模型、rank、LR、梯度累积、
精度、scheduler 与采样语义；**首版续训只改累计目标与备注**，保存间隔沿用父 run，其他参数变化应
另开从头训练。DiffSynth commit、runner 文件 hash 或模型身份与父 run 不符时阻断续训。不提供
暖启动（只加载旧 LoRA）入口。

version 4 的历史 run（Anima 路线）保留原始 manifest、日志与权重，只读展示并明确标记
「历史记录，不支持精确续训」，不能作为续训来源，也不会影响新 run 列表。

### 性能档案

终态 `result.json` 保存性能档案：总墙钟与分阶段耗时、秒/更新、处理张次，以及 runner 报告的
Torch allocated/reserved 峰值显存、整卡显存/利用率/功耗峰值、进程 RSS 与整机内存峰值。`performance.phases` 分别保留缓存和训练指标；整卡/整机读数包含其他进程，每秒采样不保证捕获所有瞬时峰值。监控缺失时字段缺省，不填 0，也不导致训练失败。

参考量级来自接入前的一次仓库外手工实验（登记训练项目
`Training/qwen-image21-style/20260922-veloria-01/`，参数与当前默认一致）：80 张启用图片、
rank/alpha 32、LR `1e-4`、Micro Batch 1、累积 1，RTX 4090 24GB 上完成 2000 次更新，缓存约
94 秒、训练约 62 分 25 秒、稳定更新约 1.845 秒；整卡显存峰值缓存约 22.88 GiB、训练约 20.94 GiB。
这是单次观测，不是 SLA，也不代表其他数据集的耗时或显存。

2026-09-22 已在独立测试项目 `dataset-a979618335e6` 完成 RTX 4090 / BF16 短程验收：两张素材、
rank 32、梯度累积 4，连续 8 次更新与第 4 次正常停止后在新 run 重建缓存并继续到第 8 次对照。
448 个 BF16 LoRA 张量逐位相同，loss/LR/样本计数轨迹一致；旧完整状态清理后仅保留最新约 480 MiB
恢复包，各阶段 LoRA 保留。INT8 管线完成底模/新 LoRA 各一张同种子出图，无未加载参数警告。
证据在该项目 `Training/dataset-a979618335e6/run-71298e55455d/` 的 `review-report.md`、
`verification.json` 和 `validation/`。该验收证明本机短程技术链路可用，不证明长程质量、跨设备或 Linux 恢复一致性；
真实强制杀进程后恢复尚未单独测试。

训练启动时检查配置的本机 ComfyUI 队列：有生成任务则拒绝启动，空闲时释放驻留模型以腾出显存。
训练过程中不要另行从外部客户端发起生成；当前没有跨进程 GPU 调度器。

## 运行清单

当前 run manifest 为 version 5，字段以 `library/schemas/lora-training-run-manifest.schema.json` 为准：

`version`、`id`、`task_id`、`dataset_id`、`created_at`、`task_name`、`dataset_name`、`family`、`prompt_family`、`usage_defaults`、`description`、`activation_terms`、`items`、`groups`、`models`、`trainer`、`recipe`、`semantic_config`、`run`、`sampling`、`resume`、`paths`、`execution`、`seed`。

要点：

- `models` 是逐文件身份（kind、相对路径、SHA-256、大小、来源），来自仓库清单
  `library/lora-training/qwen-image21-models.json`；`trainer` 记录 DiffSynth commit、Python/Torch、
  GPU/显存与 runner 文件 hash；`recipe` 记录 id、版本与文件 hash；`semantic_config` 是 recipe 展开
  后的全部有效值（含 `network_alpha` 与冻结的 `lora_target_modules`）；
- `run` 保存本轮 `max_train_steps`、`save_every_n_steps`、`seed` 与可选 `note`；`sampling.weights`
  是逐训练项的采样权重（所属启用分组的 repeats）；
- `resume` 为 `null`（全新 run）或 `{ parent_run_id, source_snapshot_id, source_sha256, start_step }`；
- `paths` 保存输入、缓存、控制、归档、恢复目录与事件/日志/checkpoint 的绝对路径；
  `execution` 冻结 Python 可执行文件与 runner argv。

清单中的 `activation_terms` 仍是字符串数组；分组只使用 `id`、`name`、`enabled`、`repeats`；训练项使用 `item_id`、`asset_id`、`group_id`、`source_file`、`image_file`、`caption_file`、`image_sha256`、`caption_sha256`。

训练记录通过 `checkpoints_relative_path` 单向关联 checkpoint；权重本身不依赖训练记录。正式登记时由 Agent 读取清单中的任务／数据集显示身份、模型身份、数据集快照和执行配置，不重新读取当前任务或数据集来解释既有 run。服务重启时只会把失联的 running run 标记为中断，不会加载训练 state 继续执行。

## 1024 训练图片准备与超分增强

导入图片、应用裁剪或恢复原图时，在同一次保存操作中完成训练图处理，包括禁用分组的新素材。打开页面和刷新只读取，不触发处理。默认使用 1024 级别的训练桶，按原比例选择最接近的尺寸，边长为 64 的倍数；例如竖图可以是 768×1024，横图可以是 1024×576，并非全部裁成正方形。先沿用已保存的人工裁剪，再居中裁剪到目标比例。原图保留，可恢复。

首版固定规则如下，阈值用于试运行，不代表真实分辨率或训练效果：

1. 生成目标尺寸的缩放图，用 MUSIQ 评分；分数达到 60 时直接采用，跳过超分。
2. 低于 60 时生成超分候选，再缩回相同目标尺寸评分。大图先缩放，小图从裁剪后的源图超分，避免先插值放大。
3. 自动处理时，超分后比缩放图提高至少 2 分才采用，否则保留缩放图。手动明确选择超分时复用已应用的结果，再统一到训练尺寸；评分只作参考，不以 60 分或增益门槛撤销手动选择。素材卡片简要展示两次分数，悬停可查看采用原因，全屏默认查看最终训练图；跳过超分时没有第二次评分。

MUSIQ 使用独立 Python 进程，每批只加载一次权重，结束即退出。模型与配置相同、原图和裁剪未变化时复用准备结果。评分或超分失败时保留已导入或已裁剪的图片，持久保存失败原因；界面明确显示处理未完成，可重试。正式图片内容变化后需要重新确认 Caption；推荐先准备图片，再打标和审计。

导入和后处理 HTTP 入口在同一事实写入边界内完成准备后返回；处理期间暂停数据集编辑并显示“正在处理图片”。失败时素材仍已保存，卡片展示原因，并提供“重试未完成图片”。重试接口为 `POST /api/lora-training/datasets/:datasetId/postprocess/prepare`，携带当前数据集的 `If-Match` 与可选 `item_ids`；省略列表时处理当前启用集合。不会在打开页面或刷新时隐式重试。底层导入函数用于组合与测试，不单独调用模型；脚本应走 HTTP 导入入口或显式调用准备函数。

训练预检要求有效图片已经完成准备；方案的最大像素数固定为 1048576（1024 级别）。训练快照使用已选中的准备结果，准备好的图片已匹配目标尺寸，训练时只做必要尺寸对齐，避免再次改变构图。人工重新裁剪或恢复原图会清除准备状态，同一次操作会重新准备。不会自动开始训练。

MUSIQ 衡量观感质量，可能偏好锐化，也不保证保留角色细节；前后同尺寸评分便于比较，仍应结合预览判断。配置与权重部署见 [环境搭建](setup.md)。

单张图片后处理支持原尺寸 1×、2× 和 4×；API 使用 `upscale: true` 和 `output_scale: 1 | 2 | 4`。1× 先运行现有 4× 模型，再用 Lanczos3 缩回输入尺寸；启用裁剪时，输入尺寸指裁剪区域。每次处理都从保留的原图和当前裁剪框出发，不反复叠加增强。先生成预览，对比确认后应用，也可恢复原图。

单张超分与自动训练图准备均将透明区域合成到白色背景后处理，输出不透明图片，半透明边缘按 Alpha 混合；原始透明文件保留。只裁剪而不超分时仍保留透明通道。当前 Anime 6B 模型没有原生强度参数，1×／2×／4× 仅表示输出尺寸。

原尺寸增强可用于像素尺寸足够但观感模糊的素材；像素数不代表真实清晰度，增强可能改变线条和纹理，不能保证恢复真实细节。1× 仍执行 4× 模型，中间图的资源开销和尺寸限制不变。

新素材在导入时完成准备；需要手工指定原尺寸增强或放大倍率时，在单张图片后处理中选择。
