import json, shutil, tempfile, unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from io import StringIO
from pathlib import Path
from ati import intake
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
        res = intake.process(new, self.d / "records", cfg(), date(2026, 10, 8))
        self.assertEqual([(r.number, r.action) for r in res], [(3, "created")])

    def test_report_never_rerun_by_sweep(self):
        first = issue(1, register_body(isbn=""), "u1")
        i = issue(4, update_body("ATI-2026-000001", "report"), "u9", labels=["needs-review", "approved"])
        res = intake.process([first, i], self.d / "records", cfg(), date(2026, 10, 8))
        self.assertEqual([(r.number, r.action) for r in res], [(1, "created")])
        self.assertEqual(load_records(self.d / "records")[0]["status"], "active")

    def test_approved_non_owner_withdrawal_runs(self):
        first = issue(1, register_body(isbn=""), "u1")
        w = issue(2, update_body("ATI-2026-000001"), "someone", labels=["needs-review", "approved"])
        res = intake.process([first, w], self.d / "records", cfg(), date(2026, 10, 8))
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
        self.assertEqual(json.loads(out.read_text())[0]["record_id"], "ATI-2026-000001")
        buf = StringIO()
        with redirect_stdout(buf):
            intake.main(["notify", "--results", str(out), "--dry-run"])
        self.assertIn("ATI-2026-000001", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
