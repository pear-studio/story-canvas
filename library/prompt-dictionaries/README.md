# Prompt 词库快照与语义叠加层

本目录是固定版本的 Danbooru 标签与中文翻译快照，以及本地语义增强叠加层（overlay）。
应用直接读取，不在启动或生成时联网更新。

## 文件

| 文件 | 性质 | 说明 |
|---|---|---|
| `a1111-tagcomplete.json` | 清单 | 快照来源、取得日期、文件校验值与更新政策；校验值由测试复核 |
| `danbooru.csv` | 上游快照 | 四列 A1111 Tag Autocomplete 格式：标签、来源类型、post 数、别名 |
| `zh.csv` | 上游快照 | 两列格式：标签、中文翻译；覆盖约 2.5 万常见词 |
| `wiki.json` | 原站说明快照 | 按原标签保存完整 `body` 和 `other_names`，不翻译、不摘录 |
| `wiki-metadata.json` | 来源与同步清单 | 原站接口、页面 ID、原文更新时间、抓取状态、覆盖统计与校验值 |
| `overlay.json` | 本地叠加层 | 中文译名、可选中文说明、分类、搜索关键词；键为 `source_text` |

上游快照按清单更新规程整体替换，不在快照内手工修改。本地增强只进 `overlay.json`，
加载时叠加合并，不写回源文件。

## 原站 Wiki 同步

`wiki.json` 每个标签对应 `{ "body": "完整原文", "other_names": ["其他名称"] }`。
`body` 原样保存原站 DText 正文，包括段落、关联标签、链接和图例引用；不抓网页导航、
评论或历史版本，不下载图片。`other_names` 是原站维护的其他名称，独立参与搜索，不复制进
overlay 的 `keywords`。Wiki 正文及中文正文均不进入关键词搜索。

```powershell
# 首次全量抓取；中断后默认续传；已有完整快照时默认增量更新
node app/scripts/dictionary-wiki-sync.mjs

# 显式重新遍历（也可用于词表变化后重建）
node app/scripts/dictionary-wiki-sync.mjs --full

# 只取两批，保存进度供下次续传，暂不发布正式文件
node app/scripts/dictionary-wiki-sync.mjs --max-pages 2
```

使用官方 `/wiki_pages.json` 批量 API，每批最多 1,000 条，按 `page=a<ID>` 顺序取下一批，
游标取本批最大 ID；批内结果可以倒序，不能用最后一条 ID 当续传位置。持续请求间隔至少
1.1 秒，使用明确的 User-Agent；限流和暂时网络错误有界重试，403 等拒绝访问不自动重试。
后续增量使用 `search[updated_at]`，从上一轮开始时刻获取变更，覆盖上一轮遍历期间的编辑。

同步遍历原站 Wiki，在本地按 `danbooru.csv` 的全部标签匹配，不限于 overlay 的 20,000 条。
成功取得空正文但有其他名称的页面仍保留。只有遍历结束后，未匹配或原站已删除的页面才记为
`no_wiki`；成功获取的页面记为 `fetched`。失败不会冒充“原站没有说明”。

`wiki-metadata.json` 的 `entries` 保存各标签的 `page_id`、`updated_at`、`checked_at` 和状态，
删除记录额外保存 `is_deleted`；原站链接按顶层 `page_url_template` 和页面 ID 生成。
`sync` 保存同步范围、起止时间、游标和批次数；`summary` 保存覆盖统计。Wiki 正文校验值
和 CSV 校验值用于复核快照及同步范围。

抓取中的整批数据和失败记录保存在被忽略的 `Saved/dictionary-wiki/checkpoint.json`。
每批原子保存进度；只有完整遍历后才替换正式的两个 Wiki 文件。日常页面读取、审计和生成
不联网。更新 Wiki 不自动改写中文译文；翻译修订与独立审核仍通过 overlay 完成。

## overlay 词条字段

每条键是 danbooru 原始标签名（`source_text`），值是对象：

