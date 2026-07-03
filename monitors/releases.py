from __future__ import annotations

from monitors.base import CheckResult, Event, Monitor, github_time_to_unix
from telegram import escape_text, truncate_text


class LatestReleaseMonitor(Monitor):
    def check(self, repo: str, options: dict, mon_state: dict) -> CheckResult:
        latest = self.client.latest_release(repo, mon_state.get("etag"))
        if latest is None:
            if not mon_state:
                return CheckResult([], {"tag": None}, True)
            return CheckResult([], dict(mon_state), False)

        tag = latest.get("tag_name")
        next_state = {"tag": tag, "etag": latest.get("etag") or mon_state.get("etag")}
        old_tag = mon_state.get("tag") if mon_state else None
        if not mon_state or old_tag == tag or tag is None:
            return CheckResult([], next_state, True)

        title = latest.get("name") or tag
        body = truncate_text(latest.get("body") or "", 180)
        details = [f"📝 {escape_text(title)}"]
        if body:
            details.append(escape_text(body))
        event = Event(
            "release",
            repo,
            f"{tag} 发布",
            details,
            latest.get("html_url", f"https://github.com/{repo}/releases/tag/{tag}"),
            tag=tag,
            timestamp=github_time_to_unix(latest.get("published_at")),
            rich_text=latest.get("body") or "",
        )
        return CheckResult([event], next_state)
