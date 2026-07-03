from __future__ import annotations

import os

import requests


class GitHubNotFound(Exception):
    pass


class GitHubClient:
    def __init__(self, token: str | None = None):
        self.base_url = "https://api.github.com"
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/vnd.github+json",
                "User-Agent": "RepoRadar",
                "X-GitHub-Api-Version": "2022-11-28",
            }
        )
        token = token or os.getenv("GITHUB_TOKEN")
        if token:
            self.session.headers["Authorization"] = f"Bearer {token}"

    def latest_commit(self, repo: str, branch: str | None, etag: str | None):
        params = {"per_page": 1}
        if branch:
            params["sha"] = branch
        resp = self._get(f"/repos/{repo}/commits", etag=etag, params=params)
        if resp is None:
            return None
        items = resp.json()
        if not items:
            return None
        item = items[0]
        return {
            "sha": item["sha"],
            "etag": resp.headers.get("ETag"),
            "date": item["commit"]["committer"].get("date"),
            "html_url": item.get("html_url"),
        }

    def compare(self, repo: str, old_sha: str, new_sha: str):
        resp = self._get(f"/repos/{repo}/compare/{old_sha}...{new_sha}")
        if resp is None:
            return None
        return resp.json()

    def latest_release(self, repo: str, etag: str | None):
        try:
            resp = self._get(f"/repos/{repo}/releases/latest", etag=etag)
        except GitHubNotFound:
            return {"tag_name": None, "etag": None}
        if resp is None:
            return None
        data = resp.json()
        data["etag"] = resp.headers.get("ETag")
        return data

    def _get(self, path: str, etag: str | None = None, params: dict | None = None):
        headers = {"If-None-Match": etag} if etag else None
        resp = self.session.get(self.base_url + path, headers=headers, params=params, timeout=30)
        if resp.status_code == 304:
            return None
        if resp.status_code == 404:
            raise GitHubNotFound(path)
        resp.raise_for_status()
        return resp