```json
{
  "rain": {
    "translation": "雨",
    "categories": ["setting", "tone"],
    "keywords": ["雨", "下雨", "雨天", "雨夜", "天气", "潮湿"]
  }
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `translation` | 是 | 中文翻译，每条必写；zh.csv 仅作生成时的参考，overlay 值合并时优先。每条只保留一个确定的中文译名，不写 `A/B`、`A 或 B` 或多个并列译名。译名要简短、自解释且避免过度口语化或解释性长句（halterneck → "挂脖式上衣"而非"挂脖式"；`ear_piercing` → "耳洞"；`extra_ears` → "额外耳朵"）。这里的“一个译名”可以是短语，不要求只能有一个汉字。已有且大众熟悉的术语可以保留，即使不是最字面的翻译（如“绝对领域”“阿嘿颜”） |
| `description` | 否 | 完整中文说明译文，填写时须为非空字符串；保留原文段落与标签、链接、图例引用。未翻译时省略，不填占位说明或摘要；该字段只覆盖读取与展示，不改写 Wiki 原文 |
| `categories` | 是 | 非空数组，值域为页面 11 类 + 角色 7 类（见下）；一个词可挂多类 |
| `keywords` | 是 | 数组 0~10 个，小写；以召回优先，允许适度宽泛、近邻和子类词，多搜出相关候选优于漏掉候选。仍不得加入明显无关、语义相反或会把词条指向另一对象的词；英文仅限中文难以覆盖的别名或常用概念，与别名重复的不得写入 |

### 标注质量标准

本词库用于文生图 Prompt 搜索与编写，主要面向二次元插画及相关作品。译义以 Danbooru 标签
所描述的可见画面为准，结合原始标签、别名、原站定义与图例判断，不按普通词典或软件界面
逐词直译。优先使用通行的二次元中文术语；作品、人物、服装变体与角色扮演对象应保留区分。
同形词要区分画面主体、动作、身体状态、镜头和构图，`style` 表示画风，`cosplay` 表示角色扮演。
语境只能帮助判断，不能代替疑难标签的来源核实；原站已标歧义或仍无法确定含义的词应列待查。

overlay 是面向中文搜索和分类建议的语义增强层，不追求把每个词条解释成唯一、最窄的学术定义。当前覆盖固定快照中的高频 20,000 条，审核优先保证可发现性和基本语义正确。

- 翻译只在明显指向错误对象、错误数量或错误状态时作为高优先级问题；大众化、行业化或约定俗成的译名不因不够字面而强制替换。
- 翻译必须选择一个最终译名。可使用短语，但不得在同一字段并列多个候选译名，也不得用斜杠、括号或长句把选择留给用户。
- 关键词允许宽泛。只有明显无关、语义相反或会造成实质误导时才建议删除；相关的上位词、子类词和常见联想词可以保留。
- 分类允许多选，以同时支持页面和角色作用域的搜索为目的。除非分类与词义明显不相容，否则不为了减少数量而机械删分类。
- 审查区分“确定错误”和“风格偏好”：确定错误应修复，风格偏好只在批量整理时作为可选建议，不阻塞扩展。

## 分类值域

值域的事实来源是 `app/server/prompt-contract.mjs` 的 `PAGE_PROMPT_CATEGORIES`（页面 11 类）
与 `CHARACTER_PROMPT_CATEGORIES`（角色 7 类）。分类调整时先改代码常量，再按下方重组流程更新 overlay。

### 页面分类

| 分类 | 判定标准 | 示例 |
|---|---|---|
| `entity` | 画面主体：人物、生物、物体本身 | sword、cat、fire |
| `appearance` | 主体外观与表情：身体特征、面部状态 | blonde_hair、blue_eyes、blush、smile |
| `action` | 动作与互动 | running、hug、holding、sitting |
| `setting` | 场景与环境：地点、天气、时间背景 | rain、classroom、forest、night |
| `layout` | 构图与画面组织：人物构成、空间关系 | solo、duo、multiple_girls |
| `camera` | 镜头与视角 | close-up、from_below、depth_of_field、wide_shot |
| `lighting` | 光线与光源 | backlight、sunset、lens_flare |
| `tone` | 氛围与情绪基调 | dark、gloomy、scary、peaceful |
| `effects` | 视觉特效与粒子 | motion_blur、speed_lines、sparkles、smoke |
| `misc` | 难以归入以上：媒介、画风、元数据 | watercolor、monochrome、absurdres |
| `avoid` | 通常作为负面词：质量问题、签名水印 | lowres、bad_anatomy、extra_fingers、watermark |

### 角色分类

| 分类 | 判定标准 | 示例 |
|---|---|---|
| `identity` | 整体身份与气质 | 1girl、knight |
| `hair` | 发型与发色 | blonde_hair、ponytail、twin_tails |
| `face` | 面部与五官 | blue_eyes、blush、smile |
| `body` | 身体形态与比例 | tall、petite、muscular |
| `clothing` | 服装 | dress、uniform、shirt |
| `accessories` | 配饰 | hair_ornament、earrings、glasses |
| `equipment` | 装备与道具 | sword、gun、shield |

同一词在页面与角色语境下可以分属不同分类（sword 在页面是 `entity`，在角色页是 `equipment`），
多分类即为此而设。判定有歧义时优先放语义更具体的分类，可用多分类表达重叠。

## 加载合并顺序

1. 基础：`danbooru.csv` + `zh.csv` 构建词条（翻译取 zh.csv，缺省用标签名）
2. 叠加：overlay 词条覆盖同名基础词条——`translation` 覆盖显示翻译，`categories` 与 `keywords` 并入搜索索引。保留原标签及其原始别名；不再自动索引被覆盖的 CSV 译文及别名译文，避免旧错译继续误召回。有用的中文同义词应明确写入 `keywords`
3. 未进 overlay 的词保持上游行为不变

有效说明取 `overlay.description`，没有则使用 `wiki.body`；API 同时保留 `original_description`
原文，中文说明不覆盖该字段。候选和已添加标签均返回分类、关键词、标签别名与原站其他名称。
原站 `other_names` 在有无 overlay 时均参与别名搜索，选中结果仍写入规范英文标签。
搜索候选右侧的频率按钮打开该词详情，F1 打开当前候选；已添加标签保留说明入口。
详情按词条信息、中文说明（有译文时）、原文说明的顺序展示，原文始终放在最后。
界面保留原文标记和换行，不自动加载图例。
浏览器缓存随 Wiki 文件变动刷新；渲染审计仍只用 CSV 判断标签身份和允许类别，说明更新
不改变冻结生成配置的词库身份。

overlay 加载时校验未知分类值、引用不存在的 `source_text` 和字段类型错误，
任一失败即明确报错，不静默忽略。原始 JSON 的重复键在批次合并前检查，不能依赖
`JSON.parse` 之后的对象校验发现重复键。

overlay 按 `source_text` 关联上游快照。当本机 `Config/local.json` 配置了
`prompt_dictionary.tags_file` 本地覆盖时，不叠加 overlay（本地词库可能与快照词名不符，
校验无法通过）；默认配置只含 `preset`，使用仓库快照并叠加 overlay。

## 分类调整时的重组

分类是演化中的契约，调整时按以下顺序一次性完成，不留迁移框架：

1. 改 `prompt-contract.mjs` 的对应分类常量与审计逻辑
2. 由 Agent 按新值域重组 overlay：批量移动、拆分或合并词条的 `categories`
3. 同步本文件的分类表与示例
4. 运行词库与审计相关测试

重组依据词条规律批量操作，逐条人工确认只用于少数歧义词。

## 标注与审查流程

当前 overlay 已覆盖取词脚本选出的高频 20,000 条 General 词条；覆盖条数不代表语义审核完成。
修订与补充词条时使用脚本准备参考数据：

```bash
# 取 general 类型按 post_count 降序的前 N 个词
node app/scripts/dictionary-lookup.mjs --top 500 --out Saved/Agent/dictionary-reference/top500.json

