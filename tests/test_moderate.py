import json, shutil, tempfile, unittest
from datetime import date
from pathlib import Path
from ati import moderate
from ati.build import build
from ati.records import load_records, save_record
from tests.helpers import fixture_record


class Moderate(unittest.TestCase):
    def test_remove_then_build_leaks_nothing(self):
        d = Path(tempfile.mkdtemp())
        try:
            (d / "records").mkdir()
            save_record(d / "records", fixture_record())
            moderate.remove(d / "records", "ATI-2026-000001", 12, "Impersonation", date(2026, 10, 10))
            rec = load_records(d / "records")[0]
            self.assertEqual(rec["status"], "removed")
            build(d / "dist", d / "records", quiet=True)
            for p in (d / "dist").rglob("*"):
                if p.is_file() and p.suffix in (".html", ".json", ".xml") and "schema" not in p.name:
                    t = p.read_text(encoding="utf-8")
                    for leak in ("Finch", "Derek Devon", "FIXTURE ONLY", "9781738651955"):
                        if p.name == "index.html" and p.parent.name == "about":
                            continue
                        self.assertNotIn(leak, t, f"{leak} in {p}")
            with self.assertRaises(SystemExit):
                moderate.remove(d / "records", "ATI-2026-000001", None, None, date(2026, 10, 11))   # already removed
            with self.assertRaises(SystemExit):
                moderate.remove(d / "records", "ATI-2026-999999", None, None, date(2026, 10, 11))
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
