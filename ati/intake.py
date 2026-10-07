"""Intake CLI used by the GitHub Action.

  python -m ati.intake process   # read open issues, write/modify records, write results.json (no network writes)
  python -m ati.intake notify    # after the records are committed and pushed: comment, label and close issues

Splitting the two phases means an issue is only answered once its record has actually been saved: if the
push fails, nothing was announced and the next run simply processes the issue again.
"""
from __future__ import annotations
import argparse, json, sys
from dataclasses import asdict
from datetime import date
from pathlib import Path
from datetime import datetime, timezone
from .issues import Result, process_issue
from .records import ROOT, load_config, load_records, save_record

OLD_ACCOUNT = datetime(2000, 1, 1, tzinfo=timezone.utc)  # used only by offline tests (--issues-file)


def process(issues: list[dict], records_dir: Path, cfg: dict, today: date, account_created=lambda login: OLD_ACCOUNT) -> list[Result]:
    """`account_created(login)` returns the account's creation time, or None if it could not be looked up
    (the submission is then retried on the next run rather than decided)."""
    records = load_records(records_dir)
    results: list[Result] = []
    ages: dict = {}
    for issue in sorted(issues, key=lambda i: i["number"]):
        labels = {l["name"] if isinstance(l, dict) else l for l in issue.get("labels", [])}
        held = "needs-review" in labels
        approved = "approved" in labels
        if "processed" in labels or "rejected" in labels or (held and not approved):
            continue  # already answered, or waiting for a maintainer
        try:
            login = (issue.get("user") or {}).get("login", "")
            if not approved and login not in ages:
                ages[login] = account_created(login)
            created = None if approved else ages[login]
            res = process_issue(issue, records, cfg, today, created, force=approved)
            if res.action == "ignored":
                continue
            if res.record is not None:
                save_record(records_dir, res.record)
                records = [r for r in records if r["id"] != res.record["id"]] + [res.record]
        except Exception as e:  # one bad issue must never block the rest of the queue
            print(f"#{issue.get('number')}: skipped after error: {type(e).__name__}: {e}", file=sys.stderr)
            continue
        if res.action == "held" and held:
            continue  # already announced as held
        results.append(res)
    return results


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["process", "notify"])
    ap.add_argument("--records", default=str(ROOT / "records"))
    ap.add_argument("--results", default=str(ROOT / "results.json"))
    ap.add_argument("--issues-file", help="read issues from a JSON file instead of the GitHub API (testing)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    cfg = load_config()
    cfg["update_url"] = f"https://github.com/{cfg['repo']}/issues/new?template=update.yml"
    rp = Path(a.results)
    if a.phase == "process":
        gh = None
        if a.issues_file:
            issues = json.loads(Path(a.issues_file).read_text())
        else:
            from .github import GitHub
            gh = GitHub()
            issues = gh.list_open_issues()
        results = process(issues, Path(a.records), cfg, date.today(), (lambda login: gh.account_created(login)) if gh else (lambda login: OLD_ACCOUNT))
        rp.write_text(json.dumps([asdict(r) for r in results], indent=2, ensure_ascii=False))
        print(f"processed {len(results)} issue(s):", ", ".join(f"#{r.number}={r.action}" for r in results) or "none")
    else:
        results = [Result(**r) for r in json.loads(rp.read_text())] if rp.exists() else []
        gh = None if a.dry_run else __import__("ati.github", fromlist=["GitHub"]).GitHub()
        failed = 0
        for r in results:
            if a.dry_run:
                print(f"#{r.number} [{r.action}] labels={r.labels} close={r.close}\n{r.message}\n")
                continue
            try:  # answer first: a half-finished notice means a repeated comment, never a silent issue
                gh.comment(r.number, r.message)
                gh.add_labels(r.number, r.labels)
                if r.close:
                    gh.close(r.number, completed=r.action in ("created", "withdrawn", "already"))
            except Exception as e:  # one bad issue must not block the others
                failed += 1
                print(f"#{r.number}: notify failed: {e}", file=sys.stderr)
        if failed:
            sys.exit(1)  # the records are already saved; this only flags the run so a maintainer notices


if __name__ == "__main__":
    main()
