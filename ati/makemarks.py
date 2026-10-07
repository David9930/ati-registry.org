"""Render the downloadable mark kit (transparent PNGs, symbol SVGs) into static/marks/.

Needs Playwright + Chromium; run locally when the marks change and commit the output:
    python -m ati.makemarks
"""
from __future__ import annotations
import functools, http.server, json, shutil, socketserver, tempfile, threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from .labels import LABELS
from .marks import circle_badge_svg, lockup_html, symbol_svg
from .records import ROOT

OUT = ROOT / "static" / "marks"
SCALE = 3


def _page(body: str) -> str:
    return ('<!doctype html><html data-theme="light"><head><meta charset="utf-8">'
            '<link rel="stylesheet" href="/static/css/site.css">'
            '<style>html,body{background:transparent!important;margin:0}body{display:block!important;min-height:0!important}'
            '.slot{display:inline-block;width:max-content;padding:0;margin:0}</style>'
            f'</head><body>{body}</body></html>')


def make() -> dict:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    tmp = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT / "static", tmp / "static", ignore=shutil.ignore_patterns("marks"))
    items: list[tuple[str, str, str, str]] = []  # (group, file, html, caption)
    for key, L in LABELS.items():
        for mono, suffix, cap in ((None, "", "colour"), ("#111111", "-black", "black, one colour")):
            items.append(("lockups", f"ati-{key}-horizontal{suffix}.png",
                          f'<span class="slot" id="t">{lockup_html(key, None, "k", mono)}</span>',
                          f'{L["name"]}, horizontal, {cap}'))
            svg = circle_badge_svg(key, uid="k", mono=mono, cls="ati-circle").replace('class="ati-circle"', 'class="ati-circle" style="width:200px;height:200px"')
            items.append(("circles", f"ati-{key}-circle{suffix}.png", f'<span class="slot" id="t">{svg}</span>',
                          f'{L["name"]}, circular badge, {cap}'))

    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(H, directory=str(tmp))
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    manifest = {"lockups": [], "circles": [], "symbols": []}
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(device_scale_factor=SCALE, viewport={"width": 700, "height": 500})
        pg = ctx.new_page()
        for n, (group, fname, html, cap) in enumerate(items):
            (tmp / f"kit{n}.html").write_text(_page(html), encoding="utf-8")
            pg.goto(f"http://127.0.0.1:{port}/kit{n}.html")
            pg.evaluate("document.fonts.ready")
            pg.wait_for_timeout(150)
            el = pg.locator("#t")
            box = el.bounding_box()
            el.screenshot(path=str(OUT / fname), omit_background=True)
            manifest[group].append({"file": fname, "alt": f"{cap} – Authorship Transparency Identifier mark",
                                    "caption": cap, "w": round(box["width"]), "h": round(box["height"])})
        b.close()
    srv.shutdown()
    shutil.rmtree(tmp)

    for key, L in LABELS.items():
        (OUT / f"ati-symbol-{key}.svg").write_text(
            symbol_svg(key, uid="y", cls="ati-symbol").replace('aria-hidden="true" focusable="false"', 'role="img"').replace("<svg ", f'<svg width="400" height="400" ', 1) + "\n", encoding="utf-8")
        manifest["symbols"].append({"file": f"ati-symbol-{key}.svg", "alt": f'{L["name"]} symbol', "caption": f'{L["name"]} colours', "bg": "transparent"})
    for name, col, bg in (("black", "#111111", "transparent"), ("white", "#ffffff", "#0d1f45")):
        (OUT / f"ati-symbol-{name}.svg").write_text(
            symbol_svg(None, mono=col, uid="y", cls="ati-symbol").replace('aria-hidden="true" focusable="false"', 'role="img"').replace("<svg ", '<svg width="400" height="400" ', 1) + "\n", encoding="utf-8")
        manifest["symbols"].append({"file": f"ati-symbol-{name}.svg", "alt": f"Symbol, {name}", "caption": f"{name.title()}, one colour", "bg": bg})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    m = make()
    print({k: len(v) for k, v in m.items()})
