# 新建项目

日常命令需要本地工作台服务在线，无需打开网页。统一入口、返回结果和并发语义见[Agent 直接操作工作台](../reference/agent-interfaces.md)。


项目创建使用无状态 template/create 入口：

```powershell
npm --prefix <仓库根>/app run project:create -- template <project-id>
npm --prefix <仓库根>/app run project:create -- create <完整草稿JSON文件|->
```

template 返回 `{ project_id, document }`，不创建目录。document 只包含：

- `metadata`：项目标题、画幅和默认 render profile；
- `lettering_settings`：统一的字体、字号、文案框预设和角色颜色；
- `outline`：不带 `$schema` 胶水的 synopsis、chapter 和 sequence；
- `characters`：最小角色 profile、视觉描述和可选 variants。

Agent 修改 document 后，把完整对象通过 JSON 文件或 stdin 交给 create。服务端补齐 Schema，为角色的每个 variant 建立
空文本、空参考图的 Prompt 配置；创建文件未提供 variant 的角色自动补一个 `{id: "default", name: "默认"}`
子设定，并原子发布完整项目目录。统一 pages/index.json 与 scenes/index.json 初始为空；source 索引、创作约定
和对白布局使用空文档。入口不接受页面、Prompt、候选、图片、`adaptation.md` 或其他项目
路径，因此不会复制另一个项目中的临时判断。

省略实际内容时，template 提供满足 outline 契约的明确“待补充”骨架；Agent 可以在写入前完整替换 outline 和
characters。新增角色不能在创建文件里提供 Prompt，它在后续使用窄写入入口。

create 发布前完整校验输入和所有项目事实。项目 ID 已存在时拒绝覆盖；验证或发布失败不留下半成品项目。
草稿属于调用者，服务不创建 sidecar、不登记会话、不消费或删除输入文件。
