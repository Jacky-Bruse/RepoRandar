import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTelegramCommand,
  buildMessages,
  buildStatus,
  checkCommit,
  checkRelease,
  GitHubClient,
  handleFetch,
  parseRepos,
  runMonitor,
  sendTelegram,
} from "../src/index.ts";

test("parseRepos supports shorthand and expanded watch syntax", () => {
  const repos = parseRepos({
    "vuejs/core": "commit",
    "rust-lang/rust": "release",
    "sveltejs/svelte": "commit + release",
    "golang/go": {
      watch: "commit + release",
      branch: "release-branch.go1.24",
      ignore: "^(chore|docs):",
    },
  });

  assert.deepEqual(repos["vuejs/core"].watch, ["commit"]);
  assert.deepEqual(repos["rust-lang/rust"].watch, ["release"]);
  assert.deepEqual(repos["sveltejs/svelte"].watch, ["commit", "release"]);
  assert.equal(repos["golang/go"].branch, "release-branch.go1.24");
  assert.equal(repos["golang/go"].ignore, "^(chore|docs):");
});

test("telegram commands update KV config", async () => {
  const kv = new MemoryKV({ config: { digest: "auto", repos: {} } });

  let reply = await applyTelegramCommand("/add owner/repo commit + release", kv);
  assert.equal(reply, "已添加 owner/repo: commit + release");
  assert.equal((await kv.get("config", "json")).repos["owner/repo"], "commit + release");

  reply = await applyTelegramCommand("/pause", kv);
  assert.equal(reply, "已暂停监控");
  assert.equal((await kv.get("config", "json")).paused, true);

  reply = await applyTelegramCommand("/remove owner/repo", kv);
  assert.equal(reply, "已移除 owner/repo");
  assert.deepEqual((await kv.get("config", "json")).repos, {});
});

test("/add accepts commit+release without spaces", async () => {
  const kv = new MemoryKV({ config: { digest: "auto", repos: {} } });
  const reply = await applyTelegramCommand("/add owner/repo commit+release", kv);
  assert.equal(reply, "已添加 owner/repo: commit+release");
  assert.deepEqual(parseRepos((await kv.get("config", "json")).repos)["owner/repo"].watch, ["commit", "release"]);
});

test("invalid /add watch returns usage without throwing or corrupting config", async () => {
  const kv = new MemoryKV({ config: { digest: "auto", repos: {} } });
  const reply = await applyTelegramCommand("/add owner/repo bogus", kv);
  assert.match(reply, /无效/);
  assert.deepEqual((await kv.get("config", "json")).repos, {});
});

test("telegram webhook returns 200 even when reply send fails", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const response = await handleFetch(
      new Request("https://worker.test/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cr3t" },
        body: JSON.stringify({ message: { text: "/status", chat: { id: "1" } } }),
      }),
      { REPO_RADAR: new MemoryKV({ config: { repos: {} } }), TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat", TELEGRAM_SECRET: "s3cr3t" },
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("commit cold start advances state without events", async () => {
  const result = await checkCommit(
    github({
      head: { sha: "new", etag: "etag-1", date: "2026-07-03T10:00:00Z" },
    }),
    "owner/repo",
    {},
    {},
    { commit_title_limit: 60 },
  );

  assert.deepEqual(result.events, []);
  assert.equal(result.nextState.sha, "new");
  assert.equal(result.nextState.etag, "etag-1");
  assert.equal(result.advanceWithoutSend, true);
});

test("release 404 then first latest release sends event", async () => {
  const first = await checkRelease(github({ release: { tag_name: null } }), "owner/repo", {}, {});
  assert.deepEqual(first.events, []);
  assert.equal(first.nextState.tag, null);
  assert.equal(first.advanceWithoutSend, true);

  const second = await checkRelease(
    github({
      release: {
        tag_name: "v1.0.0",
        name: "First stable",
        body: "release notes",
        html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
        published_at: "2026-07-03T10:00:00Z",
        etag: "etag-r",
      },
    }),
    "owner/repo",
    {},
    first.nextState,
  );

  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].tag, "v1.0.0");
  assert.equal(second.advanceWithoutSend, false);
});

