# 页面、候选与成品

本页维护操作与媒体语义；创作确认、修正和生成数量见 [AGENTS](../../AGENTS.md)。参数查 [操作 help](agent-interfaces.md)，归属查 [项目文件](project-files.md)。

## 页面编辑

页面身份为 `{page_id}`（文本形式 `v3/<page-id>`）；剧情、角色、场景归属只控制组织和顺序，不参与媒体身份。图片页可引用多个角色子设定和一个场景子设定，新验证页默认引用所属设定。

移动归属不改引用、候选或成品；复制产生新 ID，带内容、Prompt 与布局，不带媒体。删除角色或场景保留页面和引用，失效归属进入待整理，失效引用显示诊断；已有媒体仍可查看。

`page.editor.read/save` 编辑内容，`prompt.read/save` 编辑模型输入，`page.render.read/set` 编辑本页生成设置。content 的画面描述不自动编译成 Prompt，画外对白不自动增加生成角色。结构编辑用语义导航操作。

Anima 是日常插画路线；备用 Qwen 的专有输入与改写见 [Qwen](qwen.md)。

## 生成与候选

保存后按需 `generation.page.inspect` 核对实际输入，再 `generation.run`、`task.wait`、`task.results`。读图使用回执的绝对路径，不扫描目录猜最新图片。

`candidate.list` 读取单张候选，`task_id` 可过滤一次生成；`candidate.inspect` 看冻结输入，`candidate.batches` 查任务分组。任务分组用于核对操作，不要求向用户汇报批次。

## 清理旧候选

1. 用 `generation.run` 生成并等待成功发布，核对新候选与当前输入匹配；失败、未出图或事实已变化时不先删旧图。不要用 `generation.regenerate` 做此流程，它在新任务提交后立即清理旧候选。
2. 用 `finished.inspect` 核对并保留当前成品记录仍引用的候选；删除接口不会自动检查成品引用。正式参考图经 `reference.save` 复制到 `materials/` 后不受候选删除影响。
3. 无需保留旧候选时，`candidate.cleanup.preview/apply` 显式指定已核验的 `keep_task_id`，保留整组。需保留部分旧候选时，改用 `candidate.delete` 明确列出可删 ID。集合变化重新预览；部分失败只处理失败项。

插画 `generation_signature` 比较实际正负向、模型／LoRA 身份、参考图、配方和工作流，排除种子与展示名；它比较生成条件，不只是 Prompt 文本。`candidate.scan/clean` 可按同次 signature 清理明确的不匹配集合；条件不完整时不可据此清理。

H3 的 signature 未覆盖全部视频参数，须核对冻结的视频设置与实际输入，并按明确 `task_id` 保留，不能单靠 signature。不要把材料或成品当候选删除。

## 嵌字与文字页

content 保存对白、心理、旁白和爱心文字，新条目由服务端生成 ID。项目样式用 `lettering.settings.read/save`，逐页布局用 `lettering.page.read/save`；布局不复制文案，颜色属于项目样式。

旁白每页至多一条，使用顶部或底部字幕条，无拖动布局；其他文案在预览中调整位置和尺寸。爱心文字另支持字号、排列方向与随机排列，具体可编辑项沿用读取结果和 help。

文字页不生成候选，content 独立保存显示标题、正文和 text_layout，目录标题不入画面；预览与输出共用排版，溢出阻止输出。页面类型创建后不能转换。

## 成品

输出前保存页面事实，`finished.output` 冻结指定候选、文案和布局。插画输出 2 倍超分的 clean / lettered PNG，文字页直接渲染；`finished.inspect` 看记录状态，`finished.jobs` 看进度。

只改文字可复用当前无字成品；源候选和无字成品都缺失则须重新生成。重新输出替换当前记录和媒体，不维护版本历史。事实或选图变化可使成品过时，移动顺序不要求重新制作。

批量输出只采用当前唯一候选，零张或多张跳过，文字页直接制作；单页失败不阻断后续。以回执核对结果，不自动选择候选。

`finished.export` 按当前剧情页序导出现有成品，不补做缺失或过时内容。ZIP 保留静态 PNG，轻量 HTML 内嵌 WebP；验证页支持单页输出，不进入剧情系列导出。

## H3 动态页

只支持剧情归属；独立动作 Prompt 不自动追加角色或场景输入。`help video` 提供当前流程与参数。生成时间较长，默认单个候选、不自动修正重试。

`page.video.source` 查询前一张剧情插画或指定来源，无候选不回退选图；`reference.save` 把选定图片复制为材料，H3 只持有一张输入，之后来源候选变化不影响它。

预检、生成和等待沿用公共任务入口。候选保留 MP4、封面和抽帧图，抽帧不能代替连续播放验收。视频成品不超分、不嵌字；ZIP / HTML 输出最大宽度 1024px 的动画 WebP，不导出 MP4。原 MP4 是本机成果，WebP 为可重建缓存。
