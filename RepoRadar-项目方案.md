# RepoRadar 项目方案 v3

> 监控 GitHub 开源仓库的 commit 与 release 动态,通过 Telegram Bot 推送美观直观的通知消息。
>
> v3 变更:状态模型下沉到仓库×监控器维度、明确事务边界与至少一次语义、冷启动粒度细化、配置语法统一、commit 增量改用 compare 端点、补充 release 404 等边界处理、明确 digest 与 rich_messages 的交互规则。

---

## 一、项目背景与目标

关注若干第三方开源项目的更新动态(新提交、新版本发布),无需手动刷新 GitHub 页面,由定时任务自动检测变化并推送到 Telegram。

**核心目标:**

- 自动监控多个 GitHub 仓库的 commit 与 release
- 监控能力可插拔,配置极简
- 推送消息格式美观、信息密度高、手机端一屏可读
- 零成本或极低成本运行

---

## 二、整体架构

监控对象是**第三方仓库**,无法配置 Webhook,采用轮询方案:

```
定时触发 (Actions cron / Workers Cron Trigger)
        │
        ▼
读取配置(仓库 × 触发模式 × 过滤规则)
        │
        ▼
各监控器调用 GitHub API(带 ETag 条件请求)
        │
   304 未变化 ──► 跳过,不消耗配额
        │
   200 有变化 ──► 与状态对比,产出事件
        │
        ├─ 整批被 ignore 静默 ──► 直接推进状态(不推送)
        │
        └─ 待推送的事件 ──► Digest 组装 ──► 发送 Telegram
                                    │
                          发送成功 ──► 推进对应仓库状态
                          发送失败 ──► 状态不动,下轮重试
        │
        ▼
持久化状态(commit 回仓库 / 写入 KV)
```

### 事务边界与投递语义(重要)

- **整批被 `ignore` 静默的 commit 批次**:检测到即推进状态,避免下轮重复检测。`ignore` 不做逐条剔除,只判断「本批可见 commit 是否全部命中忽略规则」;若全部命中则整批不推送,否则按原始批次推送
- **待推送的事件**:必须**发送成功后**才推进对应仓库的状态;发送失败则保留旧状态,下轮自动重试,保证不漏报
- **投递语义为 at-least-once**:若发送成功后、状态持久化前进程崩溃,下轮会重复推送一次。方案明确选择「宁可重复、不可漏报」,Actions 场景下不引入幂等键

---

## 三、配置设计

### config.yaml(唯一标准语法)

```yaml
digest: auto       # 摘要合并: auto=多仓库更新时合并 / always=总是合并 / off=各发各的

repos:
  # ── 简写形式:一行一个仓库,适用于 90% 的情况 ──
  vuejs/core: commit                # 有新提交就推送
  rust-lang/rust: release           # latest release 更新才推送
  sveltejs/svelte: commit + release # 两种都要

  # ── 展开形式:仅当需要额外选项时才用 ──
  golang/go:
    watch: commit + release         # 与简写完全相同的取值语法
    branch: release-branch.go1.24   # 可选,仅作用于 commit 监控;不写=默认分支
    ignore: '^(chore|docs):'        # 可选,仅作用于 commit 监控;整批全命中时静默,不逐条剔除

settings:
  max_commits_shown: 2        # 直接展示的提交数,其余进折叠块
  commit_title_limit: 60      # 提交标题截断长度
  rich_messages: true         # 单仓库 Release 独立推送时启用 Rich Messages(见 6.3)
```

**语法规则(共三条):**

1. 触发模式取值统一为三种字符串:`commit`、`release`、`commit + release`,简写的冒号后与展开的 `watch` 字段**完全同一套语法**
2. `branch` 与 `ignore` 天然只作用于 commit 监控(release 无分支、无 message 可过滤),因此不存在选项归属歧义,无需 per-monitor 嵌套配置
3. 加仓库 = 加一行,删仓库 = 删一行,push 即生效

**触发模式语义:**

- `commit`:配置分支(默认主分支)出现新提交即推送;若配置 `ignore` 且本批可完整判断为全部命中,则整批静默并推进状态
- `release`:监控 `/releases/latest` 端点,**latest 变化才推送**(对比 `tag_name`)。GitHub 官方定义 latest = 最新的非预发布、非草稿 release,预发布天然被跳过,无需配置

### 监控器抽象

```python
class Monitor(ABC):
    @abstractmethod
    def check(self, repo: str, mon_state: dict) -> list[Event]:
        """拉取最新状态,与该监控器自己的 mon_state 对比,返回新事件"""

    @abstractmethod
    def format_message(self, events: list[Event]) -> str:
        """将事件渲染为 Telegram 消息"""

MONITOR_REGISTRY = {
    "commit": CommitMonitor,
    "release": LatestReleaseMonitor,
    # 未来扩展: "tag", "issue", "star"
}
```

