# 项目文件

Agent 日常操作需要本地工作台服务在线；命令与 API 统一说明见[直接操作入口](agent-interfaces.md)。

本页说明项目中的持久事实、本机派生结果和 Agent 写入边界。字段级契约以
`library/schemas/` 与当前代码为准。

## 项目目录

```text
<正式剧情项目目录>/
├─ project.json
├─ creative-agreement.json
├─ render-profile.override.json
├─ materials/
│  └─ index.json
├─ characters/
│  ├─ index.json
│  └─ <character-id>.{profile,visual,prompt}.json
├─ scenes/
│  ├─ index.json
│  └─ <scene-id>.{profile,visual,prompt}.json
├─ pages/
│  ├─ index.json          # 全局页面 ID、归属与顺序
│  └─ <page-id>.{content,prompt,text-sources}.json
├─ story/
│  └─ outline.json
├─ lettering/
│  ├─ settings.json
│  └─ dialogue-layouts.json
├─ finished/<page-id>.json   # 当前成品制作记录，进入 Git
├─ Outputs/               # 长期保留的本机成果，不入 Git、不随项目复制
│  ├─ pages/<page-id>/<candidate-id>/
│  ├─ finished/<page-id>/<output-id>/ # clean.png、lettered.png
├─ Saved/                 # 运行状态、工作副本、缓存、临时文件
│  ├─ render/
│  ├─ cache/
│  └─ staging/
├─ .gitignore
└─ .gitattributes
```

项目由 `Config/projects.json` 显式登记，ID 是本机接口句柄，目录可以在工具仓库外。项目之间不建立文件引用。对比实验位于工具 `Saved/comparison-results/`，执行状态在 `Saved/comparisons/`，拼图在 `Saved/comparison-reviews/`。参见[本地项目管理](local-projects.md)。

## Agent 临时工作

Agent 临时工作统一位于仓库根 `Saved/Agent/<任务名>/`，同一任务复用目录，容纳临时脚本、素材中转、API 请求与回包及临时审阅页，不进入 Git。`Saved/Tests/` 仅供应用、测试和工具自动生成临时文件，不作为 Agent 手工工作目录。正式素材导入数据集或项目材料，正式生成成果保留在系统管理的 `Outputs/`；临时目录在任务结束并核对依赖后清理。

## 全局文案资产（library/）

- `library/writing-corpus/<源>/原文/` 保存文案改写的参考语料（小说原文 txt），是**参考输入**，
  进 Git；`.gitattributes` 对 `library/writing-corpus/**` 设置 `-text` 冻结字节，
  text-sources 的字节偏移依赖语料字节不变；
- `library/writing-policies/` 保存跨项目的文案方法文档（如 `copy-from-corpus.md`），
  story-editing 技能引用；
- 语料检索用 `app/scripts/corpus-search.mjs`（`corpus:search`），输出语料相对路径与字节偏移，
  供 text-sources 映射使用。

## 持久事实

- `project.json` 保存 `format`（剧情项目必填 `story-free-text-v1`，旧格式项目不能打开）、标题、画幅和默认 render profile；
- `creative-agreement.json` 保存用户确认的项目级创作约定；清单保持扁平，每条明确为必须遵守或创作偏好；
- `materials/` 保存用户提供的原文与参考材料，只容纳一层纯文件（不支持子目录），目录中的实际文件会自动进入参考材料清单；
  `materials/index.json` 仅保存可选显示标题，不表达登记状态或阅读顺序；
- `story/outline.json` 保存 synopsis、chapter 与 sequence 粗骨架，不包含分页；
- `pages/index.json` 把页面有序归入剧情单元、角色子设定或场景子设定；每页 content 保存标题、`scene_description`
  （简单白描的客观画面内容）、画面角色和文案；画面内容不超过 20 字，
  按创作规范填写，空白或超长不阻止保存、生成；结合情节单元和前后页理解，Prompt 单独保存；
  文字页额外带 `page_kind: "text"`、`body` 正文（可空）、独立显示标题 `display_title`（缺省为空）与 `text_layout`（独立字号、对齐和整组位置），无角色和文案，不生成候选图；
- 每页 text-sources 保存文案条目的语料出处映射（dialogue_id → 语料文件、字节偏移、原句），
  是可选的参考索引：无条目即自写，heart 条目不挂出处；保存时服务端按偏移核验出处真实存在，
  不做相似度校验；方法见 `library/writing-policies/copy-from-corpus.md`；
