# 全局对比工具

顶部名称菜单进入；不依赖当前项目。它持有独立输入和成果，不修改项目页面或登记候选。
用户明确要比较时使用，核对比较内容与生成数量；少量结果不能证明稳定性。

## 输入与运行

- 从页面一次性导入有效输入，或选择 profile 建立空白输入；仅明确比较 Prompt 时才改文本。
- 创建时冻结输入、配置、LoRA 和参考图；开始后不读取来源项目或当前配置。
- 轴按笛卡尔积展开；核对创建回执的 cell 数量后启动。
- 修改方案另建实验；补跑沿用冻结计划，只执行未完成格子。
- 与候选共用生成队列，逐格执行；失败保留已完成成果。
- 同种子不保证构图一致，同时改变多个因素只代表组合差异。

## Agent 入口

```powershell
node C:/Workspace/story-canvas/app/scripts/story-canvas.mjs help comparison
```

`comparison.blank/import` 获取真实输入，按当前比较目标修改副本后 `comparison.create`；不要重建输入结构或工作流。
创建只预检，不运行模型；用 `comparison.inspect` 核对，再 `comparison.start`，失败补跑用 `comparison.retry`。
参数与可用轴查操作 help，保存和长任务纪律见[Agent 接口](../reference/agent-interfaces.md)。

## 查看与清理

`comparison.review` 汇总状态、条件和结果路径；需要冻结输入时显式读取。
`comparison.sheet` 返回 PNG 拼图及索引，`comparison.diff` 比较两个冻结 cell；筛选与顺序显式指定，不自动推断配对。
拼图一次最多 36 格；结果图用 `comparison.image` 读取，不扫描目录猜文件。

输入与成果在根 `Saved/comparison-results/`，状态在 `Saved/comparisons/`；导入中转和拼图分别在 `Saved/comparison-imports/`、`Saved/comparison-reviews/`，均可清理。
活动实验先 `comparison.cancel` 并等待终态，再 `comparison.delete`；接口清理实验派生物，不涉及来源项目、模型权重或训练数据。
