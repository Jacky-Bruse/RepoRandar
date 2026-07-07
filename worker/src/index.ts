type Watch = "commit" | "release";

type RepoConfig = {
  watch: Watch[];
  branch?: string;
  ignore?: string;
};

type Config = {
  digest?: "auto" | "always" | "off";
  paused?: boolean;
  repos?: Record<string, string | { watch: string; branch?: string; ignore?: string }>;
  settings?: Record<string, unknown>;
};

type State = Record<string, Record<string, Record<string, unknown>>>;

type Event = {
  kind: Watch;
  repo: string;
  title: string;
  details: string[];
  url: string;
  tag?: string | null;
  total?: number;
  timestamp?: number;
  richText?: string;
};

type CheckResult = {
  events: Event[];
  nextState: Record<string, unknown>;
  advanceWithoutSend: boolean;
};

type KV = {
  get(key: string, type?: "json" | "text"): Promise<any>;
  put(key: string, value: string): Promise<void>;
};

export type Env = {
  REPO_RADAR: KV;
  TG_BOT_TOKEN: string;
  TG_CHAT_ID: string;
  GITHUB_TOKEN?: string;
  TELEGRAM_SECRET?: string;
  ADMIN_CHAT_ID?: string;
};

type GitHub = {
  latestCommit(repo: string, branch?: string, etag?: unknown): Promise<any>;
  compare(repo: string, oldSha: string, newSha: string): Promise<any>;
  latestRelease(repo: string, etag?: unknown): Promise<any>;
};

type Deps = {
  github?: GitHub;
  sendTelegram?: (env: Env, message: Message | string, chatId?: string) => Promise<void>;
};

type Message = {
  text: string;
  repos: string[];
  kind: "html" | "rich";
  richText?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    await runMonitor(env);
  },
};

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/status") {
    const config = await readJson<Config>(env.REPO_RADAR, "config", defaultConfig());
    return json({ ok: true, paused: !!config.paused, repos: Object.keys(config.repos ?? {}).length });
  }

  if (request.method !== "POST" || !url.pathname.startsWith("/telegram")) {
    return new Response("not found", { status: 404 });
  }

  if (!telegramSecretOk(request, url, env)) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json<any>();
  const message = update.message;
  const text = message?.text;
  const chatId = String(message?.chat?.id ?? "");
  if (!text || (env.ADMIN_CHAT_ID && chatId !== env.ADMIN_CHAT_ID)) {
    return json({ ok: true });
  }

  try {
    const reply = await applyTelegramCommand(text, env.REPO_RADAR, new GitHubClient(env));
    await sendTelegram(env, reply, chatId);
  } catch (error) {
    // 必须回 200：非 200 会让 Telegram 无限重试同一条更新，堵死后续所有命令
    console.warn("telegram command failed", error);
  }
  return json({ ok: true });
}

export async function runMonitor(env: Env, deps: Deps = {}): Promise<void> {
  const kv = env.REPO_RADAR;
  const config = await readJson<Config>(kv, "config", defaultConfig());
  if (config.paused) return;

  const settings = { max_commits_shown: 2, max_commits_folded: 20, commit_title_limit: 60, ...(config.settings ?? {}) };
  const repos = parseRepos(config.repos ?? {});
  const state = await readJson<State>(kv, "state", {});
  const github = deps.github ?? new GitHubClient(env);
  const sender = deps.sendTelegram ?? sendTelegram;
  const eventsByRepo: Record<string, Event[]> = {};
  const pending = new Map<string, Record<string, unknown>>();

  // ponytail: KV has no CAS; use Durable Objects if cron/command write contention matters.
  for (const [repo, repoConfig] of Object.entries(repos)) {
    state[repo] ??= {};
    for (const monitorName of repoConfig.watch) {
      const monState = state[repo][monitorName] ?? {};
      try {
        const result =
          monitorName === "commit"
            ? await checkCommit(github, repo, repoConfig, monState, settings)
            : await checkRelease(github, repo, repoConfig, monState);
        if (result.advanceWithoutSend) {
          state[repo][monitorName] = result.nextState;
          await writeJson(kv, "state", state);
        } else if (result.events.length) {
          eventsByRepo[repo] ??= [];
          eventsByRepo[repo].push(...result.events);
          pending.set(`${repo}\0${monitorName}`, result.nextState);
        }
      } catch (error) {
        console.warn(`${repo} ${monitorName} failed`, error);
      }
    }
  }

  for (const message of buildMessages(eventsByRepo, config, settings)) {
    await sender(env, message);
    for (const repo of message.repos) {
      for (const [key, nextState] of pending) {
        const [pendingRepo, monitorName] = key.split("\0");
        if (pendingRepo === repo) state[repo][monitorName] = nextState;
      }
    }
    await writeJson(kv, "state", state);
  }
}