- `characters/index.json` 保存角色顺序；每名角色的 profile、visual 与 Prompt 分开保存；
- 三种归属的图片页共用标题、画面内容、角色引用、场景引用、Prompt、候选与嵌字能力；页面归属只负责组织；
- `scenes/index.json` 保存场景顺序；各场景拆分 profile、visual 和 Prompt，与角色共用同一设定契约；
- `lettering/settings.json` 统一保存项目字体、字号、文案框预设（角色对白/心理/NPC）和角色显示颜色；
  `lettering/dialogue-layouts.json` 只保存逐页对白位置与尺寸；旁白使用通栏字幕条（按页选顶部或底部），不保存布局；
训练也是独立项目：`project.json` 保存素材组织，`assets/` 保存图片与 Caption，`captioning/` 保存审核事实，`settings.json` 保存唯一当前训练设置（Qwen-Image-2.1，version 5）；这些内容进入该项目 Git。`Training/` 保存历史冻结输入、恢复包和结果，`Saved/` 保存缓存及执行副本，均不入 Git。

角色与场景 `*.prompt.json` 形状为 `{ prompt_name, variants }`：`prompt_name` 是编译输出的名称，
创建时复制显示名称、之后独立；每个 `variants.<id>` 自包含一段自由文本 `text` 和有序
`reference_images`（条目为 `{id, file, title}`），子设定之间互不继承，也没有 identity 层、LoRA
或逐词继承。角色至少一个 variant（禁止删除最后一个），全部同构、无保留 id、无默认造型。
页面 Prompt 保存本页 `text`、成对的 `scene_id`/`scene_variant_id`、按 `character:<id>:<variant>`／
`scene:<id>:<variant>` 键的整段 `text_overrides` 与图片选择 `reference_overrides`，以及可带
`purpose` 的本页附图 `reference_images`；key 存在即覆盖（含空串），恢复继承就是删除 key，切换
子设定或移除引用时删除对应 key。具体规则见 [Prompt 契约](prompt.md)。
visual 只维护子设定 id/name；所有视觉页通过 content 编辑标题与 scene_description。

outline、profile、narrative、visual 和 Prompt 之间是单向引用关系。上游变化可以使下游出现诊断；
语义内容由下游责任 Agent 重新读取并修正；页面的整段 override 不随上游文字变化，已有候选图片不改变。

## 读取与写入

Agent 可以直接读取稳定项目 JSON，但不得直接写入。准备修改时先通过 read 获取正文和指纹：

```powershell
npm --prefix <仓库根>/app run story:page -- outline read <project-id>
npm --prefix <仓库根>/app run story:page -- index read <project-id>
npm --prefix <仓库根>/app run story:page -- narrative read <project-id> <page-id>
npm --prefix <仓库根>/app run story:page -- text-sources read <project-id> <page-id>
npm --prefix <仓库根>/app run story:page -- prompt read <project-id> <page-id>

npm --prefix <仓库根>/app run character:fact -- profile read <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- visual read <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- prompt read <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- page-index read <project-id>
npm --prefix <仓库根>/app run character:fact -- page-goal read <project-id> <page-id>
npm --prefix <仓库根>/app run character:fact -- page-prompt read <project-id> <page-id>
```

read 返回 `{ project_id, target_id, document, expected_sha256, expected_context_sha256 }`。
只修改 document，身份和指纹保持读取时的值；将完整对象通过普通 JSON 文件或 stdin 交给 save。

```powershell
npm --silent --prefix <仓库根>/app run story:page -- narrative save <完整草稿JSON文件|->
npm --silent --prefix <仓库根>/app run character:fact -- visual save <完整草稿JSON文件|->
```

服务不管理草稿文件，不创建 sidecar。局部 outline 对象和只读上下文范围见[Agent 接口](agent-interfaces.md)。

busy 是短暂资源锁冲突，可以短暂退避后有界重提。目标、必要
上游或编辑依赖的内容指纹冲突表示事实已经改变，必须丢弃旧判断，重新 read 当前正文和指纹并判断，不能拿旧文件自动覆盖。

创建、删除对象使用语义命令维护文件配对；现有页面排序与归属通过 index/page-index save 或导航命令调整：

```powershell
npm --prefix <仓库根>/app run story:page -- page create <project-id> <sequence-id>
npm --prefix <仓库根>/app run story:page -- page delete <project-id> <page-id>
npm --prefix <仓库根>/app run character:fact -- character create <project-id> <character-id> [name]
npm --prefix <仓库根>/app run character:fact -- character delete <project-id> <character-id>
npm --prefix <仓库根>/app run character:fact -- page create <project-id> <character-id> <variant-id>
npm --prefix <仓库根>/app run character:fact -- page delete <project-id> <page-id>
```

服务端为新增页面和新增对白生成 ID；新增对白在临时 narrative 中不得指定 `id`。角色和 variant
使用调用者给出的可读 kebab-case ID。删除归档只用于 Agent 参考重建，不提供恢复命令。

