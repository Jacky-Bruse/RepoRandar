# /status 命令增强设计

日期:2026-07-07
状态:待用户确认

## 目标

`/status` 从只返回一行统计(运行状态 + 仓库数)升级为:列出每个关注仓库、监控类型(commit / release),以及最近一次 commit / release 的日期。用 Telegram rich message 的 markdown 表格呈现,发送失败时降级为 HTML 分组列表。

## 消息格式

### Rich 表格(首选,markdown)

```
📡 RepoRadar · 运行中 · 3 个仓库

| 仓库 | 关注 | 最近更新 |
|---|---|---|
| asdlokj1qpi233/subconverter | commit | 06-16 |
| openclaw/openclaw | release | v2026.6.11 · 06-30 |
| maillab/cloud-mail | commit + release | 07-03 / v3.0.0 · 05-11 |
```

- 仓库列显示完整 `owner/repo`(用户确认,接受手机端折行)
- 日期为静态文本:当年 `MM-DD`,跨年 `YYYY-MM-DD`
- commit + release 双监控合并一行,更新列格式 `<commit日期> / <tag> · <release日期>`
- 暂停时头部显示「暂停」;`repos` 为空时返回「还没有关注任何仓库,用 /add 添加」(纯文本,不发表格)

### HTML 降级 fallback

`sendTelegram` 现有逻辑在 rich 发送失败时用 `message.text` 重发 HTML,所以 `text` 字段放 HTML 分组列表版本:

```
📡 RepoRadar · 运行中 · 3 个仓库

📦 asdlokj1qpi233/subconverter
   🔀 commit · 最近更新 <tg-time>

📦 openclaw/openclaw
   🚀 release v2026.6.11 · <tg-time>
```

## 数据来源

收到 /status 时实时查 GitHub(用户确认):

- commit 监控 → `GitHubClient.latestCommit(repo, branch)`,取 `date`
- release 监控 → `GitHubClient.latestRelease(repo)`,取 `tag_name` + `published_at`
- 所有仓库的查询用 `Promise.all` 并发,总延迟约等于单次请求
- 单个仓库查询失败(限流、删库)→ 该单元格显示 `⚠ 查询失败`,不影响整条消息
- release 监控但从未发布 → 显示「暂无发布」

## 代码改动(全部在 worker/src/index.ts)

1. 新增 `buildStatus(config, github): Promise<Message>`:并发查询、组装 markdown 表格(richText)+ HTML 列表(text fallback)
2. `applyTelegramCommand(text, kv, github?)` 返回类型 `string` → `string | Message`;`/status` 分支调用 `buildStatus`,其余命令不变
3. `handleFetch` 构造 `new GitHubClient(env)` 传入;`sendTelegram` 已接受 `Message | string`,无需改动
4. 表格单元格内的仓库名 / tag 做 markdown 转义(`|` 等字符)

## 测试

`worker/test/core.test.mjs` 新增:fake GitHub 返回固定 commit/release 数据,断言 `buildStatus` 的 richText 包含表格行、text 包含 HTML fallback、查询失败时单元格为 ⚠。

## 不做的事(YAGNI)

- 不缓存查询结果到 KV(/status 频率低,实时查即可)
- 不分页(仓库数超过表格可读上限时再说)
- 不改推送消息的格式,只动 /status
