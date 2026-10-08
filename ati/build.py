"""Static site generator: templates + content -> dist/.

Builds the pages that do not depend on registry data. Registry pages (record pages, lookup results, the registration
form, record management and the admin page) are rendered at request time by the Worker, which reads the files this
script writes to dist/_app/ so that those pages share the site's look, labels and wording.
"""
from __future__ import annotations
import argparse, json, re, shutil
from html import escape
from pathlib import Path
import markdown
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup
from . import labels as L
from .marks import symbol_svg, lockup_html
from .records import ROOT, load_config

NAV = [("/labels/", "Labels"), ("/registry/", "Find a record"), ("/register/", "Register"),
       ("/about/", "About"), ("/governance/", "Governance"), ("/support/", "Support")]
CONTENT_PAGES = ["disputes", "terms", "privacy", "about", "governance", "support"]
FORM_MARKER = "<!-- form -->"

HEADERS = """/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Strict-Transport-Security: max-age=31536000

/static/*
  Cache-Control: public, max-age=86400
"""


def _frontmatter(text: str):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            v = v.strip()
            meta[k.strip()] = (v.lower() == "true") if v.lower() in ("true", "false") else v
    return meta, m.group(2)


def _app_data(cfg: dict, register: dict) -> dict:
    """Everything the Worker needs from labels.py, so the two can never drift apart."""
    lockups = {}
    for key, lab in L.LABELS.items():
        # '@@U@@' becomes a number per rendered lockup (unique SVG ids); '@@ID@@' becomes the record ID.
        lockups[key] = {"full": lockup_html(key, "@@ID@@", f"{lab['abbr'].lower()}@@U@@f"),
                        "small": lockup_html(key, None, f"{lab['abbr'].lower()}@@U@@s", small=True)}
    return {
        "name": cfg["name"], "long_name": cfg["long_name"], "base_url": cfg["base_url"],
        "contact_email": cfg.get("contact_email", ""), "definitions_version": cfg["definitions_version"],
        "labels": {k: {f: v[f] for f in ("name", "abbr", "short", "tagline")} for k, v in L.LABELS.items()},
        "definitions": L.DEFINITIONS_BY_VERSION, "parts": L.PARTS, "ai_use": L.AI_USE, "ai_use_short": L.AI_USE_SHORT,
        "formats": L.FORMATS, "roles": L.ROLES, "role_short": L.ROLE_SHORT, "attestations": L.ATTESTATIONS,
        "lockups": lockups, "register": register,
    }


def build(out: Path, config_path: Path | None = None, quiet: bool = False) -> dict:
    cfg = load_config(config_path)
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copytree(ROOT / "static", out / "static")

    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=select_autoescape(["html"]),
                      trim_blocks=True, lstrip_blocks=True)
    md_env = Environment(autoescape=False)  # repo-authored markdown only; never user data
    manifest_path = ROOT / "static" / "marks" / "manifest.json"
    kit = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"lockups": [], "circles": [], "symbols": []}
    example = {"id": f"{cfg['id_prefix']}-YYYY-NNNNNN-XXXX", "name": L.LABELS["ai-master-edited"]["name"]}

    base = dict(
        cfg=cfg, nav=NAV, labels=L.LABELS, definitions=L.DEFINITIONS,
        ai_use=L.AI_USE, ai_use_short=L.AI_USE_SHORT, kit=kit, example=example, shell=False,
        symbol=lambda label=None, uid="s", mono=None: Markup(symbol_svg(label, mono=mono, uid=uid)),
        lockup=lambda label, rid=None, uid="l", small=False, mono=None: Markup(lockup_html(label, rid, uid, mono, small)),
    )
    urls: list[str] = []

    def write(rel: str, html: str, url: str | None = None):
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(html, encoding="utf-8")
        if url:
            urls.append(url)

    def render(tpl: str, path: str, **ctx):
        return env.get_template(tpl).render(**{**base, "path": path, **ctx})

    write("index.html", render("home.html", "/"), "/")
    write("labels/index.html", render("labels.html", "/labels/", page_title="The labels",
          description="The three labels and how to choose between them."), "/labels/")
    write("registry/index.html", render("registry.html", "/registry/", page_title="Find a record",
          description="Look up a registered declaration by ID, ISBN, title or author."), "/registry/")
    write("marks/index.html", render("marks.html", "/marks/", page_title="The marks",
          description="Download the ATI marks and see how to use them."), "/marks/")

    mdx = markdown.Markdown(extensions=["tables", "attr_list", "sane_lists", "md_in_html"])

    def md(body: str) -> Markup:
        mdx.reset()
        return Markup(mdx.convert(md_env.from_string(body).render(cfg=cfg)))

    for slug in CONTENT_PAGES:
        meta, body = _frontmatter((ROOT / "content" / f"{slug}.md").read_text(encoding="utf-8"))
        write(f"{slug}/index.html", render("page.html", f"/{slug}/", page_title=meta.get("title", slug.title()),
              eyebrow=meta.get("eyebrow"), description=meta.get("description"), draft=bool(meta.get("draft")),
              draft_note=meta.get("draft_note"), body=md(body)), f"/{slug}/")
    write("404.html", render("page.html", "/404", page_title="Page not found", eyebrow="404",
          body=Markup('<p>That page does not exist. Try <a href="/registry/">finding a record</a> or the <a href="/">home page</a>.</p>')))

    # Files for the Worker's dynamic pages.
    rmeta, rbody = _frontmatter((ROOT / "content" / "register.md").read_text(encoding="utf-8"))
    before, _, after = rbody.partition(FORM_MARKER)
    register = {"title": rmeta.get("title", "Register a book"), "eyebrow": rmeta.get("eyebrow", ""),
                "description": rmeta.get("description", ""), "intro_html": str(md(before)), "after_html": str(md(after))}
    write("_app/shell.html", render("shell.html", "@@PATH@@", page_title="@@TITLE@@", description="@@DESC@@", shell=True))
    write("_app/data.json", json.dumps(_app_data(cfg, register), indent=1, ensure_ascii=False) + "\n")

    fav = symbol_svg("ai-master-edited", uid="fv", star=False).replace('aria-hidden="true" focusable="false"', "").replace(' class="ati-symbol"', "")
    (out / "static" / "favicon.svg").write_text(fav, encoding="utf-8")
    (out / "_headers").write_text(HEADERS, encoding="utf-8")
    (out / "robots.txt").write_text(
        f'User-agent: *\nAllow: /\nDisallow: /lookup\nDisallow: /admin\nDisallow: /manage/\nDisallow: /verify\nDisallow: /report\n'
        f'Sitemap: {cfg["base_url"]}/sitemap.xml\n', encoding="utf-8")
    sm = "".join(f'<url><loc>{escape(cfg["base_url"] + u)}</loc></url>' for u in sorted(urls))
    (out / "sitemap.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{sm}</urlset>\n', encoding="utf-8")
    if not quiet:
        print(f"built {len(urls)} pages -> {out}")
    return {"pages": len(urls)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist"))
    a = ap.parse_args(argv)
    build(Path(a.out))


if __name__ == "__main__":
    main()
