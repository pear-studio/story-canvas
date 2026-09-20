# 对比实验

对比实验是与故事项目独立的全局工具，顶部名称菜单进入。没有项目或当前项目加载失败时仍可使用。
实验拥有自己的测试输入、生成配置和成果，不修改项目，不注册页面候选。
输入与运行快照保存在仓库根 `Saved/comparison-results/<id>/`，状态位于根 `Saved/comparisons/<id>/`；均为本机数据，不提交 Git。
旧项目级实验不兼容、不自动迁移。

## 输入与冻结

每个测试输入包含 `id`、`label`、`prompt.positive/negative`、`loras`、`render` 和可选的 `source`。
`render` 保存完整有效 profile、workflow definitions 与 canvas；source 只记录来源项目、PageKey、导入时间和内容摘要，不参与启动或恢复。

- 从页面一次性导入：通过项目一致性读取与现有页面编译器，展开当前实际生效的 Prompt、角色/风格 LoRA、项目生成配置及覆盖；支持剧情页和角色视觉页。
- 空白输入：选择全局生成配置，不需要项目、页面或词库。正负向文本表示完整目标输入，LoRA 单独设置。
- 浏览器复用自由编辑文本控件，可改文本、权重、画幅、复制或移除输入。没有继承同步、结构化片段编辑或来源变化确认。
- 创建实验时冻结所有输入；Start 从冻结输入构建一 cell 一 workflow，不再读取来源页面或当前生成配置。项目更改、重命名、删除均不影响已创建实验。
- 需要修改已运行实验时，创建新实验；补跑严格使用原冻结计划及未完成格子。

必选 `input` 轴使用标量 `value` 引用本次输入 id；其余轴为 `lora_config`、`character_lora_weight`、`lora_weight`、`seed`、`cfg`。
实验按完整笛卡尔积展开。没有 seed 轴时使用整组共享随机 seed；测试 LoRA 叠加在输入基础 LoRA 之后。
角色权重要求每个输入恰好有一个角色 LoRA；替换角色模式保留导入的角色归属信息，并替换对应 LoRA 与已识别触发词。
正式和未登记 LoRA 都可用于测试，文件身份由服务端冻结，不自动登记资源。

## 执行、查看与清理

评价结果时按相同用例和种子配对检查改善与新增问题，区分 LoRA 新增的问题和底模原有问题；未明确限定的造型变化不直接判为失败。同种子不保证构图相同，同时改变 Prompt 与 LoRA 时只能评价组合方案，不能把差异归因于单一因素。

与普通候选共用本机 ComfyUI、Node 服务和生成队列。全局实验任务的 `project_id` 为 null，按 purpose 解析全局存储；任务卡片使用 `/api/tasks/global/<id>?purpose=comparison`，global 是任务路由占位，不是项目。
实验逐格执行，失败保留成果；显式补跑只执行未完成项。服务重启恢复已启动且冻结计划有效的任务，不读取项目事实。

列表与网格使用轻量 manifest/status，支持搜索、状态过滤、X/Y 轴、切片和大图；进度仍由 App 唯一任务轮询驱动。
新建表单“开始实验”完成保存与启动；若启动失败，列表保留记录，可修复环境后开始已保存实验。

页面支持单个删除与勾选批量清理，删除包含输入快照、成果图片、运行记录以及引用该实验的拼图。
活动 worker 或队列仍持有实验时拒绝删除。先停止实验，等待当前 cell 结束再清理；不会直接中断其他 ComfyUI 任务。
输入来源页面、模型权重和训练数据不属于清理范围。

## API

所有实验入口使用 `/api/comparison-experiments`，仅一次性导入时读取来源项目（独立 import 或创建时 page_import）。

- `GET /`、`GET /:id`：列表与详情。
- `GET /input-options`：新输入可选全局生成配置。
- `POST /blank-input`：`{ "profile_id": "anima-base-v1", "canvas": "2:3" }` 返回可编辑 input。
- `POST /import`：`{ "project_id": "项目ID", "page_keys": [完整PageKey] }` 返回独立 inputs。
- `POST /input-lora`：`{ "source": 正式或未登记LoRA引用 }` 冻结一项基础 LoRA。
- `POST /`：`{ id, page_import?, inputs?, axes?, lora_sources?, include_lora_baseline?, lora_application? }` 创建并冻结实验；`page_import` 与 `inputs` 二选一；省略 input 轴时按输入自动生成。也可直接提供严格 registries。
- `POST /:id/start`、`POST /:id/retry`、`POST /:id/cancel`：开始、补跑、停止。
- `GET /:id/results/:cellId.png`：已发布结果图。
- `DELETE /:id`：删除单个实验。
- `DELETE /`：`{ "ids": ["实验ID", "另一个ID"] }` 清理选中实验；先检查整组选项没有活动任务。

