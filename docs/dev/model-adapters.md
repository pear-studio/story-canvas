# 模型适配器

StoryCanvas 仍是独立的 Node + React 应用。当前内置 Anima Basic 与 Qwen-Image-2.1，
不支持 Anima Aesthetic；没有外部插件加载器，也没有 NAI 云端执行器。

## 页面事实和操作

- `project.json` 的格式为 `story-models-v1`，画幅和 default_render_profile 只作为新页默认。
- `pages/<id>.render.json` 保存 `{version:1, model_id, profile_id, canvas}`。
  创建时复制；调整项目默认不改变已有页。复制页面保留完整 render 和各模型输入。
  文件缺失时报错，不从项目默认回退。
- 工作台新选项统一为竖幅 3:4（960×1280）、方形 1:1（1024×1024）、横幅 4:3（1280×960）。
  新项目默认竖幅；两模型的候选配方使用相同尺寸，切换模型不改变像素大小。
  页面、项目默认和对比实验共用 `app/shared/canvas-presets.json` 中的选项，测试核对候选配方与其一致。
  已保存的 2:3／9:16 仍可读取与生成，选择器仅展示当前原值并允许改选三种新画幅；不自动改写已有项目。
- Prompt 文件为 `{$schema, models:{anima:…, qwen:…}}`，可以只有一个模型输入。
  日常文件读写不接受裸模型输入；模型分派后编译和范围编辑只消费单模型输入。
  页面操作的模型来自 render，设定操作显式指定模型；公共层不默认 Qwen。
  切换不会清空另一份输入；首次 Anima → Qwen 复制有效正向全文，之后只在用户点击重新带入时更新。
- Anima 原词条组件、词库、分类规则、机位和逐词继承由适配器复用。
  角色/场景缺少 Anima 输入时，可在设定页明确创建；不从 Qwen 自由文本猜测分类词条。
- Anima 本页词条无持久 ID；共享词保留稳定 ID，继承定位由 `identity:`／`variant:` 加 ID 组成。
  `identity_overrides` 和页面 `inheritance` 逐字段保存显式覆盖，不再按正文匹配，也不使用 `identity_disabled`。
  网页临时行 ID 不进入页面文件；共享词的 ID 由服务端分配，修改与排序时保留。
- Agent Prompt 读写由 `prompt-scope.mjs` 按页面模型、设定基础或单个子设定收窄；版本覆盖该范围与必要依赖。
  保存先核验读取版本，再在写锁内合并当前文件，其他模型和子设定不被旧草稿覆盖。
  网页设定页按同样范围保存，整页内容、Prompt、嵌字仍由一个事务提交；新引用必须携带其已读来源版本。
- Qwen `composition:"standalone"` 直接使用全文及本页附图，不追加全局、角色或场景文字。
  Qwen 的 `settings` 组合方式继续保留，与 Anima 一样使用当前模型容器。
- 项目 LoRA 对使用对应 profile 的全部页面实时生效；Anima 角色／场景的 `identity.lora`
  由子设定继承，子设定 `loras` 可以追加或按 filename 替换。页面自动继承当前引用的有效 LoRA。
  子设定和页面用 `lora_overrides:{"filename":{"weight":0.8,"enabled":false}}` 单独覆盖权重或开关，
  未覆盖字段随上游更新；恢复继承即删除覆盖。页面 `loras` 保存本页新增项或明确的完整替换项。
  同名继承项的文件身份或权重冲突会报错，需要明确处理；停用项及其触发词不进入生成输入。
  工作台把角色／场景 LoRA 放在对应引用 Prompt 内，项目继承列表默认收起。
  Anima 触发词来自合并后启用的列表，不重写词条事实；迁移的 `trigger_sources` 保留旧触发词位置。
- 候选作为参考图保存时复制到项目 materials，持久输入不引用可删除的 Outputs 文件。
- Qwen 的 PE-T2I 优化仍通过 ComfyUI 运行；源指纹包含实际页面配置、画幅与参考图。
  源变化后显示已过期，但仍允许显式选择旧优化稿。建议 wh_ratio 不改变画幅；提交任务冻结用户所选原文或优化结果。
  等待上限为 3 分钟，原状态位置显示排队、加载、优化、保存及已用时间；ComfyUI 提供
  token 计数时直接显示，不按最大输出长度估算百分比。页面每秒串行读取轻量状态，刷新或
  切回页面可继续跟踪，同页运行期间拒绝重复提交。运行状态仅驻留本地服务内存，服务重启
  不恢复优化任务；已保存的优化结果仍是项目事实。进度连接失败不妨碍读取最终结果。

## 接入位置

| 位置 | 模型职责 |
|---|---|
| `app/server/model-adapters.mjs` | 显式注册标识、架构、默认配置、Prompt 校验/准备/编译、profile Prompt 规则 |
| `app/server/models/<model>/` | 模型原生契约和编译，不读写项目或候选 |
| `app/server/model-prompts.mjs` | 模型容器、模型投影和保持其他输入的替换操作 |
| `app/server/prompt-scope.mjs` | Prompt 范围读写、来源查询与窄范围版本检查 |
| `app/shared/prompt-inheritance.mjs` | 稳定继承定位、显式字段覆盖及共享词条持久化 |
| `app/server/page-render-settings.mjs` | 本页设置、首次初始化、显式重新带入及并发检查 |
| `app/src/models/registry.tsx` | 显式注册 PageEditor、SettingEditor、OverviewEditor |
| `app/src/models/<model>/` | 模型专用交互；宿主传草稿和 onChange，不在编辑器直接写页面文件 |
| `app/src/models/qwen/usePageRewrite.ts`、`RewritePanel.tsx` | Qwen 优化的状态、请求与界面；hook 驻留页面工作区，切标签继续跟踪，公共宿主使用所选 Prompt 来源与完成后的预览刷新回调 |
| `library/render-profiles/`、`render-recipes/`、`workflows/` | 模型资源、配方与 ComfyUI 工作流契约 |

公共页面解析器选择适配器，冻结 Prompt、LoRA、参考图及生成配置后才进入队列。
候选展示不依赖编辑器；公共详情显示最终正负 Prompt、模型、尺寸和配方证据。
新增本地模型需要新增原生模块、两处注册、资源与 schema，并验证保存、切换、编译和冻结任务。
当前实际执行器仍是 ComfyUI；未来 NAI 应另外实现服务提供方执行适配，不能伪装成 ComfyUI workflow。
暂不为尚未接入的云端服务增加账户、计费、重试或插件宿主。

## Anima 一次恢复

仅恢复指定的旧 Anima Basic 项目，不提供 Qwen 项目迁移。
`GET /api/projects/<id>/model-migration` 在一致性读取内返回 dry-run 指纹、待写文件和逐页等价证据。
`POST` 提交 `{fingerprint}`，同时携带刚读取的 `x-story-canvas-expected-revision`。
服务在写锁内重新规划，拒绝目标变化或活动任务，并先把原始字节备份到项目旁
`<项目>.before-models-<时间>-<标识>/`；随后原子写入并读回核对。
不通过日常读取静默升级。迁移只改变生成事实，不删除候选，不触及训练项目。

验收先运行完整测试、`test:anima-ui` 和 `test:prompt-ui`，再以临时项目检查真实工作台切换和生成。
迁移后用真实页面 resolver 逐页核对正负 Prompt 和有效 LoRA，不能只检查迁移函数自身的内存结果。
