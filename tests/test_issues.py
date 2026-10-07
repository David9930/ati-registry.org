import unittest
from datetime import date, datetime, timedelta, timezone
from ati.issues import process_issue, parse_sections, detect
from ati import labels as L
from tests.helpers import register_body, update_body, issue, cfg, fixture_record

TODAY = date(2026, 10, 8)
OLD = datetime(2020, 1, 1, tzinfo=timezone.utc)


def run(body, records=None, **kw):
    kw.setdefault("account_created", OLD)
    return process_issue(issue(kw.pop("number", 5), body, kw.pop("login", "author1"), labels=kw.pop("labels", ())), records or [], cfg(), TODAY, **kw)


class Register(unittest.TestCase):
    def test_valid_creates_record(self):
        r = run(register_body())
        self.assertEqual(r.action, "created", r.message)
        self.assertEqual(r.record_id, "ATI-2026-000001")
        rec = r.record
        self.assertEqual(rec["work"]["isbn"], "9780306406157")
        self.assertEqual(rec["label"], "ai-master-edited")
        self.assertEqual(rec["components"], [{"part": "cover", "ai_use": "generated"}])
        self.assertEqual(rec["work"]["formats"], ["ebook"])
        self.assertEqual(rec["declared_by"]["github"], "author1")
        self.assertTrue(r.close)
        self.assertIn("ATI-2026-000001", r.message)

    def test_id_increments(self):
        r = run(register_body(isbn="", title="Other"), [fixture_record()])
        self.assertEqual(r.record_id, "ATI-2026-000002")

    def test_errors_listed(self):
        r = run(register_body(title="", year="20", isbn="123", statement="x", attest=[], label=""))
        self.assertEqual(r.action, "rejected")
        for frag in ("title is required", "four-digit year", "ISBN", "20 and 1,500", "confirmations", "three labels"):
            self.assertIn(frag, r.message)

    def test_tools_required_when_ai_used(self):
        self.assertEqual(run(register_body(ai_tools="")).action, "rejected")
        # human-authored text with no AI anywhere needs no tools
        ok = run(register_body(label="Human Authored (HA)", ai_tools="", cover="Human-made, no AI used"))
        self.assertEqual(ok.action, "created", ok.message)
        # human-authored text but AI cover still needs the tool listed
        self.assertEqual(run(register_body(label="Human Authored (HA)", ai_tools="")).action, "rejected")

    def test_duplicate_isbn(self):
        rec = fixture_record()
        r = run(register_body(isbn="978-1-7386519-5-5"), [rec])
        self.assertEqual(r.action, "rejected"); self.assertIn("ATI-2026-000001", r.message)

    def test_duplicate_work_same_user(self):
        rec = fixture_record(); rec["declared_by"]["github"] = "author1"
        rec["work"].update(title="Test Book", author="A. Writer", year=2026, edition="First Edition"); rec["work"].pop("isbn")
        r = run(register_body(isbn=""), [rec])
        self.assertEqual(r.action, "rejected")

    def test_new_account_held_then_approved(self):
        new = datetime.now(timezone.utc) - timedelta(days=1)
        r = run(register_body(), account_created=new)
        self.assertEqual(r.action, "held"); self.assertIn("needs-review", r.labels); self.assertFalse(r.close)
        self.assertEqual(run(register_body(), account_created=new, force=True).action, "created")

    def test_daily_limit(self):
        recs = []
        for i in range(5):
            x = fixture_record(id=f"ATI-2026-{i+1:06d}")
            x["work"].pop("isbn"); x["work"]["title"] = f"T{i}"
            x["history"] = [{"date": TODAY.isoformat(), "event": "registered", "by": "author1", "issue": 100 + i}]
            recs.append(x)
        self.assertEqual(run(register_body(isbn=""), recs).action, "held")

    def test_bot_and_unrelated_ignored(self):
        self.assertEqual(process_issue(issue(1, register_body(), bot=True), [], cfg(), TODAY).action, "ignored")
        self.assertEqual(run("just a question").action, "ignored")

    def test_idempotent(self):
        first = run(register_body(), number=7)
        again = run(register_body(), [first.record], number=7)
        self.assertEqual(again.action, "already"); self.assertEqual(again.record_id, first.record_id); self.assertIsNone(again.record)

    def test_hostile_input_is_data(self):
        r = run(register_body(title='<script>alert(1)</script>', author="x‮​evil"), )
        self.assertEqual(r.action, "created")
        self.assertNotIn("‮", r.record["work"]["author"])
        self.assertEqual(r.record["work"]["title"], "<script>alert(1)</script>")  # stored verbatim, escaped on render

    def test_url_scheme_rejected(self):
        self.assertEqual(run(register_body(url="javascript:alert(1)")).action, "rejected")

    def test_url_hardening(self):
        for bad in ("https://user:pw@example.com/", "http://127.0.0.1/x", "https://[::1]/", "https://localhost/", "https://intranet/",
                    "https://example.com:8443/", "https://example.com/a b", "ftp://example.com/"):
            self.assertEqual(run(register_body(url=bad)).action, "rejected", bad)
        self.assertEqual(run(register_body(url="https://example.com/book?a=1&b=2")).action, "created")

    def test_role_required_and_recorded(self):
        self.assertEqual(run(register_body(role="")).action, "rejected")
        r = run(register_body(role=L.ROLES["publisher"]))
        self.assertEqual(r.record["declared_by"]["role"], "publisher")

    def test_numeric_account_id_recorded(self):
        r = process_issue(issue(5, register_body(), "author1", uid=777), [], cfg(), TODAY, OLD)
        self.assertEqual(r.record["declared_by"]["id"], 777)

    def test_human_authored_rejects_ai_translation(self):
        for use in ("assisted", "generated"):
            r = run(register_body(label="Human Authored (HA)", translation=L.AI_USE[use], cover=L.AI_USE["none"]))
            self.assertEqual(r.action, "rejected", use); self.assertIn("translation", r.message)
        ok = run(register_body(label="Human Authored (HA)", translation=L.AI_USE["none"], cover=L.AI_USE["none"], ai_tools=""))
        self.assertEqual(ok.action, "created", ok.message)

    def test_unicode_hardening(self):
        for title in ("\u3164\u3164", "\u2800", "\u200b\u200b", "!!!"):
            self.assertEqual(run(register_body(title=title)).action, "rejected", repr(title))
        self.assertEqual(run(register_body(year="２０２６")).action, "rejected")  # fullwidth digits
        r = run(register_body(title="Caf\u0065\u0301 \ud800 \u202eevil\u2066", author="A\u00a0\u00a0Writer"))
        self.assertEqual(r.action, "created", r.message)
        self.assertEqual(r.record["work"]["title"], "Caf\u00e9 evil")       # NFC, surrogate and bidi controls removed
        self.assertEqual(r.record["work"]["author"], "A Writer")
        r.record["work"]["title"].encode("utf-8")                              # must be writable to disk

    def test_isbn_forms(self):
        for raw in ("ISBN 978-0-306-40615-7", "ISBN-13: 978\u20110\u2011306\u201140615\u20117", "0306406152"):
            self.assertEqual(run(register_body(isbn=raw)).record["work"]["isbn"], "9780306406157", raw)

    def test_account_lookup_failure_defers_instead_of_deciding(self):
        r = process_issue(issue(5, register_body()), [], cfg(), TODAY, None)
        self.assertEqual(r.action, "ignored"); self.assertIsNone(r.record)

    def test_global_daily_cap_holds(self):
        c = cfg(); c["max_registrations_per_day_total"] = 2
        recs = []
        for i in range(2):
            x = fixture_record(id=f"ATI-2026-{i+1:06d}"); x["work"].pop("isbn"); x["work"]["title"] = f"T{i}"
            x["history"] = [{"date": TODAY.isoformat(), "event": "registered", "by": f"user{i}", "issue": 100 + i}]
            recs.append(x)
        r = process_issue(issue(5, register_body(isbn="")), recs, c, TODAY, OLD)
        self.assertEqual(r.action, "held"); self.assertIn("daily intake limit", r.message)

    def test_duplicate_work_rule_respects_isbn(self):
        rec = fixture_record(); rec["declared_by"] = {"github": "author1", "role": "author"}
        rec["work"].update(title="Test Book", author="A. Writer", year=2026, edition="First Edition", isbn="9780306406157")
        other = run(register_body(isbn="978-1-7386519-5-5"), [rec])      # same title/edition, different ISBN: allowed
        self.assertEqual(other.action, "created", other.message)
        rec["work"].pop("isbn")
        self.assertEqual(run(register_body(title="TEST   book"), [rec]).action, "rejected")  # no ISBN on one side: duplicate

    def test_no_submitted_text_is_echoed_into_comments(self):
        r = run(register_body(title="@everyone free money http://spam.example", year="20"))
        self.assertNotIn("everyone", r.message); self.assertNotIn("spam", r.message)