export function parseRepos(rawRepos: Config["repos"] = {}): Record<string, RepoConfig> {
  const parsed: Record<string, RepoConfig> = {};
  for (const [repo, value] of Object.entries(rawRepos)) {
    if (typeof value === "string") {
      parsed[repo] = { watch: parseWatch(value) };
    } else {
      parsed[repo] = { watch: parseWatch(value.watch), branch: value.branch, ignore: value.ignore };
    }
  }
  return parsed;
}

export async function applyTelegramCommand(text: string, kv: KV, github?: GitHub): Promise<string | Message> {
  const config = await readJson<Config>(kv, "config", defaultConfig());
  config.repos ??= {};

  const [command, repo, ...rest] = text.trim().split(/\s+/);
  if (command === "/add") {
    if (!repo || !repo.includes("/")) return "用法: /add owner/repo commit|release|commit + release";
    const watch = rest.join(" ") || "commit";
    try {
      parseWatch(watch);
    } catch {
      return "监控类型无效，请用: commit | release | commit + release";
    }
    config.repos[repo] = watch;
    await writeJson(kv, "config", config);
    return `已添加 ${repo}: ${watch}`;
  }
  if (command === "/remove") {
    if (!repo) return "用法: /remove owner/repo";
    delete config.repos[repo];
    await writeJson(kv, "config", config);
    return `已移除 ${repo}`;
  }
  if (command === "/pause") {
    config.paused = true;
    await writeJson(kv, "config", config);
    return "已暂停监控";
  }
  if (command === "/resume") {
    config.paused = false;
    await writeJson(kv, "config", config);
    return "已恢复监控";
  }
  if (command === "/status") {
    if (!github) return `RepoRadar: ${config.paused ? "暂停" : "运行中"}, ${Object.keys(config.repos).length} 个仓库`;
    return buildStatus(config, github);
  }
  return "支持命令: /add /remove /pause /resume /status";
}

export async function buildStatus(config: Config, github: GitHub): Promise<string | Message> {
  const repos = parseRepos(config.repos ?? {});
  const entries = Object.entries(repos);
  if (!entries.length) return "还没有关注任何仓库，用 /add owner/repo 添加";

  const rows = await Promise.all(
    entries.map(async ([repo, repoConfig]) => {
      const updates: string[] = [];
      const htmlLines: string[] = [];
      for (const watch of repoConfig.watch) {
        try {
          if (watch === "commit") {
            const head = await github.latestCommit(repo, repoConfig.branch);
            updates.push(head?.date ? formatDate(head.date) : "无提交");
            htmlLines.push(`   🔀 commit · 最近更新 ${head?.date ? statusTime(head.date) : "无提交"}`);
          } else {
            const latest = await github.latestRelease(repo);
            if (latest?.tag_name) {
              updates.push(`${latest.tag_name} · ${formatDate(latest.published_at)}`);
              htmlLines.push(`   🚀 release ${escapeHtml(latest.tag_name)} · ${statusTime(latest.published_at)}`);
            } else {
              updates.push("暂无发布");
              htmlLines.push("   🚀 release · 暂无发布");
            }
          }
        } catch {
          updates.push("⚠ 查询失败");
          htmlLines.push(`   ⚠ ${watch} 查询失败`);
        }
      }
      return { repo, watch: repoConfig.watch.join(" + "), update: updates.join(" / "), htmlLines };
    }),
  );

  const header = `📡 RepoRadar · ${config.paused ? "暂停" : "运行中"} · ${entries.length} 个仓库`;
  const table = ["| 仓库 | 关注 | 最近更新 |", "|---|---|---|", ...rows.map((row) => `| ${mdEscape(row.repo)} | ${row.watch} | ${mdEscape(row.update)} |`)];
  const html = rows.map((row) => [`📦 <b>${escapeHtml(row.repo)}</b>`, ...row.htmlLines].join("\n"));
  return {
    kind: "rich",
    repos: entries.map(([repo]) => repo),
    richText: [header, "", ...table].join("\n"),
    text: [escapeHtml(header), "", html.join("\n\n")].join("\n"),
  };
}

