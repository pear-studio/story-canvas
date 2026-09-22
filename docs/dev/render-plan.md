# 渲染计划目标契约

> 状态：普通页面生成的当前入口是 `visual:produce`。`page-render-resolver.mjs` 直接读取当前
> outline、页面 index、页面 Prompt、角色和生成配置，`page-render.mjs` 原子保存完整 `queued` 任务并排队；
> 执行器只按 task ID 加载冻结任务，恢复不再读取当前项目、profile、recipe 或 override。
> 当前格式的 profile、独立 recipe、workflow manifest、逐条目 `render_route` 与项目
> sparse override 已经落地。冻结任务契约 Module 会一次性校验这些身份、Prompt 审计、route/registry
> 与 execution unit；最终 ComfyUI workflow 与输出映射已经按执行单元冻结，
> 执行器不再解析 route、recipe 或 modifier。当前可用行为以[架构](architecture.md)、
> 现有 Schema、代码和测试为准。

对比实验使用独立的 manifest、轴、预检、API、UI 和结果存储，不把对比轴混入普通候选任务。
它的 preflight 与普通页面生成共同消费 `compilePageRenderTarget(PageKey)`：直接按当前页面 index、
narrative 或角色页 goal、页面 Prompt、角色配置和有效生成配置冻结 target hash。完整 PageKey 必须精确
匹配 Owner；不会建立中间页面格式，也不会从裸 page ID 猜测对比实验目标。

冻结执行单元的输出现在由 `render-media.mjs` 的 output adapter 统一描述和解析。candidate 策略会
冻结候选 storage、输出 kind、稳定 `candidate_id`/`file` 以及可选 promotion；PNG 的 `extra_pnginfo`
也从同一 descriptor 生成。执行时仍会逐段检查项目内路径、父目录链接和 descriptor 与任务条目的身份
一致性，再进行完整性检查和下载。comparison 使用自己的执行计划、独立输出和串行 runtime，不在通用 ComfyUI
submit/collect 循环中添加分支。

本文把生成配置、工作流和项目调整收拢到一个可验证的渲染计划编译入口。目标不是
增加配置层数，而是把当前混在 `render_profile`、服务端预检和执行脚本中的职责拆成可复用事实，
最后只产生一份完整执行结果。

## 设计约束

- 一个项目只选择一个基础 `render_profile`，不建立 profile `extends` 或多层继承。
- 项目只保存一层稀疏调整，不保存基础配置全量副本。
- 可复用资产通过引用组合；不同资产不能用“后者覆盖前者”的方式解决重名，语义 ID 冲突直接报错。
- 每个可调整集合项必须有稳定语义 ID；模型按角色、operation 按名称、输入来源按名称、LoRA 按稳定
  ID 定位，全局文字按 `prompt.text` 定位，不允许用数组下标作为调整目标。
- 工作流节点绑定只存在于 workflow manifest；生成配置和执行器不再各保留一份绑定。
- 能力由 operation 路由、workflow manifest 和 modifier 配置推导，不再维护独立
  `capabilities` 布尔值。
- 所有生成入口使用同一个编译结果和诊断。冲突或错误统一阻止生成，不允许执行器猜测、降级或
  静默跳过已启用输入。
- 项目调整用原值判断冲突，不为每个调整字段另存 hash。模型等可复用资产仍在自身事实中保存
  必需的精确身份 SHA-256；任务快照另外冻结配置源文件和实例化结果的 hash，保证恢复
  与复现。

## 可复用事实

### 全局 Prompt

每个 profile 保存一段全局 `prompt.text`，编译时放在各设定文字之前；项目 sparse override 的语义
target 也是 `prompt.text`（整段替换），用户清空时编译直接省略。不再有独立 prompt-policies 文件、
prefix/suffix、分类片段、权重或负向。

### 生成参数

`library/render-recipes/<id>.json` 只保存采样和尺寸参数：

```json
{
  "id": "qwen-image-2-1-candidate",
  "resolutions": {
    "2:3": { "width": 832, "height": 1248 },
    "3:4": { "width": 864, "height": 1152 }
  },
  "steps": 25,
  "cfg": 1,
  "sampler": "euler",
  "scheduler": "simple",
  "clip_skip": 1
}
```

配方不保存 workflow、模型、Prompt 或能力开关。需要不同参数时建立另一个有明确名字的配方；
生成配置只能直接引用 route 所需的一份配方，不再保存候选／最终两套配方或多层合并字段。

### Workflow manifest

每个 `library/workflows/<id>.api.json` 配套一个 `<id>.manifest.json`。当前 Qwen 候选工作流使用
扁平 binding 名称保存固定节点路径，不声明 modifier。以下示例与
`qwen-image-2-1-text.manifest.json` 保持一致：

