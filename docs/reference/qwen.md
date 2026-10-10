# Qwen 备用生成与训练环境

Qwen 文生图及参考图生成都是备用路线；主线见[Prompt](prompt.md)和[页面](visual-pages.md)。LoRA 训练仍是主线，通用流程见[LoRA 训练](lora-training.md)。本文只维护 Qwen 专用事实。

## 输入与参考图

每页分别保存模型专用 Prompt；Anima → Qwen 首次带入有效正向文字，此后独立编辑，可显式重新带入。
Qwen 使用自由文本：

- `settings` 组合全局文字、角色、场景、附图用途和本页描述；`standalone` 使用本页全文及附图，不追加共享设定或全局文字。
- 子设定各有完整文字与有序参考图；`prompt_name` 与显示名称独立。
- `text_overrides` 整段覆盖引用文字；缺省跟随，空串也生效，恢复继承删除 key。
- `reference_overrides` 缺省选首张，空数组停用，显式 ID 列表固定选择与顺序。文字覆盖不改变选图。
- 切换／移除引用时清理对应覆盖，残留 key 拒绝保存。
- 本页附图独立持有，`purpose` 可选；未填仍传图。

传图顺序为角色 → 场景 → 本页附图，合计最多 10 张，超限阻断。无图文生图，有图参考图；画布尺寸仍来自本页配方。
参考图保存到项目 `materials/`，替换保留 ID；被页面手动引用的设定图不能直接删除。候选提升为素材后独立保存。
页面文字、选图和附图随草稿保存，设定参考图即时保存；写入见[Agent 接口](agent-interfaces.md)。

## 编译与冻结

编译确定性拼接，不调用 LLM：全局 `prompt.text` → 按出场顺序角色 → 场景 → 有用途附图 → 本页描述；空段省略。
单图说明用“参考图”，多图按最终顺序用 `<imageN>`；编号由编译器生成，不手写到共享设定。
负向恒为空，否定句当普通文字；LoRA 需匹配模型家族，使用公共登记与加载契约。
缺失引用／图片、错误覆盖、图片超限或空最终文本阻断生成；草稿可保存，保存成功不等于审计通过。
任务冻结参考图前按 EXIF 转正、最长边限制 1536、转换 PNG，记录内容与 SHA-256；排队后改素材不改变任务输入。
生成文件、采样和工作流身份以 `library/render-profiles/qwen-image-2-1.json` 及所引 recipe/workflow 为准，不复制默认参数。

## 手动文本改写

现有“优化”按钮保留：保存后将编译正向交给本地 PE-T2I `TextGenerate`，不传参考图、不看生成结果；与 Agent 根据图像错误修正 Prompt 不同。
优化正文单独保存，用户选择原文或优化稿；传图用途与顺序由工作台拼接。源文字、画幅或参考图变化标为过期，仍可使用；画幅建议不自动改画布。
本机 `prompt_rewrite` 需配置 `model`（`text_encoders` 下 PE 权重名）和 `system_prompt`（官方 t2i 系统提示词文件）；节点需 `CLIPLoader/TextGenerate/SaveText`，缺失只禁用改写。

## 训练环境

当前新训练使用固定身份 DiffSynth-Studio，源码及独立 `.venv` 放工具仓库外；本机 `lora_training.diffsynth.trainer_root/python` 记录实际路径。

| 依据 | 内容 |
|---|---|
| `library/lora-training/diffsynth.json` | commit、源码归档校验、Python 与运行身份 |
| `app/python/diffsynth.lock` | 精确依赖；源码另以 `--no-deps -e` 安装 |
| `library/lora-training/qwen-image21-models.json` | BF16 分片、processor/tokenizer 的身份；生成 INT8 不能代替训练权重 |
| `library/lora-training/recipes/qwen-image21-lora-v1.json` | 有效语义和冻结注入层 |

先取得固定源码并校验，按清单 Python 建环境；已有环境不重复创建，路径从配置读取：

```powershell
uv pip sync --python <训练Python绝对路径> C:/Workspace/story-canvas/app/python/diffsynth.lock --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match
uv pip install --python <训练Python绝对路径> --no-deps -e <训练器绝对路径>
uv pip check --python <训练Python绝对路径>
```

Windows Triton 必须匹配锁定 PyTorch，不能只通过 import 或 help 宣称可训练。
正式执行由 `app/python/qwen-image21-lora-runner.py` 缓存及训练，不运行上游示例自行下载权重。模型及配套文件放[模型目录](setup.md#模型目录规范)，不留训练器默认 `models/`。
输入与编译入口为 `app/server/models/qwen/prompt-contract.mjs`、`app/server/models/qwen/prompt-compiler.mjs`；公共执行见[生成实现](../dev/render-plan.md)。