配置中的触发模式直接映射到注册表;新增监控类型只需实现一个类并注册。

---

## 四、状态模型

状态按**仓库 × 监控器**二级嵌套,每个监控器持有独立的位置标记与 ETag(ETag 是端点级的,单值模型会在 `commit + release` 仓库上互相覆盖导致 304 判断失效):

```json
{
  "vuejs/core": {
    "commit": { "sha": "a1b2c3d...", "etag": "W/\"abc...\"" }
  },
  "sveltejs/svelte": {
    "commit":  { "sha": "e4f5g6h...", "etag": "W/\"def...\"" },
    "release": { "tag": "v5.2.0",     "etag": "W/\"ghi...\"" }
  }
}
```

该结构同时决定冷启动判断的粒度(见 5.1)。

---

## 五、可靠性设计

### 5.1 冷启动静默(监控器级)

判断依据:`state[repo][monitor]` **不存在**即视为该监控器的首轮——首轮只写入当前位置,不推送历史事件。粒度到监控器级意味着:给已有 commit 状态的仓库**新增 release 监控**时,release 同样走首轮静默,不会误推历史 release。

### 5.2 并发保护

```yaml
concurrency:
  group: monitor
  cancel-in-progress: false   # 排队而非取消,保证每轮完整执行
```

### 5.3 单点失败隔离

- 每个「仓库 × 监控器」的检测独立包裹 try/except,单点失败(改名、删库、限流、网络抖动)不影响其他,下轮自然重试
- Telegram 429 响应按 `retry_after` 退避重试,最多 3 次
- 整轮失败时通过 workflow 的 `if: failure()` 步骤推送告警,实现自监控

### 5.4 GitHub API 边界处理

- **force push**:compare 接口对已不存在的旧 SHA 返回 404 → 推送「检测到分支历史重写」提示 → 以当前 HEAD 重置该监控器状态
- **`/releases/latest` 返回 404**:仓库从未发布 release、或只有 prerelease 时的**正常状态**,非错误。状态记为「暂无 release」(`tag: null`)——这本身是一个已记录的合法位置,因此不触发 5.1 的首轮判定;此后 `null → 首个 latest` 视为一次正常的状态变化,**照常推送**(项目的首发版本正是最值得收到的通知,且单个事件不存在刷屏风险)。注意:GitHub 对 404 响应不返回 ETag,这类仓库每轮消耗 1 次配额,无法 304 短路,量级可忽略
- **已知限制**:两次轮询间发布多个 release 时,`/releases/latest` 只反映最新一个,中间版本被跳过——这与「关注 latest」的语义自洽,接受

### 5.5 状态回推冲突

workflow 自身已被 concurrency 串行化,冲突仅来自用户手动 push config 与状态回推的并发。回推前执行 `git pull --rebase`,失败重试一次。

---

## 六、GitHub API 调用优化

### 6.1 ETag 条件请求

GitHub API 支持 `If-None-Match`:内容无变化时返回 **304 且不消耗 rate limit 配额**。ETag 按监控器存取(见第四章状态模型):

```python
mon_state = state.get(repo, {}).get(monitor, {})
headers = {"If-None-Match": mon_state.get("etag", "")}
resp = requests.get(url, headers=headers)
if resp.status_code == 304:
    return []   # 无变化,零配额消耗
mon_state["etag"] = resp.headers.get("ETag")
```

监控几十个仓库、15 分钟一轮的场景下,绝大多数请求都是 304,内置 GITHUB_TOKEN 的 5000 次/小时配额几乎不消耗。

### 6.2 commit 增量:两跳结构(HEAD 检测 + compare)

commit 监控由两跳组成,ETag 明确挂在第一跳上:

**第一跳——HEAD 变化检测(每轮必调,ETag 守卫):**

```
GET /repos/{owner}/{repo}/commits?per_page=1        # 未配置 branch 时
GET /repos/{owner}/{repo}/commits?per_page=1&sha={branch}   # 配置了 branch 时
```

- 不带 `sha` 参数时自动指向默认分支,省掉「先查默认分支名」的额外请求,这是选它而非 `git/ref/heads/{branch}` 的原因
- 6.1 的 ETag 即存取自此端点;304 = HEAD 未动,本轮该监控器直接结束

**第二跳——增量详情(仅 HEAD 变化时调,不走 304):**

检测到新 HEAD 后调 `/compare/{old_sha}...{new_sha}`:

