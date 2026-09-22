# StoryCanvas

StoryCanvas 是由 Agent 操作的本地系列图片视觉化工作台。输入可以是完整故事、角色设定与
主题清单或一句简要需求；输出以全页插画序列为主，页面可以有对白、旁白或没有文字。

外部 Agent 负责理解来源、整理角色和分页、维护视觉页面，并操作本机 ComfyUI。用户在浏览器
中查看和调整当前项目事实、Prompt、候选、嵌字预览以及生成与评估任务。

## 当前能力

- 一个本地 Node.js 服务同时提供 React 工作台和受限项目 API；
- 项目材料、创作约定、角色设定、角色视觉页和章节化剧情分页；
- 剧情页与角色页共用完整 `PageKey`、视觉 token、Prompt、候选、Seed 和精修；
- 按生成配置确定性编译 Prompt，并诊断 checkpoint、风格 LoRA 和角色 LoRA；
- 本机 ComfyUI 候选生成、整图派生、增量精修、任务恢复和跨项目队列；
- 用户评估与独立 Agent 候选评估，以及受控 Prompt 差分任务；
- 项目操作执行已由 `app/server/project-operations.mjs` 统一实现，覆盖事实读取、事实写入、事实派生、
  本机派生、revision 并发保护、项目复制/重命名生命周期和项目移动保护；媒体流在项目操作完成后发送；
- 剧情文案和文字布局的服务端 PNG 预览。当前不合成或导出正式带字成品。
- 当前项目的 Qwen-Image-2.1 LoRA 训练任务、不可变 run 快照、停止与续训、checkpoint
  标记、预览和比较矩阵；训练环境仍由 Agent 显式安装。

## 快速入口

| 你想做什么 | 阅读或使用 |
|---|---|
| 第一次启动或了解当前能力 | [从这里开始](docs/start-here.md) |
| 不确定一个故事项目从哪里开始 | `project-orientation` |
| 了解统一创作方法 | [创作指南](docs/creative/guide.md) |
| 建立或调整故事粗骨架与角色 profile | `story-direction` |
| 把当前 sequence 拆成页面并调整 narrative | `story-editing` |
| 从用户验收页面提炼可复用解法 | `story-craft-review` |
| 制作一批剧情页或角色视觉页 | `visual-production` |
| 探索画风、角色形象或其他主观方向 | `visual-exploration` |
| 验证动作、Prompt 或生成参数/技术方案 | `generation-testing` |
| 安装或诊断 ComfyUI | [环境搭建](docs/reference/setup.md) |
| 准备或分析 LoRA 训练 | `lora-training` 与 [LoRA 训练](docs/reference/lora-training.md) |
| 理解项目文件和 Git 边界 | [项目文件](docs/reference/project-files.md) |
| 参与开发 | [开发文档导航](docs/dev/README.md) |

## 最快启动

```powershell
npm --prefix <仓库根>/app ci
npm --prefix <仓库根>/app run setup
npm --prefix <仓库根>/app run doctor
npm --prefix <仓库根>/app run dev
```

打开 `http://127.0.0.1:3000`。不连接 ComfyUI 也可以编辑项目事实和预览 Prompt。

## 仓库结构

```text
story-canvas/
├─ app/                 本地网页应用、服务端、脚本和测试
├─ docs/                中文使用、流程与开发文档
├─ library/             Schema、模板、生成配置、工作流和资源目录
├─ Config/              本机配置与项目路径登记，不入 Git
├─ workspace/           工作台临时项目，不入 Git
└─ Saved/               可清理的运行数据、对比实验与 Agent 临时工作
```

正式剧情项目与训练项目放在工具仓库外，各自独立本地 Git。工作台通过本机登记打开项目，提供临时复制与提升。训练项目包含素材、唯一当前配置和多轮历史记录；详情见[本地项目管理](docs/reference/local-projects.md)。