## 渲染与本机派生结果

渲染读取提交时最新的项目事实，不携带项目 revision，也不接受临时 Prompt 或 Seed 覆盖：

```powershell
npm --prefix <仓库根>/app run visual:produce -- render page <project-id> <page-id> [--count 1..3]
```

返回的 `task_directory` 和 `candidate_paths` 是完整绝对路径，Agent 直接按这些路径读取。每个渲染
任务目录包含不可变 `manifest.json` 与可更新 `state.json`，并按活动或终态位于
`Saved/render/active/` 或 `Saved/render/history/`；状态更新通过 `Saved/render/locks/` 中的本机
跨进程锁串行完成。渲染任务、
候选、缓存和输出是本机派生物，不写回故事 JSON。普通原型保留全部候选供用户查看，不由 Agent 筛选或自动删除。用户明确要求清理时使用以下入口；生成与一次严重问题修正规则见创作指南：

```powershell
npm --prefix <仓库根>/app run visual:produce -- candidate delete <project-id> <page-id> <absolute-candidate-path>
```

Agent 没有批量清理入口；用户在浏览器中预览候选并调整文字样式。成为后续必须依赖
的生成图片应先提升到 `materials/`。

## 新建项目与 Git

新建项目使用：

```powershell
npm --prefix <仓库根>/app run project:create -- template <project-id>
npm --prefix <仓库根>/app run project:create -- create <完整草稿JSON文件|->
```

创建文件只接收 metadata、粗 outline 和最小角色事实；不会接收页面、Prompt、LoRA、候选、图片
或旧项目路径。服务端补齐空的 Prompt 配置与页面索引。

正式项目各自独立 Git，工具仓库不提交项目内容。工作台新建或复制到 `workspace/` 的临时项目不建立 Git；提升到外部目录后初始化。设置、原文、参考图、Caption 和训练素材进入项目 Git；`Outputs/`、`Training/`、`Saved/` 与权重不提交。

项目复制与 Git 上传不携带生成结果：复制只保留项目事实和输入白名单，候选、输出、任务、缓存不复制；Git 忽略规则保持这些派生目录不入库。需要跨项目或跨机器保留的生成参考图须先提升为明确输入。

## 成果与清理

页面 PageKey 统一为 `{ page_id }`，字符形式 `v3/<page-id>`。归属保存于 `pages/index.json`，
不参与页面身份和媒体路径；移动归属不改画面引用、候选或成品。创建角色／场景验证页时默认引用所属子设定，之后可以移除或替换。

角色或场景删除后保留页面和引用；归属失效的页面进入待整理入口，内容引用失效显示可修复诊断。
已有候选仍可查看；只有实际参与生成的依赖失效时才阻止生成。

每个候选目录包含 `image.png`、小型 `result.json` 和按需读取的 `generation.json`。
先在 Saved/staging 准备全部文件，再原子发布目录，最后更新运行状态。列表、数量、详情和删除
从 generated 读取。清理任务历史不影响成果；任务仍活动时禁止删除候选及其页面或所引用角色。
generation 保存完整冻结任务快照及实际提交的 workflow/extra_data/prompt_id，历史未记录的请求明确
标为 unavailable。result 保存图片与 generation 的 SHA-256，清理前校验成果字节。

比较实验保留 manifest、preflight、execution、result 摘要及每个 results/<cell-id>/ 的图片与生成记录。
训练 run 在 `Training/<task-id>/<run-id>/` 保留 manifest、`inputs/` 冻结图片与 Caption、`resume/` 恢复包
和 result.json；`Saved/Training/<task-id>/<run-id>/` 保存缓存、控制文件、status、事件与日志等可清理
工作副本。归档 manifest 中的绝对路径是执行证据，不随本机配置变化重写。
外部权重缺失只影响可用性，不擦除历史 checkpoint 清单。

用户明确要清理时，先停止 Node 服务及其他项目写入者，再执行：

```powershell
npm --prefix <仓库根>/app run project:storage -- clean-runtime <project-id> --offline
```

没有活动任务且成果已归档才允许清理 Saved；不动 Outputs、项目事实、根 Saved/state 或外部权重。

复制项目按事实目录白名单保留材料、训练数据和设置，不复制 .git、generated、runtime、密钥和权重。
Git 独立管理项目事实；项目 .gitattributes 对 materials/** 设置 -text，训练项目 .gitattributes 对 assets/** 设置 -text，保护原文和
Caption 的字节身份。当前使用普通 Git，不引入 LFS。

成品制作记录、替换与导出规则见 [成品输出](../dev/finished-pages.md)。
