# 创作入口

通用创作、确认、修正与交付规则只维护在 [AGENTS.md](../../AGENTS.md)。

## 按任务读取

| 任务 | 必要上下文 | 操作入口 |
|---|---|---|
| 故事与 seq 调整 | 用户来源、当前 outline、相关角色 profile | `story-editing` |
| 分页与跨 seq 重组 | 当前段落及邻接段落摘要、涉及页面 content、文案和必要图片 | `story-editing` |
| 角色／场景子设定 | 当前设定、最近的可复用子设定、必要参考图 | `story-editing`，出验证图用 `prompt-authoring` |
| 页面 Prompt 与出图 | 已确认画面、实际入镜角色／场景、当前 Prompt 和生成配置 | `prompt-authoring` |
| 最后统一文案优化 | 当前页面内容、说话人、必要角色背景与相关语料 | `story-editing` |

故事判断先理解 synopsis、相关 chapter/seq 摘要，再读本次涉及页面；机械操作只读保证操作正确所需的事实。不因工具支持某能力而自动增加任务步骤。

## 专项参考

- [页面操作](../reference/visual-pages.md)：候选、动态页、嵌字、成品。
- [Prompt](../reference/prompt.md)：日常 Anima 输入与模型编译语义。
- [Qwen](../reference/qwen.md)：备用生成和模型专用说明，按需读取。
- [项目文件](../reference/project-files.md)：项目目录、资料归属、Git。
- [对比工具](../dev/comparison-experiment.md)：用户要求比较时使用，不设独立可靠性验证流程。

语料用于措辞、语气和节奏参考，不照搬情节，不要求原句重合或出处映射。检索用 `corpus:search` 指定语料所属项目，读命中上下文后组织符合当前页面的文字。
