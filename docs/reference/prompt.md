# Anima Prompt

日常插画使用 Anima；备用自由文本与参考图路线见 [Qwen](qwen.md)。编写、自动修正与生成规则只维护在 [AGENTS](../../AGENTS.md)，本文维护输入语义。

## 本页与共享词

页面按 `population / person / setting / camera / avoid` 分组，`avoid` 为负向；`population` 只放人数及 solo 控制标签。
词条用 `tag` 或 `description` 二选一，可带权重与开关；字段与写法查 help，不保存词库查询回包。
属于具体角色的本页词须绑定实际引用的 `character_id`；共同关系或匿名人物才不绑定。对白说话人不自动成为入镜角色。
本页词没有持久 ID，分类数组表达顺序；共享基础／子设定词由服务端生成稳定 ID，改文字或排序不改身份。

子设定从基础词加本身词编译；页面再引用当前角色／场景设定。不要将继承词复制成本页词。

- 子设定 `identity_overrides` 用 `identity:<id>`；页面 `inheritance` 按来源分组，以 `identity:<id>` / `variant:<id>` 定位。
- 只覆盖 `enabled`、`weight`；缺省跟随上游，显式值保留，恢复继承删除字段。
- 上游关闭可在下游开启；源词删除后覆盖失效，不能按相似文字重新绑定。
- 删除本页人物词不会移除人物引用；引用通过页面编辑接口修改。
- LoRA 有项目、基础／子设定及本页来源；停用后不编译其调用词。登记与归属见[资源目录](../../library/resources/README.md)。

## 编译与审计

模型专用输入彼此独立，页面选择活动模型；共享质量词等来自 render profile，不在页面复制。
编译使用当前引用、继承调整、本页词与有效配置，保留来源；同一编译入口供查看、审计及任务冻结使用，不在出图时调用 LLM。
实际配置以 `library/render-profiles/anima-base-v1.json` 及所引资产为准，执行契约见[生成实现](../dev/render-plan.md)。

Anima 审计检查词条格式、权重、标签及分类、人数矛盾、重复与正负冲突；错误阻断新采样，警告不等于错误。
Danbooru 标签须命中固定词库，Artist 标签禁止；自由描述不是标签清单。标签查询和维护见[词库](../../library/prompt-dictionaries/README.md)。
草稿允许带审计错误保存；保存成功不代表生成许可。看 `audit.status` 及实际 `errors / warnings / diagnostics`，后续生成重新审计。
非活动模型保存不冒充已完成该模型审计；不可获得配置或上下文时，先处理诊断。

## 范围编辑

```powershell
node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs help prompt.read
node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs help prompt.read fragments
node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs help prompt.save person_groups
```

读写回执与并发纪律见[Agent 接口](agent-interfaces.md)。页面默认读活动模型；角色／场景指定模型及基础或单个子设定范围。
`document` 不带整个 `models` 容器，保存只提交当前范围的 `changes`。数组完整替换，保留未改项；新增共享词省略 ID。
`person_groups` 可只替换指定人物的本页词，未绑定组用 `character_id:null`；组内不重复写绑定，不与 `person` 同时提交。

按需用 `prompt.sources` 查可覆盖的继承源；查询新增依赖指纹合并到原保存参数，不替换目标指纹。
`prompt.context` 只读排查最终输入；`enabled` 不等于最终 `consumed`，以实际编译判断。展开结果不能写回。
候选匹配、清理和成品引用见[页面操作](visual-pages.md)。
