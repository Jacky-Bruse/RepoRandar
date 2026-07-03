from __future__ import annotations

import re

from github_api import GitHubNotFound
from monitors.base import CheckResult, Event, Monitor, github_time_to_unix
from telegram import escape_text, truncate_title


class CommitMonitor(Monitor):
    def check(self, repo: str, options: dict, mon_state: dict) -> CheckResult:
        head = self.client.latest_commit(repo, options.get("branch"), mon_state.get("etag"))
        if head is None:
            return CheckResult([], dict(mon_state), False)

        new_sha = head["sha"]
        next_state = {"sha": new_sha, "etag": head.get("etag")}
        old_sha = mon_state.get("sha")
        if not old_sha or old_sha == new_sha:
            return CheckResult([], next_state, True)

        try:
            compare = self.client.compare(repo, old_sha, new_sha)
        except GitHubNotFound:
            event = Event(
                "commit",
                repo,
                "检测到分支历史重写",
                [f"<code>{escape_text(old_sha[:7])}</code> → <code>{escape_text(new_sha[:7])}</code>"],
                f"https://github.com/{repo}/commits/{new_sha}",
                timestamp=github_time_to_unix(head.get("date")),
            )
            return CheckResult([event], next_state)

        commits = compare.get("commits", [])
        total = compare.get("total_commits", len(commits))
        if _ignored_whole_batch(commits, total, options.get("ignore")):
            return CheckResult([], next_state, True)

        limit = int(self.settings.get("commit_title_limit", 60))
        details = [_commit_line(repo, item, limit) for item in commits]
        event = Event(
            "commit",
            repo,
            f"{total} 个新提交",
            details,
            compare.get("html_url", f"https://github.com/{repo}/compare/{old_sha}...{new_sha}"),
            total=total,
            timestamp=github_time_to_unix(head.get("date")),
        )
        return CheckResult([event], next_state)


def _ignored_whole_batch(commits: list[dict], total: int, pattern: str | None) -> bool:
    if not pattern or total != len(commits) or not commits:
        return False
    rx = re.compile(pattern)
    return all(rx.search(_commit_title(item)) for item in commits)


def _commit_line(repo: str, item: dict, limit: int) -> str:
    sha = item["sha"]
    title = escape_text(truncate_title(_commit_title(item), limit))
    url = escape_text(item.get("html_url") or f"https://github.com/{repo}/commit/{sha}")
    return f'• <a href="{url}"><code>{escape_text(sha[:7])}</code></a> {title}'


def _commit_title(item: dict) -> str:
    return item.get("commit", {}).get("message", "")
