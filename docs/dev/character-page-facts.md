# 设定视觉页与文字样式写入

日常命令需要本地工作台服务在线。入口与指纹协议见[Agent 直接操作工作台](../reference/agent-interfaces.md)。

## 统一页面

角色、场景验证页和剧情图片页使用同一页面事实与编辑工作区。`pages/index.json` 保存稳定 page_id、归属和顺序，
`pages/<page-id>.content.json` 保存标题、scene_description、出场角色及文案，Prompt 单独保存。
页面可引用多个角色子设定与一个场景子设定；归属仅在新建时填入默认引用，后续允许删除或替换。
移动归属只改索引；复制生成新 ID，复制内容、Prompt、出处和布局，不复制生成媒体。

完整页面经 `PUT /api/projects/<project-id>/workbench/page-save` 保存，携带内容、Prompt、上游和可选布局／出处指纹。
内容、引用、override、布局和出处先统一校验，再通过同一次提交写入；失败回滚。
新增对白临时 ID 同时映射到正式对白、布局和出处。
失效引用可保留并保存以便修复；切换子设定或移除引用时删除对应 override key。

Agent 内容窄入口使用 `POST /api/agent/facts/page/content|text-sources/read|save`；Prompt 使用统一 `prompt.read/save`，旧 prompt 事实入口返回升级指引。
现有 character:fact 的 page-goal 正文是完整 content，不再保存 visual_goal 文件；page-prompt 已由统一 Prompt 范围入口替代。page-index 只编辑角色归属投影，保留其他归属。

## 创建、模板与删除

统一导航接口 `POST /api/projects/<project-id>/workbench/navigation/create-page` 接收 owner：

- 剧情：`{ owner_kind: "story", sequence_id }`；
- 角色：`{ owner_kind: "character", character_id, variant_id }`；
- 场景：`{ owner_kind: "scene", scene_id, variant_id }`。

模板一次性复制标题、画面说明与当前模型 Prompt，不保留 live template link。
无模板创建最小内容和空 Prompt。文字页仅允许归入剧情单元。

页面删除归档 `pages/<page-id>.{content,prompt,text-sources}.json` 和 `Outputs/pages/<page-id>/`，
同时从索引与对白布局移除。归档位于 `Saved/state/deleted-pages/<project-id>/<deletion-id>/`，记录原归属及相邻页面，
沿用 7 天政策，不提供恢复命令。活动生成和成品输出会阻止删除。

删除角色或场景本身保留所属页面及引用。失效归属显示在待整理页面，内容引用则显示缺失诊断；
用户可以重新归属、替换或移除引用，已有候选继续可读。

## 并发和文字样式

所有事实修改经项目操作边界串行提交，实际执行时核对目标与必要上游指纹。冲突后重新读取和判断，不自动覆盖。
角色文字颜色仍属于项目嵌字设置，与排版预设一起保存到 `lettering/settings.json`。
