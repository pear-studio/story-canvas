# 模型适配器

StoryCanvas 仍是独立的 Node + React 应用。当前内置 Anima Basic 与 Qwen-Image-2.1，
不支持 Anima Aesthetic；没有外部插件加载器，也没有 NAI 云端执行器。

## 页面事实和操作

- `project.json` 的格式为 `story-models-v1`，画幅和 default_render_profile 只作为新页默认。
- `pages/<id>.render.json` 保存 `{version:1, model_id, profile_id, canvas}`。
  创建时复制；调整项目默认不改变已有页。复制页面保留完整 render 和各模型输入。
- 工作台新选项统一为竖幅 3:4（960×1280）、方形 1:1（1024×1024）、横幅 4:3（1280×960）。
  新项目默认竖幅；两模型的候选配方使用相同尺寸，切换模型不改变像素大小。
  页面、项目默认和对比实验共用 `app/shared/canvas-presets.json` 中的选项，测试核对候选配方与其一致。
  已保存的 2:3／9:16 仍可读取与生成，选择器仅展示当前原值并允许改选三种新画幅；不自动改写已有项目。
- Prompt 文件为 `{$schema, models:{anima:…, qwen:…}}`，可以只有一个模型输入。
  切换不会清空另一份输入；首次 Anima → Qwen 复制有效正向全文，之后只在用户点击重新带入时更新。
- Anima 原词条组件、词库、分类规则、机位和逐词继承由适配器复用。
  角色/场景缺少 Anima 输入时，可在设定页明确创建；不从 Qwen 自由文本猜测分类词条。
- Qwen `composition:"standalone"` 直接使用全文及本页附图，不追加全局、角色或场景文字。
  已有 Qwen 的 `settings` 组合方式继续保留；本轮不迁移 Qwen 项目。
- 本页 LoRA 是当前模型输入的 `loras` 数组，提供添加、启停、权重、移除。
  新建输入从配置一次复制，不再隐式叠加角色 LoRA。Anima 的非空 trigger 在编译时注入，
  不重写词条事实；迁移的 `trigger_sources` 保留旧触发词位置。
- 候选作为参考图保存时复制到项目 materials，持久输入不引用可删除的 Outputs 文件。
- Qwen 的 PE-T2I 重写仍通过 ComfyUI 运行；源指纹包含实际页面配置、画幅与参考图。
  建议 wh_ratio 不改变画幅；提交任务冻结用户所选原文或重写结果。
  等待上限为 3 分钟，原状态位置显示排队、加载、重写、保存及已用时间；ComfyUI 提供
  token 计数时直接显示，不按最大输出长度估算百分比。页面每秒串行读取轻量状态，刷新或
  切回页面可继续跟踪，同页运行期间拒绝重复提交。运行状态仅驻留本地服务内存，服务重启
  不恢复重写任务；已保存的重写结果仍是项目事实。进度连接失败不妨碍读取最终结果。

## 接入位置

| 位置 | 模型职责 |
|---|---|
| `app/server/model-adapters.mjs` | 显式注册标识、架构、默认配置、Prompt 校验/准备/编译、profile Prompt 规则 |
| `app/server/models/<model>/` | 模型原生契约和编译，不读写项目或候选 |
| `app/server/model-prompts.mjs` | 模型容器、模型投影和保持其他输入的替换操作 |
| `app/server/page-render-settings.mjs` | 本页设置、首次初始化、显式重新带入及并发检查 |
| `app/src/models/registry.tsx` | 显式注册 PageEditor、SettingEditor、OverviewEditor |
| `app/src/models/<model>/` | 模型专用交互；宿主传草稿和 onChange，不在编辑器直接写页面文件 |
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