input 轴示例：`{ "type": "input", "values": [{ "value_id": "case-a", "label": "街景", "value": "导入返回的input.id" }] }`。
### Agent 默认路径：原样导入，不修改 Prompt

默认直接在创建请求中指定 `page_import`，无需先调用 import、抄写 Prompt 或传回完整 workflow；输入轴自动生成。只填写本次实际要比较的其他轴，不因为支持编辑就主动改写 Prompt。创建只保存快照，检查返回的 cell 数量后调用 `/:id/start`。

```json
{
  "id": "window-cfg",
  "page_import": {
    "project_id": "my-story",
    "page_keys": [{ "page_id": "page-001" }]
  },
  "axes": [{ "type": "cfg", "values": [
    { "value_id": "cfg-4", "label": "CFG 4", "value": 4 },
    { "value_id": "cfg-6", "label": "CFG 6", "value": 6 }
  ] }]
}
```

仅明确需要改 Prompt 时，先用 import/blank-input 获取 inputs 并保存为本地请求草稿；只改 `prompt.positive`／`prompt.negative` 中需要调整的字段，其他导入字段原样保留，通过 `inputs` 创建。输入轴仍可省略。比较同一输入的多个文本版本时复制 input 并赋予不同 id 和 label。不要修改项目页面来制作实验变体，也不得直接改写实验内部快照；已创建实验的修改另建新实验。

## Agent 结果读取、拼图和输入差异

Agent 与网页使用同一个后端。创建、列表、Start、进度和 retry 继续使用上面的接口，
通过 `workbench:api` 调用即可，不另写实验执行脚本。

新增三个 POST 入口，前缀均为 `/api/comparison-experiments`：

- `/review`：按条件返回结果索引、各实验轴定义、数量、状态、错误、图片 URL、绝对图片路径及已有 hash。
- `/sheet`：同样选择结果，导出带条件标签的 PNG 和 `index.json` 来源索引，返回绝对文件路径。
- `/diff`：选择恰好两个 cell，比较冻结输入，返回 JSON Pointer 路径及 before/after。

三个入口共用选择格式，支持全局多个实验；按 selections 顺序排列，显式 cell_ids 保留调用者顺序，
省略时使用原实验 cell 顺序。axis_values 按 value_id 精确筛选，可与 cell_ids 同用。
未知 cell、轴值和重复选择报错；未完成项保留，不自动补跑、不自动推断跨实验配对。

```json
{
  "selections": [
    { "experiment_id": "experiment-a", "axis_values": { "seed": "seed-a" } },
    { "experiment_id": "experiment-b", "cell_ids": ["cell-<完整hash>"] }
  ],
  "columns": 3
}
```

```powershell
npm --silent --prefix C:/Workspace/story-canvas/app run workbench:api -- POST /api/comparison-experiments/review --body <请求JSON文件>
npm --silent --prefix C:/Workspace/story-canvas/app run workbench:api -- POST /api/comparison-experiments/sheet --body <请求JSON文件>
npm --silent --prefix C:/Workspace/story-canvas/app run workbench:api -- POST /api/comparison-experiments/diff --body <两个cell的请求JSON文件>
```

`review` 默认只读与网页相同的轻量投影。指定 `include_inputs: true` 才读取并校验冻结执行计划，
返回 Prompt、LoRA、seed、CFG、render identity 和实际 workflow；尚未 Start 的输入为 null。
`diff` 自动读取这些输入；没有冻结计划时拒绝比较。它报告精确差异，包含 workflow 输出命名等变化，
不将“有差异”判断成实验不合格，也不把当前模型文件或当前页面内容冒充历史冻结输入。

`sheet` 的 columns 为 1–6，默认 2；一次 1–36 格，更多结果分批导出。每格图片区域为 512×748，图片保持比例，不裁剪；
文字默认 32px，可用 `font_size` 指定 20–48px；`title` 设置整张图标题。
`labels` 可传与选中结果顺序一一对应的非空字符串数组，为每格设置简短说明，支持换行；
省略时按中文维度名显示条件，Seed 只出现一次，多实验用编号区分，长 ID 保留在来源索引中。
文本按实际字体宽度换行，标签区域自动增高，不缩小字号或截断。
即使自定义标签，未完成状态仍自动附加；`index.json` 保存实际标签、字号、标题和完整原始条件，便于回查。
例如四格图可使用 `"columns": 2, "font_size": 36, "title": "全身 · Seed 20260920", "labels": ["v3 · 不加词", "v3 · 加词", "v5 · 不加词", "v5 · 加词"]`。
失败或未完成位置留空并保留状态标签。读取来源 PNG 时校验已有 hash。
输出位于仓库根 `Saved/comparison-reviews/<随机ID>/`，不进入事实或生成队列，不提交 Git。
Agent 可直接用返回的绝对路径查看拼图；详细条件和 cell 来源保留在同目录索引中。