# 按指定词表输出参考（用于补标项目已用词）
node app/scripts/dictionary-lookup.mjs --words Saved/Agent/dictionary-reference/words.txt --out Saved/Agent/dictionary-reference/ref.json
```

参考 JSON 每词含 `source_text`、`post_count`、`provider_type`、`zh`（zh.csv 已有翻译，仅供参考）、
`aliases`、当前 `display_text`／`prompt_text`、Wiki 原文 `body`、`other_names`、有效说明
`description` 及 `description_language`（`zh` 或 `original`）。缺失的正文返回 `null`。

正式流程不限定模型类型或推理强度，按用户要求和当前可用能力选择。标注由 Agent 分批完成，
审核由另一名独立 Agent 完成；修订者与审核者可以使用同一模型。主会话负责整合、结构校验
和最终落盘 `overlay.json`。标注与审核 subagent 必须自行读取规则文档、当前 `overlay.json`、
上游参考和批次文件，主会话只传递文件路径、批次范围和任务要求，不在 prompt 中手工复制大段
候选内容。标注结果与审核结果通过被忽略的临时批次文件交接，不把未审核草稿写入 canonical
`overlay.json`。

标注和审核不要求逐条追求最窄译义；以翻译单一、语义基本正确、关键词召回充分和分类可用为
验收标准。用户不逐条抽查，但可以在会话中查看汇总（如被本地改写的翻译清单）。

修订按互不重叠的词表并行，翻译、分类和关键词一起复核；发现词族错误时扩查同类条目。
占位译文不得合并，纯英文只作待审提示，数字、缩写和合理专名可以保留。疑难词记录待查原因，
不编造译名，也不以自动扫描未命中代替逐条语义审核。审核结果关联精确草稿版本，修改草稿后
重新审核；主会话只合并已通过的改动，核对批次覆盖、重复键、原条目是否变化及字段结构。
验收同时报告实际审核条数、修复条数、待查项和正式词库中文搜索结果，结构测试不替代内容审核。

遗留的“词条xxx”占位应清理为原始标签显示，并移除占位关键词；仍保留待查记录，不计为中文
翻译完成。出图试验只能反映当前模型对标签的表现，不能代替原站定义来确定标签词义。

### Wiki 正文翻译

中文说明须逐段覆盖原文的定义、限制、易混词区别、示例说明和相关说明，不以摘要代替正文。
保留标题层级、链接目标、外部 URL 和帖子／媒体／合集引用。正文行文中承载含义的英文标签
使用 `[[原始目标|中文显示名]]`，原目标的大小写与空格保持原样；“另见”标签列表、符号标签和
专有名称可以保留英文。原文没有的年龄、动机、非自愿关系或模型生成效果不得加入译文。

译名、分类、关键词和正文一起审核；已有合理译名可以保留。独立审核关联草稿文件的准确
SHA256，改稿后重新审核。结构验证同时核对链接及图例引用，语义完整性仍由审核者逐条确认。

人数标签使用 `population`；`entity` 仅为词库检索分类，不是页面可写字段。页面中人物/生物相关词按语义放 person，环境物体放 setting。
