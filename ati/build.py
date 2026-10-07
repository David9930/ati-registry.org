"""Static site generator: records + templates + content -> dist/."""
from __future__ import annotations
import argparse, json, re, shutil, sys
from datetime import date
from html import escape
from pathlib import Path
import markdown
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup
from . import labels as L
from .marks import symbol_svg, lockup_html
from .records import ROOT, load_config, load_records

NAV = [("/labels/", "Labels"), ("/registry/", "Registry"), ("/register/", "Register"),
       ("/about/", "About"), ("/governance/", "Governance"), ("/support/", "Support")]
CONTENT_PAGES = ["register", "disputes", "terms", "privacy", "about", "governance", "support"]


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


def _norm(s: str) -> str:
    return re.sub(r"[\s\-]+", " ", s.lower()).strip()


def redact(r: dict) -> dict:
    """A removed record keeps only its ID, status and dates on the site, in search and in the open data."""
    if r["status"] != "removed":
        return r
    removed_on = next((h["date"] for h in reversed(r["history"]) if h["event"] == "removed"), r["updated"])
    return {"id": r["id"], "status": "removed", "registered": r["registered"], "updated": r["updated"], "removed_on": removed_on}


def _jsonld(r: dict, cfg: dict) -> str:
    w = r["work"]
    data = {
        "@context": "https://schema.org", "@type": "Book", "name": w["title"],
        "author": {"@type": "Person", "name": w["author"]}, "datePublished": str(w["year"]),
        "identifier": r["id"], "url": f'{cfg["base_url"]}/r/{r["id"]}/',
        "description": f'ATI Registry self-declared label: {L.LABELS[r["label"]]["name"]} (status: {r["status"]}). Not verified.',
    }
    if w.get("isbn"):
        data["isbn"] = w["isbn"]
    out = json.dumps(data, ensure_ascii=False)
    return out.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def build(out: Path, records_dir: Path | None = None, config_path: Path | None = None, quiet: bool = False, strict: bool = False) -> dict:
    cfg = load_config(config_path)
    repo = cfg.get("repo", "")
    placeholder = (not repo) or "OWNER" in repo
    repo_url = "" if placeholder else f"https://github.com/{repo}"
    cfg["repo_url"] = repo_url or "#"
    cfg["register_url"] = f"{repo_url}/issues/new?template=register.yml" if repo_url else "#"
    cfg["update_url"] = f"{repo_url}/issues/new?template=update.yml" if repo_url else "#"
    if placeholder and strict:
        raise SystemExit("config.repo is a placeholder; set it to OWNER/REPO before deploying.")
    if placeholder and not quiet:
        print("WARNING: config.repo is a placeholder; registration links will not work until it is set.", file=sys.stderr)

    full = sorted(load_records(records_dir or ROOT / "records"), key=lambda r: r["id"])
    records = [redact(r) for r in full]  # everything below, including the open data, sees only the public view
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
    ex = next((r for r in records if r["status"] == "active"), None)
    example = {"id": ex["id"] if ex else "ATI-YYYY-NNNNNN",
               "name": L.LABELS[ex["label"]]["name"] if ex else "AI Master Edited"}

    base = dict(
        cfg=cfg, repo_url=repo_url, nav=NAV, labels=L.LABELS, definitions=L.DEFINITIONS,
        ai_use=L.AI_USE, ai_use_short=L.AI_USE_SHORT, kit=kit, example=example,
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
        return env.get_template(tpl).render(**base, path=path, **ctx)

    active = [r for r in records if r["status"] == "active"]
    recent = sorted(active, key=lambda r: (r["registered"], r["id"]), reverse=True)[:6]
    write("index.html", render("home.html", "/", recent=recent, total=len(records)), "/")
    write("labels/index.html", render("labels.html", "/labels/", page_title="The labels",
          description="The three labels and how to choose between them."), "/labels/")
    for r in records:
        r["_search"] = _norm(r["id"]) if r["status"] == "removed" else _norm(" ".join([
            r["id"], r["work"]["title"], r["work"].get("subtitle", ""), r["work"]["author"],
            r["work"].get("isbn", ""), L.LABELS[r["label"]]["name"]]))
    write("registry/index.html", render("registry.html", "/registry/", page_title="The registry", records=records,
          total=len(records), description="Browse and search all registered declarations."), "/registry/")
    write("marks/index.html", render("marks.html", "/marks/", page_title="The marks",
          description="Download the ATI marks and see how to use them."), "/marks/")

    for r in records:
        if r["status"] == "removed":
            write(f'r/{r["id"]}/index.html', render("removed.html", f'/r/{r["id"]}/', page_title=f'{r["id"]} · removed', r=r,
                  noindex=True, description="This record was removed by the registry."), f'/r/{r["id"]}/')
            continue
        defs = L.DEFINITIONS_BY_VERSION.get(r["definitions_version"])
        definition_text = defs[r["label"]]["definition"] if defs else None
        comps = [{"part": L.PARTS[c["part"]], "use": L.AI_USE_SHORT[c["ai_use"]]} for c in r["components"]]
        withdrawn_on = next((h["date"] for h in reversed(r["history"]) if h["event"] == "withdrawn"), r["updated"])
        title = r["work"]["title"] + (f': {r["work"]["subtitle"]}' if r["work"].get("subtitle") else "")
        html = render("record.html", f'/r/{r["id"]}/', page_title=f'{r["id"]} · {title}', r=r,
                      L=L.LABELS[r["label"]], components=comps, withdrawn_on=withdrawn_on,
                      definition_text=definition_text, role=L.ROLE_SHORT[r["declared_by"]["role"]],
                      formats=[L.FORMATS[f] for f in r["work"].get("formats", [])],
                      jsonld=_jsonld(r, cfg), report_url=f'{cfg["update_url"]}&record_id={r["id"]}' if repo_url else "#",
                      description=f'{L.LABELS[r["label"]]["name"]}: self-declared AI-use label for {r["work"]["title"]} by {r["work"]["author"]}.')
        write(f'r/{r["id"]}/index.html', html, f'/r/{r["id"]}/')

    mdx = markdown.Markdown(extensions=["tables", "attr_list", "sane_lists", "md_in_html"])
    for slug in CONTENT_PAGES:
        meta, body = _frontmatter((ROOT / "content" / f"{slug}.md").read_text(encoding="utf-8"))
        body = md_env.from_string(body).render(cfg=cfg, repo_url=repo_url)
        mdx.reset()
        write(f"{slug}/index.html", render("page.html", f"/{slug}/", page_title=meta.get("title", slug.title()),
              eyebrow=meta.get("eyebrow"), description=meta.get("description"), draft=bool(meta.get("draft")),
              draft_note=meta.get("draft_note"), body=Markup(mdx.convert(body))), f"/{slug}/")
    write("404.html", render("page.html", "/404", page_title="Page not found", eyebrow="404",
          body=Markup('<p>That page does not exist. Try the <a href="/registry/">registry</a> or the <a href="/">home page</a>.</p>')))

    # Open data
    api = out / "api" / "records"
    api.mkdir(parents=True)
    for r in records:
        r.pop("_search", None)
        (api / f'{r["id"]}.json').write_text(json.dumps({**r, "url": f'{cfg["base_url"]}/r/{r["id"]}/'}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (out / "api" / "records.json").write_text(json.dumps({
        "registry": cfg["long_name"], "count": len(records), "license": "CC0-1.0",
        "schema": f'{cfg["base_url"]}/schema/record.schema.json', "records": records}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (out / "schema").mkdir()
    shutil.copy(ROOT / "schema" / "record.schema.json", out / "schema" / "record.schema.json")

    fav = symbol_svg("ai-master-edited", uid="fv", star=False).replace('aria-hidden="true" focusable="false"', "").replace(' class="ati-symbol"', "")
    (out / "static" / "favicon.svg").write_text(fav, encoding="utf-8")
    (out / "CNAME").write_text(cfg["domain"] + "\n", encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    (out / "robots.txt").write_text(f'User-agent: *\nAllow: /\nSitemap: {cfg["base_url"]}/sitemap.xml\n', encoding="utf-8")
    sm = "".join(f'<url><loc>{escape(cfg["base_url"] + u)}</loc></url>' for u in sorted(urls))
    (out / "sitemap.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{sm}</urlset>\n', encoding="utf-8")
    if not quiet:
        print(f"built {len(records)} record(s), {len(urls)} pages -> {out}")
    return {"records": len(records), "pages": len(urls)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist"))
    ap.add_argument("--records", default=None)
    ap.add_argument("--strict", action="store_true", help="fail instead of warning when config.repo is a placeholder")
    a = ap.parse_args(argv)
    build(Path(a.out), Path(a.records) if a.records else None, strict=a.strict)


if __name__ == "__main__":
    main()