test("runMonitor advances ignored batches without telegram send", async () => {
  const kv = new MemoryKV({
    config: {
      digest: "auto",
      repos: {
        "owner/repo": { watch: "commit", ignore: "^(docs|chore):" },
      },
    },
    state: {
      "owner/repo": { commit: { sha: "old", etag: "etag-1" } },
    },
  });
  const sent = [];

  await runMonitor(
    {
      REPO_RADAR: kv,
      TG_BOT_TOKEN: "token",
      TG_CHAT_ID: "chat",
    },
    {
      github: github({
        head: { sha: "new", etag: "etag-2", date: "2026-07-03T10:00:00Z" },
        compare: {
          total_commits: 2,
          html_url: "https://github.com/owner/repo/compare/old...new",
          commits: [
            commit("a".repeat(40), "docs: update readme"),
            commit("b".repeat(40), "chore: bump deps"),
          ],
        },
      }),
      sendTelegram: async (_env, message) => sent.push(message),
    },
  );

  assert.deepEqual(sent, []);
  assert.equal((await kv.get("state", "json"))["owner/repo"].commit.sha, "new");
});

test("runMonitor sends single release as rich message when enabled", async () => {
  const kv = new MemoryKV({
    config: {
      digest: "auto",
      repos: { "owner/repo": "release" },
      settings: { rich_messages: true },
    },
    state: {
      "owner/repo": { release: { tag: "v0.9.0", etag: "etag-old" } },
    },
  });
  const sent = [];

  await runMonitor(
    {
      REPO_RADAR: kv,
      TG_BOT_TOKEN: "token",
      TG_CHAT_ID: "chat",
    },
    {
      github: github({
        release: {
          tag_name: "v1.0.0",
          name: "First stable",
          body: "# Release\n\n- item",
          html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
          published_at: "2026-07-03T10:00:00Z",
          etag: "etag-r",
        },
      }),
      sendTelegram: async (_env, message) => sent.push(message),
    },
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "rich");
  assert.equal(sent[0].richText, "# Release\n\n- item");
});

test("commit messages cap folded details and count hidden items", () => {
  const details = Array.from({ length: 250 }, (_, i) => `• <code>${String(i).padStart(7, "0")}</code> line ${i}`);
  const messages = buildMessages(
    { "owner/repo": [{ kind: "commit", repo: "owner/repo", title: "250 个新提交", details, url: "u", total: 250 }] },
    { digest: "off" },
    { max_commits_shown: 2, max_commits_folded: 20 },
  );

  assert.match(messages[0].text, /line 21/);
  assert.doesNotMatch(messages[0].text, /line 22/);
  assert.match(messages[0].text, /…以及另外 228 条/);
});

test("digest split headers use chunk repository count", () => {
  const longDetail = "x".repeat(2500);
  const messages = buildMessages(
    {
      "a/repo": [{ kind: "release", repo: "a/repo", title: "v1 发布", details: [longDetail], url: "u" }],
      "b/repo": [{ kind: "release", repo: "b/repo", title: "v1 发布", details: [longDetail], url: "u" }],
      "c/repo": [{ kind: "release", repo: "c/repo", title: "v1 发布", details: [longDetail], url: "u" }],
    },
    { digest: "always" },
    {},
  );

  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.text.includes("1 个仓库")));
  assert.ok(messages.every((message) => !message.text.includes("3 个仓库")));
});

test("digest release block includes release link", () => {
  const messages = buildMessages(
    {
      "owner/repo": [
        {
          kind: "release",
          repo: "owner/repo",
          title: "v1.0.0 发布",
          details: ["notes"],
          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
        },
      ],
    },
    { digest: "always" },
    {},
  );

  assert.match(messages[0].text, /查看 Release/);
  assert.match(messages[0].text, /https:\/\/github.com\/owner\/repo\/releases\/tag\/v1.0.0/);
});

test("release html summary preserves multiline body", async () => {
  const result = await checkRelease(
    github({
      release: {
        tag_name: "v1.0.0",
        name: "First stable",
        body: "line1\nline2\nline3",
        html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
        published_at: "2026-07-03T10:00:00Z",
        etag: "etag-r",
      },
    }),
    "owner/repo",
    {},
    { tag: null },
  );

  assert.match(result.events[0].details[1], /line2/);
});

