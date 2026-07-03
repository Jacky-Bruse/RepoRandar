from __future__ import annotations

from dataclasses import dataclass
from time import time

from monitors.base import Event
from telegram import escape_text


@dataclass
class Message:
    text: str
    repos: set[str]
    kind: str = "html"
    rich_text: str | None = None


def build_messages(events_by_repo: dict[str, list[Event]], config: dict, settings: dict) -> list[Message]:
    events_by_repo = {repo: events for repo, events in events_by_repo.items() if events}
    if not events_by_repo:
        return []

    digest = config.get("digest", "auto")
    if digest == "auto" and _single_rich_release(events_by_repo, settings):
        repo, events = next(iter(events_by_repo.items()))
        event = events[0]
        return [Message(_event_message(event, settings), {repo}, "rich", event.rich_text or "")]

    if digest == "off" or (digest == "auto" and len(events_by_repo) == 1):
        return [
            Message(_repo_message(repo, events, settings), {repo}, *_message_rich_fields(events, settings))
            for repo, events in events_by_repo.items()
        ]

    blocks = [_repo_block(repo, events, settings) for repo, events in events_by_repo.items()]
    return _split_digest(blocks)


def _repo_message(repo: str, events: list[Event], settings: dict) -> str:
    return "\n\n".join(_event_message(event, settings) for event in events)


def _single_rich_release(events_by_repo: dict[str, list[Event]], settings: dict) -> bool:
    if not settings.get("rich_messages") or len(events_by_repo) != 1:
        return False
    events = next(iter(events_by_repo.values()))
    return len(events) == 1 and events[0].kind == "release"


def _message_rich_fields(events: list[Event], settings: dict) -> tuple[str, str | None]:
    if settings.get("rich_messages") and len(events) == 1 and events[0].kind == "release":
        return "rich", events[0].rich_text or ""
    return "html", None


def _event_message(event: Event, settings: dict) -> str:
    icon = "🔀" if event.kind == "commit" else "🚀"
    lines = [f"📦 <b>{escape_text(event.repo)}</b>", f"{icon} <b>{escape_text(event.title)}</b>"]
    body = _event_body(event, settings, detailed=True)
    if body:
        lines.extend(["", body])
    lines.extend(["", _time_line(event), f'🔗 <a href="{escape_text(event.url)}">{_link_text(event)} ↗</a>'])
    return "\n".join(lines)


def _repo_block(repo: str, events: list[Event], settings: dict) -> tuple[str, set[str]]:
    lines = []
    for event in events:
        icon = "🔀" if event.kind == "commit" else "🚀"
        lines.append(f"📦 <b>{escape_text(repo)}</b> · {icon} <b>{escape_text(event.title)}</b>")
        body = _event_body(event, settings, detailed=False)
        if event.kind == "release" and event.url:
            link = f'🔗 <a href="{escape_text(event.url)}">查看 Release ↗</a>'
            body = "\n".join(part for part in [body, link] if part)
        if body:
            lines.append(f"<blockquote expandable>{body}</blockquote>")
    return "\n".join(lines), {repo}


def _event_body(event: Event, settings: dict, detailed: bool) -> str:
    if event.kind != "commit":
        return "\n".join(event.details)

    shown = int(settings.get("max_commits_shown", 2))
    folded_limit = int(settings.get("max_commits_folded", 20))
    direct = event.details[:shown]
    rest = event.details[shown : shown + folded_limit]
    displayed = len(direct) + len(rest)
    total = max(event.total or len(event.details), len(event.details))
    missing = max(total - displayed, 0)
    if missing:
        rest.append(f"…以及另外 {missing} 条")
    if not detailed:
        return "\n".join(direct + rest)
    if not rest:
        return "\n".join(direct)
    return "\n".join(direct + ["", f"<blockquote expandable>{chr(10).join(rest)}</blockquote>"])


def _split_digest(blocks: list[tuple[str, set[str]]]) -> list[Message]:
    messages = []
    body = ""
    repos: set[str] = set()
    for block, block_repos in blocks:
        candidate_body = body + "\n\n" + block if body else block
        candidate_repos = repos | block_repos
        candidate = _digest_text(candidate_body, candidate_repos)
        if repos and len(candidate) > 4096:
            messages.append(Message(_digest_text(body, repos), repos))
            body = block
            repos = set(block_repos)
        else:
            body = candidate_body
            repos = candidate_repos
    messages.append(Message(_digest_text(body, repos), repos))
    return messages


def _digest_text(body: str, repos: set[str]) -> str:
    return f"📬 <b>本轮更新</b> · {len(repos)} 个仓库\n\n{body}\n\n{_now_line()}"


def _time_line(event: Event) -> str:
    unix = event.timestamp or int(time())
    return f'🕐 <tg-time unix="{unix}" format="r">刚刚</tg-time>'


def _now_line() -> str:
    return f'🕐 <tg-time unix="{int(time())}" format="r">刚刚</tg-time>'


def _link_text(event: Event) -> str:
    return "查看全部变更" if event.kind == "commit" else "查看 Release"
