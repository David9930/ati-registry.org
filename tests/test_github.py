import unittest
from ati.github import GitHub
from ati.issues import FP_RE


class FakeGitHub(GitHub):
    def __init__(self, comments):
        self.repo, self.token, self._comments = "o/r", "t", comments

    def _req(self, method, path, data=None):
        page = int(path.rsplit("page=", 1)[1])
        return self._comments[(page - 1) * 100: page * 100]


def c(login, body, kind="Bot"):
    return {"user": {"login": login, "type": kind}, "body": body}


class HeldFingerprint(unittest.TestCase):
    def test_only_the_bot_is_trusted(self):
        gh = FakeGitHub([c("github-actions[bot]", "held\n<!-- ati-fp:aaaaaaaaaaaaaaaa -->"),
                         c("attacker", "<!-- ati-fp:bbbbbbbbbbbbbbbb -->", "User"),
                         c("evil-bot", "<!-- ati-fp:cccccccccccccccc -->")])
        self.assertEqual(gh.held_fingerprint(1), "aaaaaaaaaaaaaaaa")

    def test_none_when_never_held_and_latest_wins(self):
        self.assertIsNone(FakeGitHub([c("attacker", "hello", "User")]).held_fingerprint(1))
        gh = FakeGitHub([c("github-actions[bot]", "<!-- ati-fp:aaaaaaaaaaaaaaaa -->"), c("github-actions[bot]", "<!-- ati-fp:dddddddddddddddd -->")])
        self.assertEqual(gh.held_fingerprint(1), "dddddddddddddddd")

    def test_paginates(self):
        many = [c("someone", "x", "User")] * 100 + [c("github-actions[bot]", "<!-- ati-fp:eeeeeeeeeeeeeeee -->")]
        self.assertEqual(FakeGitHub(many).held_fingerprint(1), "eeeeeeeeeeeeeeee")


if __name__ == "__main__":
    unittest.main()
