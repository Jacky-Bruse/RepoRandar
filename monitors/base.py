from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Event:
    kind: str
    repo: str
    title: str
    details: list[str] = field(default_factory=list)
    url: str = ""
    tag: str | None = None
    total: int | None = None
    timestamp: int | None = None
    rich_text: str | None = None


@dataclass
class CheckResult:
    events: list[Event]
    next_state: dict
    advance_without_send: bool = False


class Monitor(ABC):
    def __init__(self, client, settings: dict):
        self.client = client
        self.settings = settings

    @abstractmethod
    def check(self, repo: str, options: dict, mon_state: dict) -> CheckResult:
        raise NotImplementedError


def github_time_to_unix(value: str | None) -> int | None:
    if not value:
        return None
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
