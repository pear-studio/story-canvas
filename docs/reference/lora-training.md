# LoRA 训练

训练是主线任务，迭代方向以 Anima 为主，也保留 Qwen。当前工作台只能新建 Qwen-Image-2.1 训练，Anima 历史 run 只读、不支持续训；Anima 训练恢复另行实施。当前配方是迭代起点，不是质量保证。
安装见[环境](setup.md)和[Qwen 专用环境](qwen.md#训练环境)；存储见[项目文件](project-files.md)，操作入口见[Agent 接口](agent-interfaces.md)。

## 素材与设置

- 一份训练项目持有素材集合与唯一当前 `settings.json`；同方向调参更新设置，各 run 保存冻结输入，不为每轮复制项目或素材。
- 有效集合只包括 item 与所属 group 都启用的图片；分组 `repeats` 参与采样权重。
- 用户筛选后的目录是导入依据，不补回已删候选。导入保留来源和原图，裁剪、超分均可恢复。
- 裁剪保留身份和造型信息；不为统一画幅切掉关键部位，不机械增加近重复裁片。抠图按需使用。
- 导入、裁剪和恢复会准备训练图；打开或刷新不隐式处理。准备失败时素材仍保存，修复后显式重试。
- 自动准备按配方尺寸保留比例，以 MUSIQ 比较缩放与超分结果；评分不等于细节保真或训练效果。手动处理先预览再应用。
- 图片内容确定后再打标和确认 Caption；“已启用”不等于“可训练”。

## Caption

素材目录的 `caption.txt` 是实际训练文本；自动基础 Prompt 与 `raw_tags` 是复核起点。
打标默认只处理缺少 Caption 的图片，覆盖仅支持单图明确确认，不做数据集级覆盖。
复核标签是否真实、身份是否重复绑定、服装／动作／镜头／背景是否随图变化；调用词见[激活标签](lora-activation-tags.md)。
当前 runner 原样使用 Caption，不自动改写、打乱或追加触发词。AnimeTimm 输出保留下划线，rating 仅存原始结果。

| 状态 | 含义 |
|---|---|
| `unlabeled` | 文本为空且无基础 Prompt |
| `unconfirmed` | 尚未绑定当前图片和 Caption 哈希 |
| `confirmed` | 已确认的图片及 Caption 哈希均匹配当前文件 |

保存 Caption 会清除确认；裁剪、超分、恢复或改文字后重新确认。
`captioning/audit.json` 按图片哈希登记独立标签审计，不绑定 Caption 哈希，不能代替训练确认；只记录已实际检查的图片。接口当前 scope 为 `anima`，不代表已恢复 Anima 训练。

## 接口与保存

HTTP 入口为 `/api/lora-training`，格式以 `app/server/lora-training-http.mjs` 为准，不直接写项目 JSON。
datasets 和 tasks 共用项目 ID 与 ETag；写素材、Caption、设置、启动和续训时带最近详情读取的 `If-Match`。集合创建回执不能代替新项目详情 ETag。
冲突重新读取并判断，不只换版本重放；操作在单服务内串行，勿重复提交等待中的写入。
停止、删除 run 不要求 ETag。训练读写不使用剧情 revision 或剧情项目锁。

## 预检与启动

1. 保存素材、Caption 确认和当前设置。
2. 预检有效图片、准备状态、Caption、模型身份、环境和磁盘；空文本或未确认阻断。
3. 在授权内启动；服务重新预检并冻结输入、配置、模型、训练器及 runner 身份。

字段以 `library/schemas/lora-training-*.schema.json` 为准；recipe 负责语义默认值，`run_defaults` 负责预算、保存间隔与种子。启动不承载未保存参数覆盖。
当前支持 rank、LR、梯度累积调参；可写项以设置契约为准。已引用的 recipe 不原地改语义，基线变化用新版本。
step、保存间隔和预算均指 optimizer 更新；梯度累积增加处理张次，不再乘一次 repeats。Loss 和性能是诊断信息，不是质量评分。
训练前检查本机 ComfyUI 队列，空闲时释放驻留模型；没有跨进程 GPU 调度器，训练中不要另行占用同一 GPU 生成。

## 停止与续训

Qwen 分缓存、训练两个子进程，输入由 manifest 冻结；消费结构化事件，不从自由文本猜进度。
优雅停止在完整更新边界保存 checkpoint 与恢复状态；缓存阶段停止不产生恢复点。强制停止可能回退到最近完整状态，重启不自动继续。
每个保存节点保留 checkpoint；同一任务只保留最新完整恢复包，新包成功发布后才清理旧包。
续训创建新 run，提交读取的快照 ID 与 SHA-256，累计目标步数必须增加；只改预算和备注，沿用父 run 冻结数据、参数和保存间隔。其他语义变化从头训练。
非最新来源、身份不匹配或活动 run 会阻断续训；历史 Anima run 不作为来源。

## 结果与登记

- 项目 `Saved/Training/` 存运行缓存、控制与状态，`Training/` 归档输入、manifest、结果、日志和恢复包；Git 规则由项目文件文档维护。
- checkpoint 直接存外部模型库，删记录不删权重。旧 run 按冻结 manifest 解释，不用当前设置替代。
- 训练器不生成内置预览；用现有对比工具检查 checkpoint，不把一次成功当稳定结论。
- 正式登记读取对应 run manifest，记录模型家族、用途、调用词、文件身份和训练来源；归属见[资源目录](../../library/resources/README.md)。
- 已属其他项目的 LoRA 跨项目读取，不复制；训练产物不自动成为全局资源。
