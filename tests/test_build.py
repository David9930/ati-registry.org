import json, re, shutil, struct, tempfile, unittest
from pathlib import Path
from ati import labels as L
from ati.build import build
from ati.records import ROOT


class Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.out = cls.tmp / "dist"
        build(cls.out, quiet=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def read(self, rel):
        return (self.out / rel).read_text(encoding="utf-8")

    def pages(self):
        return [p for p in self.out.rglob("*.html") if "_app" not in p.parts]

    def test_pages_exist_and_nothing_registry_related_is_static(self):
        for rel in ("index.html", "labels/index.html", "registry/index.html", "marks/index.html", "about/index.html", "governance/index.html",
                    "support/index.html", "terms/index.html", "privacy/index.html", "disputes/index.html", "faq/index.html", "404.html", "robots.txt",
                    "sitemap.xml", "_headers", "static/css/site.css", "static/favicon.svg", "_app/shell.html", "_app/data.json"):
            self.assertTrue((self.out / rel).exists(), rel)
        for rel in ("register", "r", "api", "CNAME", ".nojekyll", "records"):
            self.assertFalse((self.out / rel).exists(), f"{rel} must not be a static file (the Worker serves it, or it is gone)")

    def test_no_github_references_remain_in_the_site(self):
        for p in self.out.rglob("*"):
            if p.is_file() and p.suffix in (".html", ".json", ".txt", ".xml", "") and "fonts" not in p.parts:
                self.assertNotIn("github", p.read_text(encoding="utf-8", errors="ignore").lower(), p)

    def test_no_third_party_requests_in_static_pages(self):
        for p in self.pages():
            h = p.read_text(encoding="utf-8")
            for m in re.finditer(r'<(?:script|link|img|iframe)[^>]+(?:src|href)="(https?://[^"]+)"', h):
                if 'rel="canonical"' in m.group(0):
                    continue
                self.fail(f"{p.name}: external resource {m.group(1)}")
            self.assertNotIn("@import", h)

    def test_csp_and_no_inline_scripts(self):
        for p in self.pages():
            h = p.read_text(encoding="utf-8")
            self.assertIn("Content-Security-Policy", h, p)
            self.assertIn("form-action 'self'", h, p)
            self.assertNotIn("frame-ancestors", h, p)   # not allowed in a meta tag; sent as a header instead
            self.assertNotRegex(h, r"\son[a-z]+=\"", str(p))
            for m in re.finditer(r"<script(?![^>]*src=)(?![^>]*application/ld\+json)[^>]*>", h):   # a JSON-LD block is data, not code
                self.fail(f"{p}: inline script {m.group(0)}")
        self.assertNotIn('rel="canonical"', self.read("404.html"))

    def test_worker_shell_has_each_placeholder_and_no_page_specific_head(self):
        h = self.read("_app/shell.html")
        for token in ("@@TITLE@@", "@@DESC@@", "@@CONTENT@@"):
            self.assertIn(token, h)
        self.assertEqual(h.count("@@CONTENT@@"), 1)
        self.assertNotIn("Content-Security-Policy", h)   # the Worker sends the policy as a header
        self.assertNotIn('rel="canonical"', h)
        self.assertNotIn("og:url", h)
        self.assertEqual(set(re.findall(r"@@([A-Z]+)@@", h)), {"TITLE", "DESC", "CONTENT"})

    def test_worker_data_matches_labels(self):
        d = json.loads(self.read("_app/data.json"))
        self.assertEqual(set(d["labels"]), set(L.LABELS))
        self.assertEqual(d["attestations"], L.ATTESTATIONS)
        self.assertEqual(d["parts"], L.PARTS)
        self.assertEqual(d["ai_use"], L.AI_USE)
        self.assertEqual(d["roles"], L.ROLES)
        self.assertEqual(d["definitions"]["0.1"]["human-authored"]["definition"], L.DEFINITIONS["human-authored"]["definition"])
        for key, lock in d["lockups"].items():
            self.assertIn("@@ID@@", lock["full"], key)
            self.assertNotIn("@@ID@@", lock["small"], key)
            for html in lock.values():
                self.assertIn("@@U@@", html)   # unique SVG ids per rendered lockup
        self.assertNotIn("{{", json.dumps(d))   # no unrendered template syntax
        self.assertIn("terms", d["attestations"])
        self.assertRegex(d["attestations"]["terms"], "released as open data")

    def test_register_page_content_is_split_around_the_form(self):
        r = json.loads(self.read("_app/data.json"))["register"]
        self.assertIn("confirm it is you", r["intro_html"])
        self.assertIn("What you will be asked", r["after_html"])
        self.assertNotIn("<!-- form -->", r["intro_html"] + r["after_html"])
        self.assertIn("/manage/lost", r["after_html"])

    def test_headers_robots_and_sitemap(self):
        h = self.read("_headers")
        for line in ("X-Content-Type-Options: nosniff", "X-Frame-Options: DENY", "Referrer-Policy: same-origin", "Strict-Transport-Security"):
            self.assertIn(line, h)
        robots = self.read("robots.txt")
        for path in ("/lookup", "/admin", "/manage/", "/verify", "/report"):
            self.assertIn(f"Disallow: {path}", robots)
        sm = self.read("sitemap.xml")
        self.assertIn("https://ati-registry.org/labels/", sm)
        for page in ("/register/", "/feedback/"):
            self.assertIn(f"https://ati-registry.org{page}", sm)
        self.assertNotIn("/r/", sm)

    def test_search_and_sharing_metadata(self):
        h = self.read("index.html")
        self.assertIn("<title>ATI Registry: public registry of AI use by authors</title>", h)
        self.assertIn("<h1>A public registry for authors who use AI, and those who don&rsquo;t</h1>", h)
        self.assertRegex(h, r'<meta name="description" content="[^"]*AI use by authors[^"]*">')
        for tag in ('property="og:image" content="https://ati-registry.org/static/og-image.png"', 'name="twitter:card" content="summary_large_image"',
                    'property="og:site_name"'):
            self.assertIn(tag, h)
        ld = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', h, re.S).group(1))
        self.assertEqual({n["@type"] for n in ld["@graph"]}, {"WebSite", "Organization"})
        self.assertIn('name="msvalidate.01" content="81A37D68E77BCD0AA051A75D369D12D5"', h)   # Bing Webmaster Tools ownership check
        self.assertNotIn("Derek", json.dumps(ld))   # the founder's display name is still an open decision
        png = (self.out / "static" / "og-image.png").read_bytes()
        self.assertEqual(struct.unpack(">II", png[16:24]), (1200, 630))
        self.assertIn("og:image", self.read("_app/shell.html"))
        self.assertIn("og:image", self.read("about/index.html"))
        self.assertIn("<title>About the registry · ATI Registry</title>", self.read("about/index.html"))

    def test_marks_example_is_generic(self):
        h = self.read("marks/index.html")
        self.assertIn("ATI-YYYY-NNNNNN-XXXX", h)
        self.assertNotIn("/r/ATI-YYYY-NNNNNN-XXXX/", h)

    def test_find_a_record_page_uses_get_lookup(self):
        h = self.read("registry/index.html")
        self.assertIn('action="/lookup"', h)
        self.assertIn('method="get"', h)
        self.assertNotIn("api/records", h)

    def test_mark_kit_is_tightly_cropped(self):
        m = json.loads((ROOT / "static" / "marks" / "manifest.json").read_text())
        for f in m["lockups"] + m["circles"]:
            head = (ROOT / "static" / "marks" / f["file"]).read_bytes()[:24]
            w, h = struct.unpack(">II", head[16:24])
            self.assertLessEqual(abs(w - f["w"] * 3), 6, f["file"])   # no stray transparent margin
            self.assertLessEqual(abs(h - f["h"] * 3), 6, f["file"])
        for f in m["circles"]:
            self.assertEqual(f["w"], f["h"], f["file"])

    def test_disclaimers_and_draft_banners(self):
        for rel in ("index.html", "labels/index.html"):
            self.assertIn("Not a certification", self.read(rel), rel)
        for s in ("terms", "privacy", "governance", "support"):
            self.assertIn("Draft v0.1", self.read(f"{s}/index.html"), s)

    def test_privacy_and_terms_describe_the_email_and_open_data_clauses(self):
        privacy, terms = self.read("privacy/index.html"), self.read("terms/index.html")
        self.assertIn("Your email address", privacy)
        self.assertIn("never published", privacy)
        self.assertIn("48 hours", privacy)
        self.assertIn("CC0", terms)
        self.assertIn("automated copying", terms)

    def test_about_has_the_code_review_section(self):
        h = self.read("about/index.html")
        self.assertIn("Review the site code", h)
        self.assertIn("mailto:hello@ati-registry.org", h)

    def test_faq_page_has_the_ai_disclosure_first_and_is_indexed(self):
        h = self.read("faq/index.html")
        disclosure = "[This FAQ was written by AI and reviewed by a human (Derek Devon)]"
        self.assertIn(disclosure, h)
        article = h[h.index('<article class="prose">'):]
        self.assertLess(article.index(disclosure), article.index("<h1>"))   # the disclosure is the first thing on the page
        self.assertIn("<title>AI Use Disclosure for Authors: FAQ · ATI Registry</title>", h)
        self.assertRegex(h, r'<meta name="description" content="[^"]*disclosing AI use in books[^"]*">')
        self.assertEqual(h.count("<h1>"), 1)
        self.assertGreater(h.count("<h3>"), 40)   # questions are real headings so they can match searches
        self.assertNotIn("{{", h)
        self.assertIn("https://ati-registry.org/faq/", self.read("sitemap.xml"))
        self.assertIn('href="/faq/"', self.read("index.html"))   # linked from the main navigation
        self.assertNotIn(disclosure, self.read("about/index.html"))   # only pages that set it show it

    def test_deterministic(self):
        again = self.tmp / "dist2"
        build(again, quiet=True)
        for rel in ("index.html", "registry/index.html", "_app/shell.html", "_app/data.json", "sitemap.xml", "_headers"):
            self.assertEqual((again / rel).read_text(), self.read(rel), rel)


if __name__ == "__main__":
    unittest.main()
