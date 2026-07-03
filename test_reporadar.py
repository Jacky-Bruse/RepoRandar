import unittest
from unittest import mock


class RepoRadarTests(unittest.TestCase):
    def test_parse_repos_supports_shorthand_and_expanded_watch(self):
        from main import parse_repos

        repos = parse_repos(
            {
                "vuejs/core": "commit",
                "rust-lang/rust": "release",
                "sveltejs/svelte": "commit + release",
                "golang/go": {
                    "watch": "commit + release",
                    "branch": "release-branch.go1.24",
                    "ignore": "^(chore|docs):",
                },
            }
        )

        self.assertEqual(repos["vuejs/core"].watch, ["commit"])
        self.assertEqual(repos["rust-lang/rust"].watch, ["release"])
        self.assertEqual(repos["sveltejs/svelte"].watch, ["commit", "release"])
        self.assertEqual(repos["golang/go"].branch, "release-branch.go1.24")
        self.assertEqual(repos["golang/go"].ignore, "^(chore|docs):")

    def test_commit_cold_start_writes_position_without_event(self):
        from monitors.commits import CommitMonitor

        client = FakeGitHub(head={"sha": "new", "etag": "etag-1", "date": "2026-07-03T10:00:00Z"})
        result = CommitMonitor(client, {"max_commits_shown": 2}).check("owner/repo", {}, {})

        self.assertEqual(result.events, [])
        self.assertEqual(result.next_state["sha"], "new")
        self.assertEqual(result.next_state["etag"], "etag-1")
        self.assertTrue(result.advance_without_send)

    def test_commit_ignore_advances_without_sending_when_whole_batch_matches(self):
        from monitors.commits import CommitMonitor

        client = FakeGitHub(
            head={"sha": "new", "etag": "etag-2", "date": "2026-07-03T10:00:00Z"},
            compare={
                "total_commits": 2,
                "html_url": "https://github.com/owner/repo/compare/old...new",
                "commits": [
                    commit("a" * 40, "docs: update readme"),
                    commit("b" * 40, "chore: bump deps"),
                ],
            },
        )

        result = CommitMonitor(client, {"max_commits_shown": 2}).check(
            "owner/repo", {"ignore": "^(docs|chore):"}, {"sha": "old", "etag": "etag-1"}
        )

        self.assertEqual(result.events, [])
        self.assertEqual(result.next_state["sha"], "new")
        self.assertTrue(result.advance_without_send)

    def test_release_404_then_first_latest_release_sends_event(self):
        from monitors.releases import LatestReleaseMonitor

        first = LatestReleaseMonitor(FakeGitHub(latest_release=None), {}).check("owner/repo", {}, {})
        self.assertEqual(first.events, [])
        self.assertIsNone(first.next_state["tag"])
        self.assertTrue(first.advance_without_send)

        second = LatestReleaseMonitor(
            FakeGitHub(
                latest_release={
                    "tag_name": "v1.0.0",
                    "name": "First stable",
                    "body": "release notes",
                    "html_url": "https://github.com/owner/repo/releases/tag/v1.0.0",
                    "published_at": "2026-07-03T10:00:00Z",
                    "etag": "etag-r",
                }
            ),
            {},
        ).check("owner/repo", {}, first.next_state)

        self.assertEqual(len(second.events), 1)
        self.assertEqual(second.events[0].tag, "v1.0.0")
        self.assertFalse(second.advance_without_send)

    def test_release_html_summary_preserves_multiline_body(self):
        from monitors.releases import LatestReleaseMonitor

        result = LatestReleaseMonitor(
            FakeGitHub(
                latest_release={
                    "tag_name": "v1.0.0",
                    "name": "First stable",
                    "body": "line1\nline2\nline3",
                    "html_url": "https://github.com/owner/repo/releases/tag/v1.0.0",
                    "published_at": "2026-07-03T10:00:00Z",
                    "etag": "etag-r",
                }
            ),
            {},
        ).check("owner/repo", {}, {"tag": None})

        self.assertIn("line2", result.events[0].details[1])

    def test_digest_auto_combines_multiple_repositories(self):
        from digest import build_messages
        from monitors.base import Event

        messages = build_messages(
            {
                "a/repo": [Event("commit", "a/repo", title="2 个新提交", details=["fix one"], url="u")],
                "b/repo": [Event("release", "b/repo", title="v1.0.0 发布", details=["notes"], url="u")],
            },
            {"digest": "auto"},
            {"max_commits_shown": 2},
        )

        self.assertEqual(len(messages), 1)
        self.assertIn("本轮更新", messages[0].text)
        self.assertEqual(messages[0].repos, {"a/repo", "b/repo"})

    def test_commit_message_caps_folded_details_and_counts_hidden_items(self):
        from digest import build_messages
        from monitors.base import Event

        details = [f"• <code>{i:07d}</code> line {i}" for i in range(250)]
        messages = build_messages(
            {"owner/repo": [Event("commit", "owner/repo", "250 个新提交", details, "u", total=250)]},
            {"digest": "off"},
            {"max_commits_shown": 2, "max_commits_folded": 20},
        )

        self.assertIn("line 21", messages[0].text)
        self.assertNotIn("line 22", messages[0].text)
        self.assertIn("…以及另外 228 条", messages[0].text)

    def test_digest_split_headers_use_chunk_repo_count(self):
        from digest import build_messages
        from monitors.base import Event

        long_detail = "x" * 2500
        messages = build_messages(
            {
                "a/repo": [Event("release", "a/repo", "v1 发布", [long_detail], "u")],
                "b/repo": [Event("release", "b/repo", "v1 发布", [long_detail], "u")],
                "c/repo": [Event("release", "c/repo", "v1 发布", [long_detail], "u")],
            },
            {"digest": "always"},
            {},
        )

        self.assertGreater(len(messages), 1)
        self.assertTrue(all("1 个仓库" in message.text for message in messages))
        self.assertTrue(all("3 个仓库" not in message.text for message in messages))

    def test_single_release_uses_rich_message_when_enabled(self):
        from digest import build_messages
        from monitors.base import Event

        messages = build_messages(
            {
                "owner/repo": [
                    Event(
                        "release",
                        "owner/repo",
                        title="v1.0.0 发布",
                        details=["notes"],
                        url="https://github.com/owner/repo/releases/tag/v1.0.0",
                        tag="v1.0.0",
                        rich_text="# Release\n\n- item",
                    )
                ]
            },
            {"digest": "auto"},
            {"rich_messages": True},
        )

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].kind, "rich")
        self.assertEqual(messages[0].rich_text, "# Release\n\n- item")

    def test_digest_release_does_not_use_rich_message(self):
        from digest import build_messages
        from monitors.base import Event

        messages = build_messages(
            {
                "owner/repo": [
                    Event(
                        "release",
                        "owner/repo",
                        title="v1.0.0 发布",
                        details=["notes"],
                        url="https://github.com/owner/repo/releases/tag/v1.0.0",
                        tag="v1.0.0",
                        rich_text="# Release",
                    )
                ]
            },
            {"digest": "always"},
            {"rich_messages": True},
        )

        self.assertEqual(messages[0].kind, "html")

    def test_digest_release_block_includes_release_link(self):
        from digest import build_messages
        from monitors.base import Event

        messages = build_messages(
            {
                "owner/repo": [
                    Event(
                        "release",
                        "owner/repo",
                        title="v1.0.0 发布",
                        details=["notes"],
                        url="https://github.com/owner/repo/releases/tag/v1.0.0",
                    )
                ]
            },
            {"digest": "always"},
            {},
        )

        self.assertIn("查看 Release", messages[0].text)
        self.assertIn("https://github.com/owner/repo/releases/tag/v1.0.0", messages[0].text)

    def test_send_rich_posts_to_send_rich_message_endpoint(self):
        import telegram

        calls = []

        class FakeResponse:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {"ok": True}

        def fake_post(url, json, timeout):
            calls.append((url, json, timeout))
            return FakeResponse()

        old_post = telegram.requests.post
        old_richify = telegram.richify_markdown
        try:
            telegram.requests.post = fake_post
            telegram.richify_markdown = lambda text: {"markdown": text}
            telegram.send_rich("token", "chat", "# Title")
        finally:
            telegram.requests.post = old_post
            telegram.richify_markdown = old_richify

        self.assertEqual(calls[0][0], "https://api.telegram.org/bottoken/sendRichMessage")
        self.assertEqual(calls[0][1]["rich_message"], {"markdown": "# Title"})

    def test_richify_markdown_has_builtin_markdown_payload_fallback(self):
        import telegram

        self.assertEqual(telegram.richify_markdown("# Title"), {"markdown": "# Title"})

    def test_send_rich_falls_back_to_html_when_rich_send_fails(self):
        import telegram

        calls = []

        class FakeResponse:
            def __init__(self, status_code, ok):
                self.status_code = status_code
                self.ok = ok

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise RuntimeError(self.status_code)

            def json(self):
                return {"ok": self.ok}

        def fake_post(url, json, timeout):
            calls.append((url, json))
            return FakeResponse(400, False) if len(calls) == 1 else FakeResponse(200, True)

        old_post = telegram.requests.post
        try:
            telegram.requests.post = fake_post
            telegram.send_rich("token", "chat", "# Rich", fallback_html="<b>HTML</b>")
        finally:
            telegram.requests.post = old_post

        self.assertEqual(calls[0][0], "https://api.telegram.org/bottoken/sendRichMessage")
        self.assertEqual(calls[1][0], "https://api.telegram.org/bottoken/sendMessage")
        self.assertEqual(calls[1][1]["text"], "<b>HTML</b>")

    def test_latest_commit_returns_none_for_empty_repository(self):
        from github_api import GitHubClient

        client = GitHubClient()
        client.session = FakeSession(FakeResponse(200, []))

        self.assertIsNone(client.latest_commit("owner/repo", None, None))

    def test_main_saves_state_after_each_successful_message(self):
        import main
        from digest import Message

        saved_states = []
        state = {}
        messages = [Message("first", {"repo/one"}), Message("second", {"repo/two"})]

        class FakeMonitor:
            def __init__(self, client, settings):
                pass

            def check(self, repo, options, mon_state):
                return FakeResult(repo)

        class FakeResult:
            def __init__(self, repo):
                self.events = [object()]
                self.next_state = {"sha": repo}
                self.advance_without_send = False

        def fake_send_html(token, chat_id, text):
            if text == "second":
                raise RuntimeError("send failed")

        with mock.patch.object(main, "load_config", return_value={"repos": {"repo/one": "commit", "repo/two": "commit"}}), \
            mock.patch.object(main, "load_state", return_value=state), \
            mock.patch.object(main, "save_state", side_effect=lambda path, value: saved_states.append({repo: dict(monitors) for repo, monitors in value.items()})), \
            mock.patch.object(main, "GitHubClient"), \
            mock.patch.dict(main.MONITORS, {"commit": FakeMonitor}, clear=True), \
            mock.patch.object(main, "build_messages", return_value=messages), \
            mock.patch.object(main, "send_html", side_effect=fake_send_html), \
            mock.patch.dict("os.environ", {"TG_BOT_TOKEN": "token", "TG_CHAT_ID": "chat"}):
            with self.assertRaises(RuntimeError):
                main.main()

        self.assertEqual(saved_states[0]["repo/one"]["commit"], {"sha": "repo/one"})
        self.assertNotIn("commit", saved_states[0].get("repo/two", {}))


def commit(sha, message):
    return {
        "sha": sha,
        "html_url": f"https://github.com/owner/repo/commit/{sha}",
        "commit": {"message": message, "committer": {"date": "2026-07-03T10:00:00Z"}},
    }


class FakeGitHub:
    def __init__(self, head=None, compare=None, latest_release=None):
        self.head = head
        self.compare_payload = compare
        self.latest_release_payload = latest_release

    def latest_commit(self, repo, branch, etag):
        return self.head

    def compare(self, repo, old_sha, new_sha):
        return self.compare_payload

    def latest_release(self, repo, etag):
        return self.latest_release_payload


class FakeResponse:
    def __init__(self, status_code, payload, headers=None):
        self.status_code = status_code
        self.payload = payload
        self.headers = headers or {}

    def json(self):
        return self.payload

    def raise_for_status(self):
        pass


class FakeSession:
    def __init__(self, response):
        self.response = response

    def get(self, *args, **kwargs):
        return self.response


if __name__ == "__main__":
    unittest.main()