- 单次请求返回精确的 `total_commits`,即使两轮间提交量很大、返回的 commit 列表被截断(上限 250 条),计数依然准确,不漏算
- 消息中「N 个新提交」用 `total_commits`,展示列表取前若干条,其余以「…以及另外 N 条」概括
- `ignore` 与 `total_commits` 的关系:`total_commits` 是权威口径,计数、是否进入推送/摘要、状态推进目标都按 compare 原始批次计算;`ignore` 只决定整批是否静默,不改变计数,也不从展示列表中逐条删除 commit
- 整批静默的判定必须保守:仅当 `total_commits == len(commits)` 且返回的全部 commit 标题都命中 `ignore` 时才静默;若 `total_commits > len(commits)` 表示 compare 列表被 250 上限截断,无法证明整批都应忽略,必须按原始批次正常推送
- compare 页面链接本来就是消息底部的跳转目标,一个端点两用
- 第二跳只在真有更新时发生,配额消耗可忽略

---

## 七、推送消息格式(定稿)

分两个层级:**常规推送与摘要恒用 HTML 实体模式**(轻量、兼容性最好),**仅单仓库 Release 独立推送时启用 Rich Messages**。

### 7.1 Commit 推送模板(HTML 模式)

```html
📦 <b>vuejs/core</b>
🔀 <b>5 个新提交</b>

• <a href="https://github.com/vuejs/core/commit/a1b2c3d"><code>a1b2c3d</code></a> fix: resolve memory leak
• <a href="https://github.com/vuejs/core/commit/e4f5g6h"><code>e4f5g6h</code></a> feat: add defineModel support

<blockquote expandable>• <code>i7j8k9l</code> chore: update deps
• <code>m0n1o2p</code> docs: fix typo
• <code>q3r4s5t</code> test: add watcher cases</blockquote>

🕐 <tg-time unix="1751437800" format="r">2小时前</tg-time>
🔗 <a href="https://github.com/vuejs/core/compare/old...new">查看全部变更 ↗</a>
```

- 仓库名、提交数加粗;短 SHA 等宽字体可点击直达 commit 页面
- 前 N 个(默认 2)提交直接展示,其余折叠在可展开引用块中
- `tg-time` 渲染为相对时间,自动跟随用户时区并随时间刷新
- **不显示分支名**(逻辑层仍按配置分支拉取;当前每仓库仅支持单分支监控,多分支监控为未来扩展特性,届时消息将显示分支名以区分来源)

### 7.2 Release 推送模板(HTML 模式)

```html
📦 <b>rust-lang/rust</b>
🚀 新版本发布: <b>v1.85.0</b>

📝 Rust 1.85.0 stable

<blockquote expandable>Release notes 摘要…</blockquote>

🕐 <tg-time unix="1751400000" format="wDT">2026-07-02 09:00</tg-time>
🔗 <a href="https://github.com/rust-lang/rust/releases/tag/1.85.0">查看 Release ↗</a>
```

### 7.3 Rich Messages 增强(仅单仓库 Release 独立推送)

Bot API 10.1(2026-06)的 `sendRichMessage` 支持标题、嵌套列表、表格、可折叠块、媒体块等结构化内容。本项目用法:

| Rich 格式 | 用途 |
|-----------|------|
| Markdown 完整渲染 | **Release notes 整篇原样渲染**——notes 本身是 Markdown,标题、嵌套 changelog、代码块全部保留,告别截断 |
| 表格 / 标题块 | 未来日报模式的分节与汇总 |
| 媒体块(图片) | Release 推送嵌入仓库 social preview 图 |

**适用范围规则(明确)**:`rich_messages: true` **仅作用于单仓库 Release 独立推送**;摘要消息(7.4)与 commit 推送恒用 HTML,不受此开关影响。

**长度上限(已确认)**:单条 Rich Message 上限为 **32768 UTF-8 字节 / 500 个顶层块**(约为普通消息 4096 字符的 8 倍),超出按此上限分片。

实现:用 `telegramify-markdown` 的 `richify()` 将 release notes 转为 `InputRichMessage`,分片可直接使用该库按上述上限实现的 rich 分片函数。老客户端可能显示异常,关闭开关即回退 7.2 模板。

### 7.4 摘要合并消息(digest)

单轮多个仓库更新时的合并策略(`digest: auto`):

- **仅 1 个仓库更新** → 发送 7.1/7.2/7.3 的详细消息,不损失信息
- **2 个及以上仓库更新** → 合并为一条 HTML 摘要,每仓库一个区块,细节收进折叠块,一次通知音

```html
📬 <b>本轮更新</b> · 3 个仓库

📦 <b>vuejs/core</b> · 🔀 5 个新提交
<blockquote expandable>• <code>a1b2c3d</code> fix: resolve memory leak
• <code>e4f5g6h</code> feat: add defineModel support
…</blockquote>

📦 <b>rust-lang/rust</b> · 🚀 <b>v1.85.0</b> 发布
<blockquote expandable>notes 摘要 + 「查看 Release ↗」链接</blockquote>

📦 <b>sveltejs/svelte</b> · 🔀 2 个新提交
<blockquote expandable>…</blockquote>

🕐 <tg-time unix="1751437800" format="r">刚刚</tg-time>
```