```json
{
  "id": "qwen-image-2-1-text",
  "template": "qwen-image-2-1-text.api.json",
  "architecture_families": ["qwen-image-2-1"],
  "operations": ["candidates"],
  "input_sources": ["empty_latent"],
  "modifiers": [],
  "bindings": {
    "dit": "1.inputs.unet_name",
    "text_encoder": "2.inputs.clip_name",
    "vae": "3.inputs.vae_name",
    "positive_prompt": "4.inputs.prompt",
    "negative_prompt": "4.inputs.negative_prompt",
    "width": "6.inputs.width",
    "height": "6.inputs.height",
    "filename_prefix": "9.inputs.filename_prefix",
    "seed": "7.inputs.seed",
    "steps": "7.inputs.steps",
    "cfg": "7.inputs.cfg",
    "sampler": "7.inputs.sampler_name",
    "scheduler": "7.inputs.scheduler"
  }
}
```

`bindings` 负责固定值写入；当前 manifest 不声明额外 anchors。manifest 加载时必须验证绑定路径
确实存在于 API JSON，不能等到提交 ComfyUI 后才失败。

### Modifier

modifier 是渲染计划编译模块内部的确定性实现，不为只有一种实现的行为额外建立公开 adapter。
当前 Qwen 候选工作流不声明任何 modifier；负向槽由绑定写空字符串。

workflow manifest 声明它能接入哪些 modifier；生成配置提供风格 LoRA。modifier 不能选择另一份
workflow。

### Render profile

`render_profile` 成为组合入口，直接保存精确基础模型身份、一段全局 `prompt.text`，并引用配方和工作流：

```json
{
  "id": "qwen-image-2-1",
  "name": "Qwen-Image-2.1",
  "architecture_family": "qwen-image-2-1",
  "models": {
    "dit": { "filename": "...", "relative_path": "...", "sha256": "..." },
    "text_encoder": { "filename": "...", "relative_path": "...", "sha256": "..." },
    "vae": { "filename": "...", "relative_path": "...", "sha256": "..." }
  },
  "prompt": {
    "text": "根据以下设定和画面描述创作一幅新画面，动作、表情、视角与构图以画面描述为准。"
  },
  "operations": {
    "candidates": {
      "routes": {
        "empty_latent": {
          "workflow": "qwen-image-2-1-text",
          "recipe": "qwen-image-2-1-candidate"
        },
        "reference_image": {
          "workflow": "qwen-image-2-1-reference",
          "recipe": "qwen-image-2-1-candidate"
        }
      }
    }
  },
  "style_loras": {}
}
```

输入来源为 `empty_latent`（文生图）或 `reference_image`（页面有效参考图）；
参考图冻结与上传约定见 [Qwen 接入](qwen-image.md)。

operation 与输入来源使用固定矩阵，不参与自由优先级竞争：

| operation | 合法输入来源 | 选择规则 |
|---|---|---|
| `candidates` | `empty_latent` | 仅使用文字条件生成候选图 |
| `candidates` | `reference_image` | 使用冻结的有序参考图（最多十张）和文字条件，输出仍遵循项目画布 |

route 不存在时直接报错，不回退到另一来源。结构家族不匹配或 manifest 不支持
实际 modifier 时同样报错。当前 qwen-image-2-1 提供上述两条 route。

## 项目稀疏调整

项目根目录增加 `render-profile.override.json`。一个文件可以按基础 profile ID 保留多组稀疏调整，
切换基础 profile 时只启用同名组，其他组不参与诊断，也不会复制出多份配置文件：

```json
{
  "version": 1,
  "profiles": {
    "qwen-image-2-1": {
      "changes": [
        {
          "target": "operations.candidates.routes.empty_latent.recipe.steps",
          "original": { "exists": true, "value": 25 },
          "project": { "exists": true, "value": 32 }
        }
      ]
    }
  }
}
```

`target` 指向解析后基础配置暴露的语义目标，不指向某个源 JSON 文件，也不使用数组下标。例如：

- `models.dit`；
- `prompt.text`；
- `operations.candidates.routes.empty_latent.workflow`；
- `operations.candidates.routes.empty_latent.recipe.steps`；
- `style_loras.watercolor.weight`；

`exists` 让同一形状同时表达新增、修改和删除；同一 profile 组内一个 target 最多出现一次。解析器只
开放明确可调整的语义目标，配置 ID、结构家族和派生能力等身份字段不能被项目调整。

### 冲突判定

对当前启用 profile 的每项 change，读取当前基础配置中的目标值：

| 当前基础值 | 结果 |
|---|---|
| 与 `original` 相同 | 应用 `project` 值 |
| 与 `project` 相同 | 调整已经被基础配置吸收，视为冗余；允许生成并提示清理 |
| 与两者都不同 | 冲突；显示原值、当前基础值和项目值，并阻止所有生成 |

未被项目调整的目标始终继承当前基础配置。基础配置只改变其他目标时不产生冲突。Agent 解决冲突
只有三种明确操作：采用基础值并删除 change；保留项目值并把 `original` 更新为当前基础值；重新
编辑项目值并同步更新 `original`。编译器不得在生成过程中自动改写项目事实。

## 渲染计划编译模块

新的深模块以渲染计划作为主要 interface，把当前散落在工作台 readiness、服务端 render 入口和
`render-project.mjs` 中的选择与校验收进同一个 seam。公开入口保持最少：

