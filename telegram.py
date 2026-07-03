from __future__ import annotations

import html
import time

import requests


def escape_text(value) -> str:
    return html.escape("" if value is None else str(value), quote=False)


def truncate_title(value: str, limit: int) -> str:
    first_line = (value or "").splitlines()[0] if value else ""
    return first_line if len(first_line) <= limit else first_line[: max(0, limit - 1)] + "…"


def truncate_text(value: str, limit: int) -> str:
    text = value or ""
    return text if len(text) <= limit else text[: max(0, limit - 1)] + "…"


def send_html(token: str, chat_id: str, text: str, disable_notification: bool = False) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "disable_notification": disable_notification,
    }
    for attempt in range(3):
        resp = requests.post(url, json=payload, timeout=30)
        if resp.status_code == 429 and attempt < 2:
            retry_after = resp.json().get("parameters", {}).get("retry_after", 1)
            time.sleep(int(retry_after))
            continue
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(data)
        return


def send_rich(token: str, chat_id: str, markdown: str, disable_notification: bool = False, fallback_html: str | None = None) -> None:
    url = f"https://api.telegram.org/bot{token}/sendRichMessage"
    payload = {
        "chat_id": chat_id,
        "rich_message": richify_markdown(markdown),
        "disable_notification": disable_notification,
    }
    try:
        for attempt in range(3):
            resp = requests.post(url, json=payload, timeout=30)
            if resp.status_code == 429 and attempt < 2:
                retry_after = resp.json().get("parameters", {}).get("retry_after", 1)
                time.sleep(int(retry_after))
                continue
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok"):
                raise RuntimeError(data)
            return
    except Exception:
        if fallback_html is None:
            raise
        send_html(token, chat_id, fallback_html, disable_notification)


def richify_markdown(markdown: str):
    return {"markdown": markdown}