**规则(明确 digest 与 rich 的交互):摘要恒用 HTML 轻量格式**。含 release 的区块放 notes 摘要与 Release 链接,完整富渲染通过链接查看——digest 的意义是「一轮一条、一次通知音」,不为富格式破坏合并。

**实现要点:**

- 主流程两阶段:事件先收集进 `events_by_repo`,全部检测完毕后由 Digest 组装器统一发送
- 超 4096 字符时**按仓库区块边界分片**,不把同一仓库切成两半
- 状态推进按仓库粒度:摘要消息发送成功后,推进其中所有仓库的状态;分片场景下按「该仓库所在分片发送成功」推进
- `digest: off` 逐仓库发送;`always` 单仓库更新也用摘要格式

### 7.5 格式化实现要求

1. **HTML 转义**:正文中 `<` `>` `&` 转义为 `&lt;` `&gt;` `&amp;`,否则 API 报 400
2. **截断**:commit 标题取首行,超 60 字符加 `…`
3. **计数**:「N 个新提交」使用 compare 端点的 `total_commits`(见 6.2),不受 `ignore` 影响
4. **发送参数**:`parse_mode=HTML`、`disable_web_page_preview=true`
5. **限流**:同一 chat 每秒 1 条,消息间 sleep 1 秒;429 按 `retry_after` 退避
6. **静默时段(可选)**:配置 `quiet_hours` 后,夜间推送带 `disable_notification=true`

### 7.6 可选增强:Inline Keyboard

```json
{"inline_keyboard": [[
  {"text": "查看 Diff", "url": "https://github.com/.../compare/..."},
  {"text": "打开仓库", "url": "https://github.com/vuejs/core"}
]]}
```

---

## 八、部署方案

### 方案 A:GitHub Actions(推荐起步)

**技术栈**:Python 3.11+,依赖 `requests`、`pyyaml`、`telegramify-markdown`

```yaml
name: monitor
on:
  schedule:
    - cron: '*/15 * * * *'   # 实际有 3-10 分钟延迟
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: monitor
  cancel-in-progress: false
```

- **状态持久化**:state.json commit 回本仓库,message 带 `[skip ci]`;回推前 `git pull --rebase`,失败重试一次
- **Secrets**:`TG_BOT_TOKEN`、`TG_CHAT_ID`;GitHub API 用内置 `GITHUB_TOKEN`
- **保活**:schedule 60 天不活跃会被禁用,state.json 的定期 commit 天然保活
- **失败告警**:workflow 末尾 `if: failure()` 步骤推送运行失败通知

**优点**:完全免费、免运维、配置即代码。**局限**:调度延迟 3-10 分钟;无常驻进程,无法接收 Bot 命令。

### 方案 B:Cloudflare Workers

**技术栈**:TypeScript,Workers Runtime

| 组件 | 用途 |
|------|------|
| Cron Triggers | 定时轮询(免费版最小间隔 1 分钟,精度高于 Actions) |
| Workers KV | 存储状态与配置 |
| HTTP Handler + Telegram Webhook | 接收 Bot 命令:`/add` `/remove` `/pause` `/resume` `/status` |

命令处理:Telegram Webhook → Worker fetch handler → 校验 `secret_token` → 读写 KV。

**v2 待补事项(实现方案 B 前需解决):**

- cron 与 webhook 命令并发读写 KV 需版本号/CAS 保护(或改用 Durable Objects 获得强一致)
- Telegram 请求超时但实际已送达的不确定态会造成重复推送,需接受重复(与至少一次语义一致)或引入幂等键

**选型建议**:v1 用方案 A 快速跑通;需要命令交互或更高调度精度时迁移方案 B。核心逻辑与平台解耦,便于迁移。

---

## 九、项目结构

```
reporadar/
├── .github/workflows/monitor.yml   # 方案 A:定时任务
├── config.yaml                     # 仓库 × 触发模式 × 过滤规则
├── state.json                      # 仓库 × 监控器 二级嵌套状态(位置标记 + ETag)
├── main.py                         # 入口:两阶段主流程(收集 → 发送 → 推进状态)
├── monitors/
│   ├── base.py                     # Monitor 基类 + 注册表
│   ├── commits.py                  # Commit 监控器(compare 端点、过滤、force push 容错)
│   └── releases.py                 # LatestRelease 监控器(404 视为暂无 release)
├── digest.py                       # 摘要组装:合并、按仓库边界分片
├── telegram.py                     # 发送:HTML 转义、Rich Message、分片、限流、重试
├── github_api.py                   # API 封装:ETag 条件请求、错误隔离
└── requirements.txt
```

---