test("telegram webhook requires secret", async () => {
  const response = await handleFetch(
    new Request("https://worker.test/telegram", {
      method: "POST",
      body: JSON.stringify({ message: {} }),
    }),
    { REPO_RADAR: new MemoryKV(), TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat" },
  );

  assert.equal(response.status, 403);
});

test("GitHubClient latestCommit returns null for empty repositories", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { ETag: "etag-empty" },
      });
    const client = new GitHubClient({ REPO_RADAR: new MemoryKV(), TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat" });

    assert.equal(await client.latestCommit("owner/repo"), null);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("sendTelegram falls back to html when rich send fails", async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: calls.length > 1 }), { status: calls.length === 1 ? 400 : 200 });
    };

    await sendTelegram(
      { REPO_RADAR: new MemoryKV(), TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat" },
      { kind: "rich", repos: ["owner/repo"], text: "<b>HTML</b>", richText: "# Rich" },
    );
  } finally {
    globalThis.fetch = oldFetch;
  }

  assert.match(calls[0].url, /sendRichMessage$/);
  assert.deepEqual(calls[0].body.rich_message, { markdown: "# Rich" });
  assert.match(calls[1].url, /sendMessage$/);
  assert.equal(calls[1].body.text, "<b>HTML</b>");
});

test("sendTelegram falls back to html when rich fetch throws", async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (calls.length === 1) throw new Error("network");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await sendTelegram(
      { REPO_RADAR: new MemoryKV(), TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat" },
      { kind: "rich", repos: ["owner/repo"], text: "<b>HTML</b>", richText: "# Rich" },
    );
  } finally {
    globalThis.fetch = oldFetch;
  }

  assert.match(calls[0].url, /sendRichMessage$/);
  assert.match(calls[1].url, /sendMessage$/);
  assert.equal(calls[1].body.text, "<b>HTML</b>");
});

test("buildStatus renders rich table with html fallback", async () => {
  const year = new Date().getUTCFullYear();
  const config = {
    repos: {
      "owner/commit-repo": "commit",
      "owner/release-repo": "release",
      "owner/both-repo": "commit + release",
    },
  };
  const fake = {
    latestCommit: async () => ({ sha: "abc", date: `${year}-06-16T07:45:34Z` }),
    latestRelease: async () => ({ tag_name: "v1.2.3", published_at: `${year - 1}-11-02T00:00:00Z` }),
  };

  const message = await buildStatus(config, fake);

  assert.equal(message.kind, "rich");
  assert.match(message.richText, /运行中 · 3 个仓库/);
  assert.match(message.richText, /\| 仓库 \| 关注 \| 最近更新 \|/);
  assert.match(message.richText, /\| owner\/commit-repo \| commit \| 06-16 \|/);
  assert.match(message.richText, new RegExp(`\\| owner/release-repo \\| release \\| v1\\.2\\.3 · ${year - 1}-11-02 \\|`));
  assert.match(message.richText, /\| owner\/both-repo \| commit \+ release \| 06-16 \/ v1\.2\.3 · \d{4}-11-02 \|/);
  assert.match(message.text, /📦 <b>owner\/commit-repo<\/b>/);
  assert.match(message.text, /<tg-time/);
});

test("buildStatus marks per-repo failures and missing releases", async () => {
  const config = { paused: true, repos: { "owner/broken": "commit", "owner/no-release": "release" } };
  const fake = {
    latestCommit: async () => {
      throw new Error("rate limited");
    },
    latestRelease: async () => ({ tag_name: null }),
  };

  const message = await buildStatus(config, fake);

  assert.match(message.richText, /暂停 · 2 个仓库/);
  assert.match(message.richText, /\| owner\/broken \| commit \| ⚠ 查询失败 \|/);
  assert.match(message.richText, /\| owner\/no-release \| release \| 暂无发布 \|/);
});

test("/status without repos returns plain hint", async () => {
  const kv = new MemoryKV({ config: { digest: "auto", repos: {} } });
  const reply = await applyTelegramCommand("/status", kv, github({}));
  assert.equal(typeof reply, "string");
  assert.match(reply, /还没有关注任何仓库/);
});

test("/status returns rich status message", async () => {
  const kv = new MemoryKV({ config: { digest: "auto", repos: { "owner/repo": "commit" } } });
  const reply = await applyTelegramCommand("/status", kv, github({ head: { sha: "abc", date: "2026-07-03T10:00:00Z" } }));
  assert.equal(reply.kind, "rich");
  assert.match(reply.richText, /owner\/repo/);
});

function commit(sha, message) {
  return {
    sha,
    html_url: `https://github.com/owner/repo/commit/${sha}`,
    commit: { message, committer: { date: "2026-07-03T10:00:00Z" } },
  };
}

function github(payload) {
  return {
    latestCommit: async () => payload.head ?? null,
    compare: async () => payload.compare,
    latestRelease: async () => payload.release ?? null,
  };
}

class MemoryKV {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  }

  async get(key, type) {
    const value = this.values.get(key);
    if (value == null) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}
