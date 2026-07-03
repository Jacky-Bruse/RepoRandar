# RepoRadar 📡

关注的开源项目更新了，第一时间在 Telegram 收到通知。

RepoRadar 会定时检查你指定的 GitHub 仓库，一旦有**新提交（commit）**或**新版本发布（release）**，就把整理好的消息推送到你的 Telegram。全程跑在 GitHub Actions 上，**不需要服务器，完全免费**。

推送效果大概长这样：

> 📦 **vuejs/core**
> 🔀 **5 个新提交**
>
> • `a1b2c3d` fix: resolve memory leak
> • `e4f5g6h` feat: add defineModel support
> ▸ 其余 3 条已折叠
>
> 🕐 2 小时前 · 🔗 查看全部变更 ↗

## 特点

- **零成本**：GitHub Actions 免费额度足够用，无需服务器
- **配置极简**：加一个监控仓库 = 在配置文件里加一行
- **消息美观**：多仓库更新自动合并成一条摘要，细节折叠，不刷屏
- **不漏报**：发送失败会自动重试，首次运行不会把历史记录轰炸给你

---

## 部署教程（10 分钟搞定）

只需要一个 GitHub 账号和一个 Telegram 账号，跟着做就行。

### 第 1 步：创建你的 Telegram 机器人

1. 在 Telegram 里搜索 **@BotFather**（官方机器人），点进去发送 `/newbot`
2. 按提示给机器人起个名字（随意）和用户名（必须以 `bot` 结尾，比如 `my_radar_bot`）
3. 创建成功后，BotFather 会发给你一串 **Token**，长得像 `123456789:ABCdefGHI...`，**复制保存好**
4. ⚠️ 重要：搜索你刚创建的机器人，给它发一句 `/start`（不发这句它没法主动给你发消息）

### 第 2 步：获取你的 Chat ID

在 Telegram 里搜索 **@userinfobot**，点进去发送任意消息，它会回复你的数字 ID（比如 `123456789`），**复制保存好**。

### 第 3 步：复制本仓库

点击本页面右上角的绿色按钮 **Use this template** → **Create a new repository**，起个名字，把仓库复制一份到你自己的账号下。之后的操作都在**你自己的仓库**里进行。

### 第 4 步：填入 Token 和 Chat ID

在你 Fork 的仓库里：

1. 点击 **Settings**（设置）→ 左侧 **Secrets and variables** → **Actions**
2. 点击 **New repository secret**，添加两条：

| Name（名称） | Secret（值） |
|---|---|
| `TG_BOT_TOKEN` | 第 1 步拿到的 Token |
| `TG_CHAT_ID` | 第 2 步拿到的数字 ID |

### 第 5 步：设置要监控的仓库

在你的仓库页面打开 `config.yaml`，点击右上角铅笔图标 ✏️ 编辑，把 `repos:` 下面改成你想监控的仓库：

```yaml
repos:
  vuejs/core: commit              # 有新提交就通知
  rust-lang/rust: release         # 发新版本才通知
  sveltejs/svelte: commit + release   # 两种都要
```

改完点击 **Commit changes** 保存。以后想增减仓库，改这个文件就行。

### 第 6 步：手动跑一次

点击仓库顶部的 **Actions** 标签页，左侧选择 **monitor**，右侧点击 **Run workflow** → **Run workflow**。

> 如果你是用 Fork 而不是模板方式复制的仓库，Actions 页面会先出现一个提示，点击绿色按钮 **I understand my workflows, go ahead and enable them** 启用后再执行上面的操作。

✅ **完成！** 之后它会每 15 分钟自动检查一次。

> 💡 首次运行只会记录各仓库的当前状态，**不发消息**（避免把历史记录全推给你）。之后仓库一有新动态，你就会收到通知。想马上验证效果，可以先监控一个更新频繁的仓库（比如 `microsoft/vscode: commit`）。

---

## 配置说明

`config.yaml` 完整能力：

