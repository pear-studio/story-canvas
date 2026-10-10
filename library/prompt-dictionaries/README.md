# 词库维护

固定上游快照加本地 overlay；应用离线读取，启动和生成不联网同步。
词库帮助检索，不决定模型输入契约，不改写项目 Prompt 或冻结任务。

## 文件与合并

| 文件 | 事实 |
|---|---|
| `a1111-tagcomplete.json` | 标签快照来源、校验值和更新规程 |
| `danbooru.csv`、`zh.csv` | 上游标签与中文译名快照 |
| `wiki.json`、`wiki-metadata.json` | 原站完整正文、别名及同步身份 |
| `overlay.json` | 以原始标签为键的本地译名、分类、关键词和可选中文正文 |

上游快照整体更新，不手改；本地增强只写 overlay。
overlay 覆盖显示译名，分类和关键词加入搜索；有用的旧译名需显式放入关键词。
原始标签及原站别名保留。正文显示优先 overlay 中文说明，再用 Wiki 原文；原文独立保留。
本机配置 `prompt_dictionary.tags_file` 时不叠加仓库 overlay，避免词名不匹配。

## 标注原则

- 依据标签原义、别名和 Wiki 判断可见画面含义，优先使用通行中文术语；疑难词先核实来源。
- 一个标签选择一个简短译名，不用并列候选或占位文字代替选择。
- 分类允许多选，关键词允许相关上位词、子类词；删除无关或实质误导的表达。
- 中文正文填写时完整翻译原文，保留段落、链接目标和图例引用，不添来源没有的设定。
- 原站 `other_names` 已参与搜索，不复制到关键词。正文不作为关键词搜索内容。

overlay 字段类型、关键词限制与分类值域以 `app/server/prompt-dictionary.mjs` 的验证器及常量为准。
词库分类与页面可写分类不同；模型语义见 [Prompt](../../docs/reference/prompt.md)。
不存在的标签、未知分类及类型错误会阻止加载；合并前检查 JSON 重复键，解析后的对象无法发现它们。

## 维护入口

```powershell
node C:/Workspace/story-canvas/app/scripts/dictionary-lookup.mjs --top 500 --out C:/Workspace/story-canvas/Saved/Agent/dictionary-reference/top500.json
node C:/Workspace/story-canvas/app/scripts/dictionary-lookup.mjs --words <词表绝对路径> --out <参考JSON绝对路径>
node C:/Workspace/story-canvas/app/scripts/dictionary-wiki-sync.mjs
```

lookup 返回原始标签、频率、译名、别名、Wiki 与当前 overlay，供本次词库维护查阅。
Wiki 同步默认续传或增量；`--full` 全量遍历，`--max-pages <数量>` 限制本次批数。
中途进度在 `Saved/dictionary-wiki/`；完整遍历后才替换正式快照，失败不能记为无 Wiki。
Wiki 更新不自动改中文译文。维护素材和中转规则见 [AGENTS](../../AGENTS.md)。

分类变化时一起更新查询常量、overlay 和相关测试，不留迁移层。
验证入口为 `app/tests/prompt-dictionary*.test.mjs` 与 `dictionary-wiki-sync.test.mjs`；
结构校验不能代替译义核对。