function formatDate(value?: string): string {
  if (!value) return "未知";
  const date = new Date(value);
  const monthDay = `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return date.getUTCFullYear() === new Date().getUTCFullYear() ? monthDay : `${date.getUTCFullYear()}-${monthDay}`;
}

function statusTime(value?: string): string {
  const unix = toUnix(value);
  return unix ? `<tg-time unix="${unix}" format="r">${formatDate(value)}</tg-time>` : "未知";
}

function mdEscape(value: string): string {
  return value.replace(/([\\|])/g, "\\$1");
}

export async function checkCommit(
  github: GitHub,
  repo: string,
  options: RepoConfig | Record<string, never>,
  monState: Record<string, unknown>,
  settings: Record<string, unknown>,
): Promise<CheckResult> {
  const head = await github.latestCommit(repo, options.branch, monState.etag);
  if (head == null) return { events: [], nextState: { ...monState }, advanceWithoutSend: false };

  const newSha = head.sha;
  const nextState = { sha: newSha, etag: head.etag };
  const oldSha = monState.sha as string | undefined;
  if (!oldSha || oldSha === newSha) return { events: [], nextState, advanceWithoutSend: true };

  let compare;
  try {
    compare = await github.compare(repo, oldSha, newSha);
  } catch (error: any) {
    if (error?.status !== 404) throw error;
    return {
      events: [
        {
          kind: "commit",
          repo,
          title: "检测到分支历史重写",
          details: [`<code>${escapeHtml(oldSha.slice(0, 7))}</code> -> <code>${escapeHtml(newSha.slice(0, 7))}</code>`],
          url: `https://github.com/${repo}/commits/${newSha}`,
          timestamp: toUnix(head.date),
        },
      ],
      nextState,
      advanceWithoutSend: false,
    };
  }

  const commits = compare.commits ?? [];
  const total = compare.total_commits ?? commits.length;
  if (ignoredWholeBatch(commits, total, options.ignore)) {
    return { events: [], nextState, advanceWithoutSend: true };
  }

  const limit = Number(settings.commit_title_limit ?? 60);
  return {
    events: [
      {
        kind: "commit",
        repo,
        title: `${total} 个新提交`,
        details: commits.map((item: any) => commitLine(repo, item, limit)),
        url: compare.html_url ?? `https://github.com/${repo}/compare/${oldSha}...${newSha}`,
        total,
        timestamp: toUnix(head.date),
      },
    ],
    nextState,
    advanceWithoutSend: false,
  };
}