- `inspectProjectRenderProfile(...)`：供工作台读取有效配置、冗余调整、冲突和静态依赖诊断；
- `compileRenderPlan(...)`：接收项目、生成请求和任务 ID，返回完整可冻结计划，或返回结构化错误。

工作台不能只展示扁平有效值。验收视图应同时表达：基础 profile 与当前项目 override 形成哪些
有效值；每项 override 的原值、当前基础值、调整值及冲突状态；每个 operation 和输入来源实际
引用哪份 workflow 与 recipe；模型、LoRA 和全局文字从哪里进入计划；当前候选最终冻结了哪条
执行链和哪些身份 hash。无冲突时用户能顺着关系定位来源，有冲突时同一位置直接显示
阻断原因和需要处理的调整项，不再让用户比较多份全量配置。

内部按固定顺序执行：

1. 解析基础 profile 及其 recipe、workflow manifest 和 API JSON；
2. 生成解析后的基础配置，检查稳定 ID、重复项、引用、结构家族和 manifest 绑定；
3. 对当前 profile 应用项目稀疏调整并检查冲突；
4. 解析 operation 和 input source，选择唯一 route；
5. 编译并审计 Prompt，解析风格 LoRA；
6. 读取页面 Prompt 与底稿输入，校验页面事实和模型身份；
7. 按 manifest 支持情况应用 LoRA modifier，实例化每个条目的 ComfyUI workflow；
8. 产出完整渲染计划、诊断和来源身份。

缺少必需文件、失效、没有有效绑定或不受当前 workflow 支持的输入都是错误。非阻断 warning
只保留给冗余调整等不会改变执行含义的情况。工作台按钮状态、服务端创建任务和 CLI 直接创建任务
必须调用同一模块；CLI 不再拥有一套较宽松的 warning 后继续路径。

执行器只负责复核模型、提交已经实例化的 workflow、跟踪 ComfyUI、校验输出并更新任务
状态。删除执行器后，工作流选择和兼容性复杂度应仍集中在编译模块，而不是重新散回调用方；这就是
该模块需要提供的深度、杠杆和局部性。

## 任务冻结

任务快照保存：

- 基础 profile ID 与文件 SHA-256；
- 来源 recipe、workflow manifest 和 API JSON 的 ID 与 SHA-256；
- 项目调整文件 SHA-256，以及应用后的完整 effective render profile 和整体 hash；
- operation、input source、route、Prompt 来源、seed、精确模型和 modifier 参数；每条 route 同时
  冻结来源 recipe ID 与按有效参数 canonical SHA-256 标识的 recipe instance ID，recipe registry
  按实例索引，因此同一来源 recipe 经 route-local 调整得到的不同参数可以并存；
- 每个执行单元最终实例化的 ComfyUI workflow、来源身份、canonical hash、batch 条目顺序、输出
  node/index 映射和图片提升声明。

所有结构化整体 hash 使用同一 canonical JSON：对象键按 Unicode 码点递归排序，数组保持原顺序，
数值与字符串按 JSON 编码为 UTF-8，不加入空白；不允许 `undefined`、`NaN` 或无穷值进入待哈希事实。
文件继续按原始字节计算 SHA-256，不经过 JSON canonicalization。

参考图路由的任务同时冻结有序参考图字节与来源；LoRA 超分的素材上传由独立模块负责。

恢复任务只读取快照并复核实际使用的本机模型，不重新解析当前基础配置，也不重新进行
workflow 选择。所有活动执行单元的输入都在 ComfyUI 请求、任务状态和文件副作用前完成复核；批量
单元部分完成时仍按冻结 batch 整体重放，不缩小条目或改变输出索引。项目调整字段本身不保存 hash，
因为其 `original` 已经承担基础变化检测。

## 迁移顺序

1. 先把 profile 读取与验证、workflow 读取收进共享实现，不改变外部数据格式或行为；
   服务端与 CLI 不再各自读取和解释同一批事实。
2. 建立目标 Schema、recipe 和 workflow manifest，迁移仓库内 profile；
   全局文字保存在 profile 的 `prompt.text`，并删除硬编码 `workflowBindings`、`defaults`
   合并和重复 `capabilities` 事实。
3. 让渲染计划编译模块输出完整 task snapshot，再把 LoRA 输入和最终 workflow 实例化全部移入
   编译阶段；服务端和 CLI 共用同一个 seam。
4. 增加项目稀疏调整 Schema、受 expected revision 保护的写接口和工作台编辑/冲突展示；把当前跟踪项目迁移为
   无调整或明确调整事实。
5. 用目标契约测试保护 profile 组合、冲突真值表、route 选择、manifest 绑定、modifier 兼容、
   模型身份校验、计划确定性和任务恢复；最后执行完整测试与当前项目验证。

这是一次仓库内直接契约迁移。迁移完成后删除旧字段和旧路径，不长期保留双读、双写或 legacy
adapter；少量现有项目事实由一次性脚本或 Agent 明确修复。
