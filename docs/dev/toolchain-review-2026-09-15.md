# 工具链复盘 · 2026-09-15

> 本文是当日的历史问题与处理记录，命令和能力不作为当前操作契约；日常入口见[Agent 接口](../reference/agent-interfaces.md)。

sigrid 文案仿写收尾那次会话中暴露的工具链问题与处理状态。只记录会话中有实际证据的
问题，不含推测。定位问题用到的命令都附在条目里，可复现。

## 已处理

### 1. 读取不存在的页面返回 500，而不是 not_found

格式合法的页面 id 但页面不存在时，服务端返回 `internal_error` 500：

```
node app/scripts/story-page.mjs narrative read sigrid page-ffffffffffff
→ {"error":"internal_error","message":"internal_error","status":500}

node app/scripts/story-page.mjs narrative read sigrid page-ZZZ
→ {"error":"invalid_story_page_id","status":422}   # 格式非法反而分得清
```

**影响**：会话中把一个字符打错（`page-c6f79d9932d7`，实际是 `page-c5f79d9932d7`），
报错看起来像服务端故障，先重试了一次才想到核对索引；又因为出错时 stdout 为空，
管道里的 `JSON.parse` 先抛 `SyntaxError`，把真实错误盖了一层。

**与既有约定的偏离**：仓库其他地方对"找不到"都给专属 404
（`candidate_not_found`、`character_not_found`、`lora_training_run_not_found`），
只有 story page 的读取路径漏了。

**建议**：在 `app/server/story-facts.mjs` 的读取路径补 `story_page_not_found`（404），
与既有 `*_not_found` 约定对齐。

**处理（2026-09-16）**：已实施，但根因与建议都有修正。实际根因是 `readStoryFactDraft`
先走 `realpath` 边界检查，对不存在的文件抛裸 ENOENT，被兜底成 500，盖住了后面本来就有的
`story_edit_file_missing`。现在读取路径先 lstat，缺失返回 `story_page_not_found`；
状态码取 422 而非 404 —— story-facts 域内 `*_not_found` 都走 FactError 默认 422，
404 是 lora/candidate/page-render 等其他域的约定。已补测试，`npm test` 568 项全过，
并重启工作台后用 CLI 端到端验证。另外"管道里 `JSON.parse` 抛 SyntaxError"与状态码无关：
错误 JSON 本就走 stderr、退出码 1，stdout 为空是设计使然，管道消费者应检查退出码。

### 2. `save` 支持 stdin，但没有一处文档提到

`app/scripts/workbench-client.mjs:37` 有 `if (source === "-")` 分支，说明
`story-page.mjs narrative save -` 可以从 stdin 读，完全能 `read | 改 | save -`
一条管道做完。但：

- `app/scripts/story-page.mjs` 的用法串只写 `save <JSON文件|->`，没有解释 `-`；
- `docs/` 下没有任何 `save -` 的示例。

结果是两轮会话都落盘 `Saved/Tests/pNN.json` / `pNN-src.json`，累计 **128 个**临时文件。
代价：每页多一次落盘、`git status` 被污染、提交时要手工排除路径
（本次提交用 `git add -A -- library workspace start-remote-workbench.sh` 绕开）。

同源的还有一个用法串问题：用法串只写了 npm 形式 `story:page -- <kind> ...`，
直接 `node app/scripts/story-page.mjs -- narrative read ...` 会因为 argv 里多一个 `--`
而报用法错误。

**建议**：在 `docs/dev/story-facts.md` 补一条 `read | patch | save -` 的管道示例，
并说明直接调 node 时不要带 `--`。

**处理（2026-09-16）**：已实施。`app/scripts/story-page.mjs` 用法串说明 `-` 表示 stdin、
直接 node 调用不带 `--`；`docs/dev/story-facts.md` 补了 `read | 修改 | save -` 管道示例
和 stderr/退出码约定。

### 3. `Saved/Tests/` 不是项目认定路径，但两处提及容易被误读

`docs/dev/guide.md:35` 和 `app/vite.config.ts:11` 都把 `.temp` 和 `data.local`、
`runtime` 并列。但 vite 配置写的是按**目录名**排除的 glob：

```ts
ignored: ["data.local", "../Saved/Tests", "Saved"].flatMap((d) => [`**/${d}`, `**/${d}/**`]),
```

它匹配任何位置叫 `.temp` 的目录，并没有认定 `Saved/Tests/` 这个具体路径。
`.gitignore` 里 `data.local/`、`Saved/`、`dist/`、`coverage/` 都忽略了，
`.temp/` 没有被忽略；`git log --all -- app/.temp` 为空，从未进过版本管理。

项目真正认定的运行产物目录是 `app/Saved/`（`/app/Saved/` 在 `.gitignore` 里，
结构见 `docs/dev/architecture.md:224-227`），而 `architecture.md:351` 明确
「`Saved/` 只保留应用自己的日志和状态」——Agent 的草稿也不属于它。

**影响**：读到 guide.md 那行会误判 `Saved/Tests/` 是项目约定的临时目录
（本次会话就这样向用户陈述过，被用户纠正）。

**处理**：已删除该目录下 128 个文件（其中约 10MB 的 4 个 `vite-*` 缓存目录是更早的
dev 会话留下的，不是本次产生）。2026-09-16 把 `docs/dev/guide.md` 的 vite 行改为
「按目录名排除，不约定仓库内的具体路径」，消除了误导源；vite 配置本身无害，不动。
需要落盘就用系统 `/tmp`，不要写进仓库。

### 4. 写作政策文件名与内容相反

`library/writing-policies/copy-from-corpus.md` 的内容曾整个翻成「仿写语料，不照抄」，
但文件名仍是 `copy-from-corpus`，被 `docs/dev/story-facts.md:21`、
`docs/reference/project-files.md:60` 和 `:78` 引用。

**处理**：用户已自行重写该文件为「后期文案优化与语料参考」，口径改为
「语料只供措辞、语气和节奏参考，不要求照抄」，文件名保留以维持现有引用。
不再需要改名。

### 5. 记忆文件 frontmatter 被改坏

改 `sigrid-park-training-roster.md` 的 `description:` 时用了过短的匹配串，
把整行粘成一行。已自行读回修正。

## 本次会话的其他状态（供接手参考）

- sigrid 全库 114 页的 `text-sources` 已归零；代码里的 text-sources 机制仍在，
  `docs/dev/story-facts.md` 与 `docs/reference/project-files.md` 对它的描述仍准确。
- 旁白覆盖率：`collapse` 1/7、后记·调教 0/25。用户明确不补，是刻意留白。
- `page-9ff317d6a472` 的内心句「会怀上下一个德拉叙尔吗…」是表达手法，不走怀孕线，
  不是伏笔，审校时不要判成与 outline 冲突。
- 相关提交：`5a8724e`（文案仿写收尾，204 个文件，提交前 `npm --prefix app test` 548 项全过）。