class Update(unittest.TestCase):
    def setUp(self):
        self.rec = fixture_record()

    def test_owner_withdraws(self):
        r = run(update_body(), [self.rec], login="example-author")
        self.assertEqual(r.action, "withdrawn")
        self.assertEqual(r.record["status"], "withdrawn")
        self.assertEqual(r.record["history"][-1]["event"], "withdrawn")
        self.assertEqual(self.rec["status"], "active")  # original untouched

    def test_non_owner_held(self):
        r = run(update_body(), [self.rec], login="someone-else")
        self.assertEqual(r.action, "held"); self.assertIsNone(r.record)

    def test_report_held(self):
        r = run(update_body(action="report"), [self.rec], login="someone-else")
        self.assertEqual(r.action, "held"); self.assertIn("needs-review", r.labels)

    def test_unknown_id(self):
        self.assertEqual(run(update_body("ATI-2026-999999"), [self.rec]).action, "rejected")
        self.assertEqual(run(update_body("nonsense"), [self.rec]).action, "rejected")

    def test_double_withdraw(self):
        w = run(update_body(), [self.rec], login="example-author", number=5).record
        self.assertEqual(run(update_body(), [w], login="example-author", number=6).action, "rejected")

    def test_replayed_withdraw_is_idempotent(self):
        # the push worked but the reply failed: the same issue is seen again after the record was saved
        w = run(update_body(), [self.rec], login="example-author", number=5).record
        again = run(update_body(), [w], login="example-author", number=5)
        self.assertEqual(again.action, "already"); self.assertIn("withdrawn", again.labels); self.assertIsNone(again.record)

    def test_disputed_record_needs_maintainer(self):
        rec = fixture_record(status="disputed")
        r = run(update_body(), [rec], login="example-author")
        self.assertEqual(r.action, "held"); self.assertIsNone(r.record)
        forced = run(update_body(), [rec], login="example-author", force=True)
        self.assertEqual(forced.action, "withdrawn")

    def test_removed_cannot_be_withdrawn_even_when_approved(self):
        rec = fixture_record(status="removed")
        for force in (False, True):
            r = run(update_body(), [rec], login="example-author", force=force)
            self.assertEqual(r.action, "rejected", force); self.assertIsNone(r.record)

    def test_approved_non_owner_withdrawal_is_attributed_to_maintainer(self):
        r = run(update_body(), [self.rec], login="someone-else", force=True)
        self.assertEqual(r.action, "withdrawn")
        ev = r.record["history"][-1]
        self.assertEqual(ev["by"], "maintainer"); self.assertIn("maintainer", ev["note"])

    def test_approved_report_changes_nothing(self):
        self.assertEqual(run(update_body(action="report"), [self.rec], login="x", force=True).action, "ignored")

    def test_owner_identified_by_numeric_id(self):
        def go(login, uid):
            i = issue(5, update_body(), login, uid=uid)
            return process_issue(i, [self.rec], cfg(), TODAY, OLD).action
        self.assertEqual(go("renamed-account", 1001), "withdrawn")   # same account, new login
        self.assertEqual(go("example-author", 2002), "held")         # login re-registered by someone else


class Parse(unittest.TestCase):
    def test_detect(self):
        self.assertEqual(detect(parse_sections(register_body())), "register")
        self.assertEqual(detect(parse_sections(update_body())), "update")
        self.assertIsNone(detect(parse_sections("hello")))


if __name__ == "__main__":
    unittest.main()
