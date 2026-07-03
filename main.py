from __future__ import annotations

import json
import os
import time
import traceback
from dataclasses import dataclass
from pathlib import Path

from digest import build_messages
from github_api import GitHubClient
from monitors.commits import CommitMonitor
from monitors.releases import LatestReleaseMonitor
from telegram import send_html, send_rich


STATE_PATH = Path("state.json")
CONFIG_PATH = Path("config.yaml")
MONITORS = {"commit": CommitMonitor, "release": LatestReleaseMonitor}


@dataclass
class RepoConfig:
    watch: list[str]
    branch: str | None = None
    ignore: str | None = None


def main() -> None:
    missing = [name for name in ("TG_BOT_TOKEN", "TG_CHAT_ID") if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"缺少环境变量 {', '.join(missing)},请在仓库 Settings → Secrets and variables → Actions 中添加")

    config = load_config(CONFIG_PATH)
    state = load_state(STATE_PATH)
    settings = {"max_commits_shown": 2, "max_commits_folded": 20, "commit_title_limit": 60, **config.get("settings", {})}
    repos = parse_repos(config.get("repos", {}))
    client = GitHubClient()

    events_by_repo: dict[str, list] = {}
    pending: dict[tuple[str, str], dict] = {}
    dirty = False

    for repo, repo_config in repos.items():
        repo_state = state.setdefault(repo, {})
        options = {"branch": repo_config.branch, "ignore": repo_config.ignore}
        for monitor_name in repo_config.watch:
            monitor_state = repo_state.get(monitor_name, {})
            monitor = MONITORS[monitor_name](client, settings)
            try:
                result = monitor.check(repo, options, monitor_state)
            except Exception:
                print(f"[warn] {repo} {monitor_name} failed")
                traceback.print_exc()
                continue

            if result.advance_without_send:
                repo_state[monitor_name] = result.next_state
                dirty = True
            elif result.events:
                events_by_repo.setdefault(repo, []).extend(result.events)
                pending[(repo, monitor_name)] = result.next_state

    messages = build_messages(events_by_repo, config, settings)
    if messages:
        token = os.environ["TG_BOT_TOKEN"]
        chat_id = os.environ["TG_CHAT_ID"]
        for index, message in enumerate(messages):
            if message.kind == "rich":
                send_rich(token, chat_id, message.rich_text or message.text, fallback_html=message.text)
            else:
                send_html(token, chat_id, message.text)
            for repo in message.repos:
                for (pending_repo, monitor_name), next_state in pending.items():
                    if pending_repo == repo:
                        state.setdefault(repo, {})[monitor_name] = next_state
                        dirty = True
            save_state(STATE_PATH, state)
            if index != len(messages) - 1:
                time.sleep(1)

    if dirty:
        save_state(STATE_PATH, state)


def load_config(path: Path) -> dict:
    import yaml

    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def save_state(path: Path, state: dict) -> None:
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_repos(raw_repos: dict) -> dict[str, RepoConfig]:
    parsed = {}
    for repo, value in raw_repos.items():
        if isinstance(value, str):
            parsed[repo] = RepoConfig(_parse_watch(value))
        elif isinstance(value, dict):
            parsed[repo] = RepoConfig(_parse_watch(value.get("watch", "")), value.get("branch"), value.get("ignore"))
        else:
            raise ValueError(f"{repo}: repo config must be a string or mapping")
    return parsed


def _parse_watch(value: str) -> list[str]:
    normalized = " ".join(str(value).split())
    if normalized == "commit":
        return ["commit"]
    if normalized == "release":
        return ["release"]
    if normalized == "commit + release":
        return ["commit", "release"]
    raise ValueError(f"invalid watch value: {value!r}")


if __name__ == "__main__":
    main()
