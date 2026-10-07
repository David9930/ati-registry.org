import json, re, shutil, tempfile, unittest
from pathlib import Path
from ati.build import build
from ati.records import save_record, ROOT
from tests.helpers import fixture_record


class Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        rec = cls.tmp / "records"; rec.mkdir()
        save_record(rec, fixture_record())
        evil = fixture_record(id="ATI-2026-000002")
        evil["work"].update(title='</title><script>alert("t")</script>', author='"><img src=x onerror=alert(1)>', url="https://example.com/?a=1&b=2")
        evil["work"].pop("isbn")
        evil["statement"] = "x" * 10 + "</script><script>alert(2)</script>" + "y" * 10
        evil["ai_tools"] = ["<b>bold</b> tool"]
        evil["history"][0]["issue"] = 2
        save_record(rec, evil)
        wd = fixture_record(id="ATI-2026-000003", status="withdrawn")
        wd["work"]["isbn"] = "9780306406157"
        wd["history"].append({"date": "2026-10-09", "event": "withdrawn", "by": "example-author", "issue": 9})
        save_record(rec, wd)
        gone = fixture_record(id="ATI-2026-000004", status="removed")
        gone["work"].update(title="Secretly Removed Title", author="Removed Person", isbn="9780306406157")
        gone["statement"] = "REMOVED-STATEMENT-MARKER " + "z" * 20
        gone["history"].append({"date": "2026-10-10", "event": "removed", "by": "maintainer", "issue": 11, "note": "REMOVED-NOTE-MARKER"})
        save_record(rec, gone)
        old = fixture_record(id="ATI-2026-000005", definitions_version="9.9")
        old["work"].pop("isbn")
        save_record(rec, old)
        cls.out = cls.tmp / "dist"
        cls.stats = build(cls.out, rec, quiet=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def read(self, rel):
        return (self.out / rel).read_text(encoding="utf-8")

    def test_pages_exist(self):
        for rel in ("index.html", "labels/index.html", "registry/index.html", "marks/index.html", "register/index.html", "about/index.html",
                    "governance/index.html", "support/index.html", "terms/index.html", "privacy/index.html", "disputes/index.html",
                    "404.html", "r/ATI-2026-000001/index.html", "api/records.json", "api/records/ATI-2026-000001.json",
                    "schema/record.schema.json", "robots.txt", "sitemap.xml", "CNAME", ".nojekyll", "static/css/site.css", "static/favicon.svg"):
            self.assertTrue((self.out / rel).exists(), rel)
        self.assertEqual(self.read("CNAME").strip(), "ati-registry.org")

    def test_user_text_is_escaped(self):
        for rel in ("r/ATI-2026-000002/index.html", "registry/index.html", "index.html"):
            h = self.read(rel)
            self.assertNotIn("<script>alert", h, rel)
            self.assertNotIn("<img src=x", h, rel)
            self.assertNotIn("<b>bold</b>", h, rel)
        h = self.read("r/ATI-2026-000002/index.html")
        self.assertIn("&lt;img src=x onerror=alert(1)&gt;", h.replace("&#34;", '"').replace("&#39;", "'"))
        # exactly one JSON-LD block and it cannot be closed early by user text
        ld = re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S)
        self.assertEqual(len(ld), 1)
        self.assertNotIn("<", ld[0])
        json.loads(ld[0])

    def test_no_third_party_requests(self):
        for p in self.out.rglob("*.html"):
            h = p.read_text(encoding="utf-8")
            for m in re.finditer(r'<(?:script|link|img|iframe)[^>]+(?:src|href)="(https?://[^"]+)"', h):
                if 'rel="canonical"' in m.group(0) or 'rel="alternate"' in m.group(0):
                    continue
                self.fail(f"{p.name}: external resource {m.group(1)}")
            self.assertNotIn("@import", h)

    def test_withdrawn_banner_and_status(self):
        h = self.read("r/ATI-2026-000003/index.html")
        self.assertIn("Withdrawn.", h); self.assertIn("2026-10-09", h)

    def test_api_matches_records(self):
        d = json.loads(self.read("api/records.json"))
        self.assertEqual(d["count"], 5)
        self.assertEqual(d["license"], "CC0-1.0")
        self.assertTrue(all("_search" not in r for r in d["records"]))

    def test_removed_record_is_redacted_everywhere(self):
        markers = ("Secretly Removed", "Removed Person", "REMOVED-STATEMENT", "REMOVED-NOTE", "9780306406157")
        page = self.read("r/ATI-2026-000004/index.html")
        self.assertIn("Record removed", page); self.assertIn("2026-10-10", page); self.assertIn('content="noindex"', page)
        for rel in ("r/ATI-2026-000004/index.html", "registry/index.html", "index.html", "api/records.json", "api/records/ATI-2026-000004.json"):
            h = self.read(rel)
            if rel == "registry/index.html":
                h = h.replace("9780306406157", "")   # the withdrawn record 000003 legitimately carries this ISBN
            if rel == "api/records.json":
                h = json.dumps([r for r in json.loads(h)["records"] if r["id"] == "ATI-2026-000004"])
            for m in markers:
                self.assertNotIn(m, h, f"{m} leaked into {rel}")
        tomb = json.loads(self.read("api/records/ATI-2026-000004.json"))
        self.assertEqual(set(tomb), {"id", "status", "registered", "updated", "removed_on", "url"})

    def test_definitions_follow_record_version(self):
        h = self.read("r/ATI-2026-000005/index.html")
        self.assertIn("definitions v9.9", h)
        self.assertNotIn("originate with the human author", h)
        self.assertIn("originate with the human author", self.read("r/ATI-2026-000001/index.html"))

    def test_declarant_role_shown_with_caveat(self):
        h = self.read("r/ATI-2026-000001/index.html")
        self.assertIn("as the author of the work", h)
        self.assertIn("does not confirm this role", h)

    def test_csp_and_no_inline_scripts(self):
        for p in self.out.rglob("*.html"):
            h = p.read_text(encoding="utf-8")
            self.assertIn("Content-Security-Policy", h, p)
            self.assertNotRegex(h, r"\son[a-z]+=\"", str(p))
            for m in re.finditer(r"<script(?![^>]*(?:src=|type=\"application/ld\+json\"))[^>]*>", h):
                self.fail(f"{p}: inline script {m.group(0)}")
        self.assertNotIn('rel="canonical"', self.read("404.html"))

    def test_external_links_are_ugc_nofollow(self):
        self.assertIn('rel="nofollow noopener noreferrer ugc"', self.read("r/ATI-2026-000001/index.html"))

    def test_strict_fails_on_placeholder_repo(self):
        import json as _j
        cfgp = self.tmp / "cfg.json"
        c = _j.loads((ROOT / "config.json").read_text()); c["repo"] = "OWNER/REPO"
        cfgp.write_text(_j.dumps(c))
        with self.assertRaises(SystemExit):
            build(self.tmp / "dist3", self.tmp / "records", cfgp, quiet=True, strict=True)
        build(self.tmp / "dist3", self.tmp / "records", cfgp, quiet=True)   # non-strict only warns

    def test_marks_example_is_generic_without_records(self):
        empty = self.tmp / "empty"; empty.mkdir()
        build(self.tmp / "dist4", empty, quiet=True)
        h = (self.tmp / "dist4" / "marks" / "index.html").read_text()
        self.assertIn("ATI-YYYY-NNNNNN", h)

    def test_mark_kit_is_tightly_cropped(self):
        import struct
        m = json.loads((ROOT / "static" / "marks" / "manifest.json").read_text())
        for f in m["lockups"] + m["circles"]:
            head = (ROOT / "static" / "marks" / f["file"]).read_bytes()[:24]
            w, h = struct.unpack(">II", head[16:24])
            self.assertLessEqual(abs(w - f["w"] * 3), 6, f["file"])   # no stray transparent margin
            self.assertLessEqual(abs(h - f["h"] * 3), 6, f["file"])
        for f in m["circles"]:
            self.assertEqual(f["w"], f["h"], f["file"])

    def test_sitemap(self):
        s = self.read("sitemap.xml")
        self.assertIn("https://ati-registry.org/r/ATI-2026-000001/", s)
        self.assertIn("https://ati-registry.org/labels/", s)

    def test_disclaimers_present(self):
        for rel in ("index.html", "r/ATI-2026-000001/index.html", "labels/index.html"):
            self.assertIn("Not a certification", self.read(rel), rel)
        self.assertIn("Self-declared, not verified", self.read("r/ATI-2026-000001/index.html"))

    def test_draft_banners(self):
        for s in ("terms", "privacy", "governance", "support"):
            self.assertIn("Draft v0.1", self.read(f"{s}/index.html"), s)

    def test_deterministic(self):
        again = self.tmp / "dist2"
        build(again, self.tmp / "records", quiet=True)
        for rel in ("index.html", "registry/index.html", "r/ATI-2026-000001/index.html", "api/records.json", "sitemap.xml"):
            self.assertEqual((again / rel).read_text(), self.read(rel), rel)


if __name__ == "__main__":
    unittest.main()
