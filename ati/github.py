"""Minimal GitHub REST client (stdlib only) for the intake job."""
from __future__ import annotations
import json, os, urllib.error, urllib.request
from datetime import datetime, timezone
from .issues import FP_RE

API = "https://api.github.com"
LABEL_COLORS = {"processed": ("0e8a16", "Handled by the registry bot"), "registered": ("1f5fbf", "A record was created"),
                "rejected": ("b60205", "Failed validation; no record created"), "needs-review": ("fbca04", "Waiting for a maintainer"),
                "approved": ("0e8a16", "Maintainer approved a held submission"), "withdrawn": ("6a737d", "Record withdrawn"),
                "register": ("1f5fbf", "Registration"), "record-update": ("6a737d", "Withdraw or report a record")}


class GitHub:
    def __init__(self, repo: str | None = None, token: str | None = None):
        self.repo = repo or os.environ["GITHUB_REPOSITORY"]
        self.token = token or os.environ["GITHUB_TOKEN"]

    def _req(self, method: str, path: str, data: dict | None = None):
        req = urllib.request.Request(API + path, method=method, data=None if data is None else json.dumps(data).encode(),
                                     headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                                              "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ati-registry-bot"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def list_open_issues(self) -> list[dict]:
        out, page = [], 1
        while True:
            batch = self._req("GET", f"/repos/{self.repo}/issues?state=open&sort=created&direction=asc&per_page=100&page={page}")
            out += [i for i in batch if "pull_request" not in i]
            if len(batch) < 100:
                return out
            page += 1

    def account_created(self, login: str) -> datetime | None:
        try:
            u = self._req("GET", f"/users/{login}")
            return datetime.fromisoformat(u["created_at"].replace("Z", "+00:00"))
        except Exception:
            return None

    def held_fingerprint(self, number: int) -> str | None:
        """Fingerprint in the bot's own latest 'held for review' comment (comments by anyone else are ignored)."""
        found, page = None, 1
        while True:
            batch = self._req("GET", f"/repos/{self.repo}/issues/{number}/comments?per_page=100&page={page}")
            for c in batch:
                u = c.get("user") or {}
                if u.get("login") == "github-actions[bot]" and u.get("type") == "Bot":
                    hits = FP_RE.findall(c.get("body") or "")
                    if hits:
                        found = hits[-1]
            if len(batch) < 100:
                return found
            page += 1

    def comment(self, number: int, body: str):
        self._req("POST", f"/repos/{self.repo}/issues/{number}/comments", {"body": body})

    def add_labels(self, number: int, labels: list[str]):
        for name in labels:
            if name in LABEL_COLORS:
                color, desc = LABEL_COLORS[name]
                try:
                    self._req("POST", f"/repos/{self.repo}/labels", {"name": name, "color": color, "description": desc})
                except urllib.error.HTTPError as e:
                    if e.code != 422:  # 422 = already exists
                        raise
        if labels:
            self._req("POST", f"/repos/{self.repo}/issues/{number}/labels", {"labels": labels})

    def close(self, number: int, completed: bool = True):
        self._req("PATCH", f"/repos/{self.repo}/issues/{number}",
                  {"state": "closed", "state_reason": "completed" if completed else "not_planned"})