```yaml
digest: auto        # 多个仓库同时更新时合并成一条消息（auto/always/off）

repos:
  # 简写：一行搞定，适合绝大多数情况
  vuejs/core: commit

  # 展开写法：需要指定分支或过滤时才用
  golang/go:
    watch: commit
    branch: master           # 只看这个分支（不写 = 默认分支）
    ignore: '^(chore|docs):' # 这批提交如果全是杂务/文档类，就不通知
```

`settings` 部分只有一个开关需要了解：`rich_messages: true` 让单仓库的 release 通知用富格式完整渲染发布说明（老版 Telegram 客户端如显示异常可改为 `false`）。其余选项（展示几条提交、标题截断长度等）都有合理默认值，不写即可。

---

## 常见问题

**收不到消息？**
- 确认给你的机器人发过 `/start`
- 确认两个 Secret 的名称一字不差：`TG_BOT_TOKEN`、`TG_CHAT_ID`
- 去 Actions 页面看最近一次运行有没有红叉，点进去能看到错误原因

**通知有延迟？**
GitHub Actions 的定时任务有 3～10 分钟左右的调度延迟，属正常现象。

**仓库里的 state.json 是什么？**
程序的"记忆"，记录每个仓库上次检查到哪了，由程序自动更新，**不要手动修改**。

**长时间没动静会失效吗？**
GitHub 会禁用 60 天不活跃仓库的定时任务，但本项目会定期自动提交 state.json，天然保活，无需操心。

---

## 进阶：Cloudflare Workers 版

日常使用上面的 GitHub Actions 版就够了。如果你想要**直接在 Telegram 里发命令管理监控列表**（`/add`、`/remove` 等，不用再改配置文件），或者想要**更高的检查频率**（最快 1 分钟），可以一键部署 Cloudflare Workers 版，同样免费。

### 部署步骤

**1. 准备好 Bot Token 和 Chat ID**（即上面教程的第 1、2 步）。

**2. 点击下面的按钮**，登录（或注册）Cloudflare 账号并授权访问你的 GitHub：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Jacky-Bruse/RepoRandar/tree/main/worker)

Cloudflare 会自动把代码复制到你的 GitHub 账号下并创建好存储空间，你只需要在流程中填写几个密钥：

| 密钥 | 填什么 |
|---|---|
| `TG_BOT_TOKEN` | 第 1 步拿到的 Bot Token |
| `TG_CHAT_ID` | 第 2 步拿到的数字 ID |
| `TELEGRAM_SECRET` | 自己编一串随机字母数字（如 `x7Kp2mQw9z`），**记下来，下一步还要用** |
| `ADMIN_CHAT_ID` | 再填一次你的数字 ID（防止陌生人操控你的机器人） |
| `GITHUB_TOKEN` | 打开 [github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)** → 什么权限都不勾，直接生成、复制。可留空，但不填容易被 GitHub 限流 |

点击部署，完成后会得到你的 Worker 网址，形如 `https://reporadar.xxx.workers.dev`，复制下来。

> 如果部署流程中漏填了密钥，之后可以在 Cloudflare 控制台补：打开你的 Worker → **Settings** → **Variables and Secrets** → **Add**，类型选 **Secret**。

**3. 让 Telegram 把消息转给 Worker**。把下面这行网址中的三处尖括号内容换成你自己的，然后在浏览器里打开：

```text
https://api.telegram.org/bot<你的BotToken>/setWebhook?url=https://<你的Worker网址域名>/telegram&secret_token=<你的TELEGRAM_SECRET>
```

看到 `{"ok":true,...}` 就成功了。

### 使用

✅ 之后直接在 Telegram 里给你的机器人发命令：

| 命令 | 作用 |
|---|---|
| `/add owner/repo commit` | 监控新提交 |
| `/add owner/repo release` | 监控新版本 |
| `/add owner/repo commit + release` | 两种都监控 |
| `/remove owner/repo` | 取消监控 |
| `/pause` / `/resume` | 暂停 / 恢复推送 |
| `/status` | 查看当前监控列表 |

> 默认每 15 分钟检查一次，想更频繁可以改 `wrangler.toml` 里的 `crons`（如 `"*/5 * * * *"` 为每 5 分钟），改完重新执行 `npx wrangler deploy`。