export async function checkRelease(
  github: GitHub,
  repo: string,
  _options: RepoConfig | Record<string, never>,
  monState: Record<string, unknown>,
): Promise<CheckResult> {
  const latest = await github.latestRelease(repo, monState.etag);
  if (latest == null) return { events: [], nextState: { ...monState }, advanceWithoutSend: false };

  const tag = latest.tag_name ?? null;
  const nextState = { tag, etag: latest.etag ?? monState.etag };
  const cold = Object.keys(monState).length === 0;
  if (cold || monState.tag === tag || tag == null) return { events: [], nextState, advanceWithoutSend: true };

  const details = [`📝 ${escapeHtml(latest.name || tag)}`];
  const body = truncate(latest.body ?? "", 180);
  if (body) details.push(escapeHtml(body));
  return {
    events: [
      {
        kind: "release",
        repo,
        title: `${tag} 发布`,
        details,
        url: latest.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`,
        tag,
        timestamp: toUnix(latest.published_at),
        richText: latest.body ?? "",
      },
    ],
    nextState,
    advanceWithoutSend: false,
  };
}

export class GitHubClient implements GitHub {
  env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async latestCommit(repo: string, branch?: string, etag?: unknown): Promise<any> {
    const params = new URLSearchParams({ per_page: "1" });
    if (branch) params.set("sha", branch);
    const response = await this.get(`/repos/${repo}/commits?${params}`, etag);
    if (response.status === 304) return null;
    const data = await response.json<any[]>();
    if (!data.length) return null;
    return {
      sha: data[0].sha,
      etag: response.headers.get("ETag"),
      date: data[0].commit?.committer?.date,
      html_url: data[0].html_url,
    };
  }

  async compare(repo: string, oldSha: string, newSha: string): Promise<any> {
    const response = await this.get(`/repos/${repo}/compare/${oldSha}...${newSha}`);
    return response.json();
  }

  async latestRelease(repo: string, etag?: unknown): Promise<any> {
    const response = await this.get(`/repos/${repo}/releases/latest`, etag, true);
    if (response.status === 304) return null;
    if (response.status === 404) return { tag_name: null, etag: null };
    const data = await response.json<any>();
    data.etag = response.headers.get("ETag");
    return data;
  }

  async get(path: string, etag?: unknown, allow404 = false): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "RepoRadar-Worker",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${this.env.GITHUB_TOKEN}`;
    if (etag) headers["If-None-Match"] = String(etag);

    const response = await fetch(`https://api.github.com${path}`, { headers });
    if (response.status === 304 || (allow404 && response.status === 404)) return response;
    if (!response.ok) {
      const error: any = new Error(`GitHub ${response.status}: ${path}`);
      error.status = response.status;
      throw error;
    }
    return response;
  }
}

export function buildMessages(eventsByRepo: Record<string, Event[]>, config: Config, settings: Record<string, unknown>): Message[] {
  const entries = Object.entries(eventsByRepo).filter(([, events]) => events.length);
  if (!entries.length) return [];

  const digest = config.digest ?? "auto";
  if (digest === "auto" && singleRichRelease(entries, settings)) {
    const [repo, events] = entries[0];
    const event = events[0];
    return [{ text: eventMessage(event, settings), repos: [repo], kind: "rich", richText: event.richText ?? "" }];
  }
  if (digest === "off" || (digest === "auto" && entries.length === 1)) {
    return entries.map(([repo, events]) => ({
      text: events.map((event) => eventMessage(event, settings)).join("\n\n"),
      repos: [repo],
      ...messageKind(events, settings),
    }));
  }

  const messages: Message[] = [];
  let body = "";
  let repos: string[] = [];
  for (const [repo, events] of entries) {
    const block = events.map((event) => repoBlock(repo, event, settings)).join("\n");
    const candidateBody = body ? `${body}\n\n${block}` : block;
    const candidateRepos = repos.concat(repo);
    const candidate = digestText(candidateBody, candidateRepos);
    if (repos.length && candidate.length > 4096) {
      messages.push({ text: digestText(body, repos), repos, kind: "html" });
      body = block;
      repos = [repo];
    } else {
      body = candidateBody;
      repos = candidateRepos;
    }
  }
  messages.push({ text: digestText(body, repos), repos, kind: "html" });
  return messages;
}

function digestText(body: string, repos: string[]): string {
  return `📬 <b>本轮更新</b> · ${repos.length} 个仓库\n\n${body}\n\n${nowLine()}`;
}

function singleRichRelease(entries: [string, Event[]][], settings: Record<string, unknown>): boolean {
  return !!settings.rich_messages && entries.length === 1 && entries[0][1].length === 1 && entries[0][1][0].kind === "release";
}

function messageKind(events: Event[], settings: Record<string, unknown>): Pick<Message, "kind" | "richText"> {
  if (settings.rich_messages && events.length === 1 && events[0].kind === "release") {
    return { kind: "rich", richText: events[0].richText ?? "" };
  }
  return { kind: "html" };
}

function eventMessage(event: Event, settings: Record<string, unknown>): string {
  const icon = event.kind === "commit" ? "🔀" : "🚀";
  const lines = [`📦 <b>${escapeHtml(event.repo)}</b>`, `${icon} <b>${escapeHtml(event.title)}</b>`];
  const body = eventBody(event, settings, true);
  if (body) lines.push("", body);
  lines.push("", timeLine(event), `🔗 <a href="${escapeHtml(event.url)}">${event.kind === "commit" ? "查看全部变更" : "查看 Release"} ↗</a>`);
  return lines.join("\n");
}

function repoBlock(repo: string, event: Event, settings: Record<string, unknown>): string {
  const icon = event.kind === "commit" ? "🔀" : "🚀";
  let body = eventBody(event, settings, false);
  if (event.kind === "release" && event.url) {
    const link = `🔗 <a href="${escapeHtml(event.url)}">查看 Release ↗</a>`;
    body = [body, link].filter(Boolean).join("\n");
  }
  return `📦 <b>${escapeHtml(repo)}</b> · ${icon} <b>${escapeHtml(event.title)}</b>${body ? `\n<blockquote expandable>${body}</blockquote>` : ""}`;
}

function eventBody(event: Event, settings: Record<string, unknown>, detailed: boolean): string {
  if (event.kind !== "commit") return event.details.join("\n");
  const shown = Number(settings.max_commits_shown ?? 2);
  const foldedLimit = Number(settings.max_commits_folded ?? 20);
  const direct = event.details.slice(0, shown);
  const rest = event.details.slice(shown, shown + foldedLimit);
  const displayed = direct.length + rest.length;
  const total = Math.max(event.total ?? event.details.length, event.details.length);
  const missing = Math.max(total - displayed, 0);
  if (missing) rest.push(`…以及另外 ${missing} 条`);
  if (!detailed || !rest.length) return direct.concat(rest).join("\n");
  return direct.concat("", `<blockquote expandable>${rest.join("\n")}</blockquote>`).join("\n");
}

export async function sendTelegram(env: Env, message: Message | string, chatId = env.TG_CHAT_ID): Promise<void> {
  const rich = typeof message !== "string" && message.kind === "rich";
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${rich ? "sendRichMessage" : "sendMessage"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rich ? richPayload(chatId, message.richText ?? message.text) : htmlPayload(chatId, typeof message === "string" ? message : message.text)),
    });
  } catch (error) {
    if (!rich) throw error;
    await sendTelegram(env, htmlMessage(message), chatId);
    return;
  }
  if (rich && !response.ok) {
    await sendTelegram(env, htmlMessage(message), chatId);
    return;
  }
  if (!response.ok) throw new Error(`Telegram ${response.status}`);
}

