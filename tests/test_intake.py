import json, shutil, tempfile, unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from io import StringIO
from pathlib import Path
from ati import intake
from ati.issues import fingerprint
from ati.records import load_records
from tests.helpers import register_body, update_body, issue, cfg


class Intake(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        (self.d / "records").mkdir()

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_sweep_in_order_and_ids_sequential(self):
        issues = [issue(3, register_body(isbn="", title="Third"), "u3"), issue(1, register_body(isbn="", title="First"), "u1"),
                  issue(2, "not a form", "u2")]
        res = intake.process(issues, self.d / "records", cfg(), date(2026, 10, 8))
        self.assertEqual([(r.number, r.record_id) for r in res], [(1, "ATI-2026-000001"), (3, "ATI-2026-000002")])
        recs = load_records(self.d / "records")
        self.assertEqual([r["work"]["title"] for r in recs], ["First", "Third"])

    def test_withdraw_in_same_sweep(self):
        issues = [issue(1, register_body(isbn=""), "u1"), issue(2, update_body("ATI-2026-000001"), "u1")]
        res = intake.process(issues, self.d / "records", cfg(), date(2026, 10, 8))
        self.assertEqual([r.action for r in res], ["created", "withdrawn"])
        self.assertEqual(load_records(self.d / "records")[0]["status"], "withdrawn")

    def test_skips_processed_and_held_but_honours_approval(self):
        new = [issue(1, register_body(isbn=""), "u1", labels=["processed"]),
               issue(2, register_body(isbn="", title="Held"), "u2", labels=["needs-review"]),
               issue(3, register_body(isbn="", title="Approved"), "u3", labels=["needs-review", "approved"])]
        res = intake.process(new, self.d / "records", cfg(), date(2026, 10, 8), held_fingerprint=self.fp_of(new))
        self.assertEqual([(r.number, r.action) for r in res], [(3, "created")])

    @staticmethod
    def fp_of(issues, only=None):
        """What the bot's 'held' comment would have recorded: the fingerprint of each issue's text as it was held."""
        table = {i["number"]: fingerprint(i["body"]) for i in issues}
        return lambda n: table.get(n)

    def test_approval_releases_a_new_account_hold_only_for_the_reviewed_text(self):
        young = lambda login: datetime.now(timezone.utc)          # account created just now
        held = issue(1, register_body(isbn="", title="Reviewed"), "u1", labels=["needs-review", "approved"])
        stored = self.fp_of([held])
        res = intake.process([held], self.d / "records", cfg(), date(2026, 10, 8), young, stored)
        self.assertEqual([r.action for r in res], ["created"])     # approval overrides the account-age hold

    def test_edit_after_review_voids_the_approval(self):
        v = issue(1, register_body(isbn=""), "victimuser")
        mine = issue(2, update_body("ATI-2026-000002"), "attacker", labels=["needs-review", "approved"])
        # the attacker's own request was reviewed against record ...02; they then edited the text to name the victim's record
        reviewed = dict(mine, body=update_body("ATI-2026-000002"))
        edited = dict(mine, body=update_body("ATI-2026-000001"))
        recs = self.d / "records"
        intake.process([v], recs, cfg(), date(2026, 10, 8))
        res = intake.process([edited], recs, cfg(), date(2026, 10, 8), held_fingerprint=self.fp_of([reviewed]))
        self.assertEqual([(r.number, r.action) for r in res], [(2, "rejected")])
        self.assertIn("edited after", res[0].message)
        self.assertEqual(load_records(recs)[0]["status"], "active")       # the victim's record is untouched

    def test_approval_without_a_bot_hold_does_not_bypass_the_rules(self):
        young = lambda login: datetime.now(timezone.utc)
        i = issue(1, register_body(isbn=""), "u1", labels=["approved"])    # never held by the bot, so no fingerprint to match
        res = intake.process([i], self.d / "records", cfg(), date(2026, 10, 8), young, lambda n: None)
        self.assertEqual([r.action for r in res], ["held"])

    def test_report_never_rerun_by_sweep(self):
        first = issue(1, register_body(isbn=""), "u1")
        i = issue(4, update_body("ATI-2026-000001", "report"), "u9", labels=["needs-review", "approved"])
        res = intake.process([first, i], self.d / "records", cfg(), date(2026, 10, 8), held_fingerprint=self.fp_of([i]))
        self.assertEqual([(r.number, r.action) for r in res], [(1, "created")])
        self.assertEqual(load_records(self.d / "records")[0]["status"], "active")

    def test_approved_non_owner_withdrawal_runs(self):
        first = issue(1, register_body(isbn=""), "u1")
        w = issue(2, update_body("ATI-2026-000001"), "someone", labels=["needs-review", "approved"])
        res = intake.process([first, w], self.d / "records", cfg(), date(2026, 10, 8), held_fingerprint=self.fp_of([w]))
        self.assertEqual([r.action for r in res], ["created", "withdrawn"])

    def test_rejected_issues_are_not_reprocessed(self):
        res = intake.process([issue(1, register_body(year="x"), "u1", labels=["rejected"])], self.d / "records", cfg(), date(2026, 10, 8))
        self.assertEqual(res, [])

    def test_lookup_failure_defers_and_one_bad_issue_does_not_block(self):
        def lookup(login):
            if login == "boom":
                raise RuntimeError("api down")
            return None if login == "unknown" else datetime(2020, 1, 1, tzinfo=timezone.utc)
        issues = [issue(1, register_body(isbn="", title="A"), "boom"), issue(2, register_body(isbn="", title="B"), "unknown"),
                  issue(3, register_body(isbn="", title="C"), "fine")]
        res = intake.process(issues, self.d / "records", cfg(), date(2026, 10, 8), lookup)
        self.assertEqual([(r.number, r.action) for r in res], [(3, "created")])
        self.assertEqual([r["work"]["title"] for r in load_records(self.d / "records")], ["C"])

    def test_save_is_atomic_and_leaves_no_temp_files(self):
        intake.process([issue(1, register_body(isbn=""), "u1")], self.d / "records", cfg(), date(2026, 10, 8))
        self.assertEqual([p.name for p in (self.d / "records").iterdir()], ["ATI-2026-000001.json"])

    def test_cli_process_and_dry_run_notify(self):
        f = self.d / "issues.json"; f.write_text(json.dumps([issue(1, register_body(isbn=""), "u1")]))
        out = self.d / "results.json"
        with redirect_stdout(StringIO()):
            intake.main(["process", "--records", str(self.d / "records"), "--results", str(out), "--issues-file", str(f)])
        saved = json.loads(out.read_text())
        self.assertEqual(saved[0]["record_id"], "ATI-2026-000001")
        self.assertIsNone(saved[0]["record"])        # the results artifact must carry replies only, not record content
        buf = StringIO()
        with redirect_stdout(buf):
            intake.main(["notify", "--results", str(out), "--dry-run"])
        self.assertIn("ATI-2026-000001", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
