import unittest
from ati.records import normalize_isbn, next_id, validate_record, load_records
from tests.helpers import fixture_record, FIX


class T(unittest.TestCase):
    def test_isbn(self):
        self.assertEqual(normalize_isbn("978-1-7386519-5-5"), "9781738651955")
        self.assertEqual(normalize_isbn("0-306-40615-2"), "9780306406157")
        self.assertIsNone(normalize_isbn("9781738651950"))
        self.assertIsNone(normalize_isbn("0-306-40615-X"))
        self.assertIsNone(normalize_isbn("abc"))
        self.assertIsNone(normalize_isbn(""))

    def test_next_id(self):
        self.assertEqual(next_id([], 2026), "ATI-2026-000001")
        self.assertEqual(next_id([{"id": "ATI-2026-000009"}, {"id": "ATI-2025-000500"}], 2026), "ATI-2026-000010")
        self.assertEqual(next_id([{"id": "ATI-2026-000009"}], 2027), "ATI-2027-000001")

    def test_fixture_valid(self):
        self.assertEqual(validate_record(fixture_record()), [])
        self.assertEqual(len(load_records(FIX)), 1)

    def test_repository_records_are_valid(self):
        # a broken record on main would stop intake, build and deploy for everyone
        from ati.records import ROOT
        load_records(ROOT / "records")

    def test_removal_scrub_is_valid_and_blank(self):
        import json
        from datetime import date
        from ati.records import scrub_removed
        rec = fixture_record()
        rec["history"].append({"date": "2026-10-09", "event": "corrected", "by": "x", "note": "SECRET-NOTE"})
        gone = scrub_removed(rec, date(2026, 10, 10), 12, "Impersonation")
        self.assertEqual(validate_record(gone), [])
        dump = json.dumps(gone)
        for leak in ("Finch", "Derek Devon", "9781738651955", "FIXTURE ONLY", "SECRET-NOTE", "Gemini", "thelastaxiom"):
            self.assertNotIn(leak, dump)
        self.assertEqual(gone["history"][-1]["event"], "removed")

    def test_invalid(self):
        for bad in ({"label": "gold"}, {"status": "ok"}, {"id": "X-1"}, {"statement": "short"}):
            self.assertTrue(validate_record(fixture_record(**bad)), bad)
        r = fixture_record(); r["work"]["isbn"] = "123"
        self.assertTrue(validate_record(r))
        r = fixture_record(); r["work"]["url"] = "javascript:alert(1)"
        self.assertTrue(validate_record(r))
        r = fixture_record(); r["extra"] = 1
        self.assertTrue(validate_record(r))


if __name__ == "__main__":
    unittest.main()