function htmlMessage(message: Message): Message {
  return { text: message.text, repos: message.repos, kind: "html" };
}

function htmlPayload(chatId: string, text: string) {
  return {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
}

function richPayload(chatId: string, markdown: string) {
  return {
    chat_id: chatId,
    rich_message: {
      markdown,
    },
  };
}

function parseWatch(value: string): Watch[] {
  const normalized = String(value).trim().replace(/\s*\+\s*/g, " + ").replace(/\s+/g, " ");
  if (normalized === "commit") return ["commit"];
  if (normalized === "release") return ["release"];
  if (normalized === "commit + release" || normalized === "release + commit") return ["commit", "release"];
  throw new Error(`invalid watch value: ${value}`);
}

function ignoredWholeBatch(commits: any[], total: number, pattern?: string): boolean {
  if (!pattern || total !== commits.length || !commits.length) return false;
  const rx = new RegExp(pattern);
  return commits.every((item) => rx.test(commitTitle(item)));
}

function commitLine(repo: string, item: any, limit: number): string {
  const sha = item.sha;
  const title = escapeHtml(truncate(commitTitle(item), limit));
  const url = escapeHtml(item.html_url ?? `https://github.com/${repo}/commit/${sha}`);
  return `• <a href="${url}"><code>${escapeHtml(sha.slice(0, 7))}</code></a> ${title}`;
}

function commitTitle(item: any): string {
  return item?.commit?.message ?? "";
}

function truncate(value: string, limit: number): string {
  const text = value || "";
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function timeLine(event: Event): string {
  return `<tg-time unix="${event.timestamp ?? Math.floor(Date.now() / 1000)}" format="r">刚刚</tg-time>`;
}

function nowLine(): string {
  return `🕐 <tg-time unix="${Math.floor(Date.now() / 1000)}" format="r">刚刚</tg-time>`;
}

function toUnix(value?: string): number | undefined {
  return value ? Math.floor(new Date(value).getTime() / 1000) : undefined;
}

function defaultConfig(): Config {
  return { digest: "auto", repos: {}, settings: { max_commits_shown: 2, max_commits_folded: 20, commit_title_limit: 60 } };
}

async function readJson<T>(kv: KV, key: string, fallback: T): Promise<T> {
  return (await kv.get(key, "json")) ?? fallback;
}

async function writeJson(kv: KV, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}

function telegramSecretOk(request: Request, url: URL, env: Env): boolean {
  if (!env.TELEGRAM_SECRET) return false;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.TELEGRAM_SECRET || url.pathname === `/telegram/${env.TELEGRAM_SECRET}`;
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" }, ...init });
}
