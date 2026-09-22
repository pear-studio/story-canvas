---
name: story-editing
description: 为 StoryCanvas 设计单元分页草案，用户确认后维护页面顺序、画面与基础文案；文案优化按用户后续要求单独处理。
---

# 单元分页与文案

按 docs/creative/guide.md 读取当前单元上下文、用户内容与基础文案，补读相关角色配置。维护 story/pages/index.json 与 narrative；不代写角色配置或 Prompt。

## 先提交草案

草案列页数、顺序、每页基本画面、用户基础文案分配和简短机位建议。机位建议用简短语言表达，供用户判断整组变化；不把机位塞进 scene_description。用户修改确认后执行，不自行从草案进入生成。

只展开已有故事事实，允许普通姿态、表情、视线和静态时刻的变化。同一情节可以多图呈现，不机械要求每页推进剧情；普通动作可省略过程。发现需要改变原因、结果或关系时回到故事讨论。

## 落实确认稿

scene_description 简短白描，不超过 20 字的创作规范保留，不作为保存门槛。characters 只列实际入镜且参与编译的人物及明确 variant_id；画外 speaker 不自动入镜。

基础文案原样放入对应页，不润色、不扩写；缺失或分配疑问在草案中指出。新增对白不指定 ID，已有对白保留 ID，避免破坏排版引用。字段和文案类型见 docs/reference/visual-pages.md 与 docs/reference/project-files.md。

新建、删除使用语义入口，顺序与 narrative 使用 read/save；具体命令见 docs/reference/agent-interfaces.md。保存警告不等于保存失败，应读取结果后判断，不重复提交。

文案优化是后期独立任务：可以参考语料，不要求照抄或记录出处映射。方法见 library/writing-policies/copy-from-corpus.md。不要以优化文案为由修改用户原文、画面或重新生成。

交付当前草案或实际修改；不默认扩展页数、制作后续单元或启动候选验收链。
