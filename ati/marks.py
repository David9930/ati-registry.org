"""Vector marks: the ATI symbol (an A crossed by an orbit), circular badges and horizontal lockups.

All geometry lives here so the website, the downloadable kit and any book layout draw the same mark.
"""
from __future__ import annotations
import math
from html import escape
from .labels import LABELS

VB = 100  # symbol viewBox is 0 0 100 100
_CX, _CY, _RX, _RY, _ROT = 50.0, 66.0, 47.0, 12.5, -16.0


def _ring_points():
    t = math.radians(_ROT)
    dx, dy = _RX * math.cos(t), _RX * math.sin(t)
    return (_CX - dx, _CY - dy), (_CX + dx, _CY + dy)


def symbol_svg(label: str | None = "ai-master-edited", mono: str | None = None, uid: str = "s",
               star: bool = True, cls: str = "ati-symbol", title: str | None = None) -> str:
    """The A-and-orbit symbol. `label` picks the colour set; `mono` forces one flat colour."""
    L = LABELS.get(label or "", LABELS["ai-master-edited"])
    (x1, y1), (x2, y2) = _ring_points()
    if mono:
        a_fill = ring_fill = mono
        defs = ""
    else:
        a0, a1, a2 = L["a_stops"]
        r0, r1 = L["ring_stops"]
        a_fill, ring_fill = f"url(#a{uid})", f"url(#r{uid})"
        defs = (f'<linearGradient id="a{uid}" gradientUnits="userSpaceOnUse" x1="50" y1="8" x2="50" y2="96">'
                f'<stop offset="0" stop-color="{a0}"/><stop offset=".55" stop-color="{a1}"/><stop offset="1" stop-color="{a2}"/></linearGradient>'
                f'<linearGradient id="r{uid}" gradientUnits="userSpaceOnUse" x1="3" y1="70" x2="97" y2="60">'
                f'<stop offset="0" stop-color="{r0}"/><stop offset=".5" stop-color="{r1}"/><stop offset="1" stop-color="{r0}"/></linearGradient>')
    # Legs run from the apex vertex (50,22) to beyond the feet, clipped flat at y=96.
    legs = (f'<path d="M12 104 L50 22 L88 104" fill="none" stroke="{a_fill}" stroke-width="12.5" '
            f'stroke-linejoin="miter" stroke-miterlimit="6" clip-path="url(#c{uid})"/>')
    ring = (f'<ellipse cx="{_CX}" cy="{_CY}" rx="{_RX}" ry="{_RY}" transform="rotate({_ROT} {_CX} {_CY})" '
            f'fill="none" stroke="{ring_fill}" stroke-width="3.6"/>')
    # Front (lower) half of the orbit redrawn over the A so the ring appears to circle it.
    front = (f'<path d="M{x1:.2f} {y1:.2f} A{_RX} {_RY} {_ROT} 0 0 {x2:.2f} {y2:.2f}" fill="none" '
             f'stroke="{ring_fill}" stroke-width="3.6" stroke-linecap="round"/>')
    spark = ""
    if star:
        sc = mono or L["ring_stops"][0]
        spark = (f'<path d="M50 40 L52.2 47.8 L60 50 L52.2 52.2 L50 60 L47.8 52.2 L40 50 L47.8 47.8 Z" fill="{sc}" opacity=".95"/>')
    ttl = f"<title>{escape(title)}</title>" if title else ""
    role = 'role="img"' if title else 'aria-hidden="true" focusable="false"'
    return (f'<svg class="{cls}" viewBox="0 0 {VB} {VB}" xmlns="http://www.w3.org/2000/svg" {role}>{ttl}'
            f'<defs>{defs}<clipPath id="c{uid}"><rect x="0" y="0" width="100" height="96"/></clipPath></defs>'
            f'{ring}{legs}{spark}{front}</svg>')


def _star4(cx, cy, r, fill):
    k = r * 0.28
    return (f'<path d="M{cx} {cy - r} L{cx + k} {cy - k} L{cx + r} {cy} L{cx + k} {cy + k} L{cx} {cy + r} '
            f'L{cx - k} {cy + k} L{cx - r} {cy} L{cx - k} {cy - k} Z" fill="{fill}"/>')


def circle_badge_svg(label: str, uid: str = "b", id_text: str | None = None, mono: str | None = None,
                     cls: str = "ati-circle") -> str:
    """Circular badge: ring text, symbol, label name, tagline. 200x200 viewBox."""
    L = LABELS[label]
    col = mono or L["color"]
    ring = mono or f"url(#g{uid})"
    r0, r1 = L["ring_stops"]
    defs = "" if mono else (f'<linearGradient id="g{uid}" x1="0" y1="0" x2="1" y2="1">'
                            f'<stop offset="0" stop-color="{r0}"/><stop offset=".5" stop-color="{r1}"/><stop offset="1" stop-color="{r0}"/></linearGradient>')
    top = "AUTHORSHIP TRANSPARENCY IDENTIFIER"
    bottom = "SELF-DECLARED" if not id_text else f"SELF-DECLARED · {id_text}"
    name = L["name"].upper()
    sym = symbol_svg(label, mono=mono, uid=f"{uid}s", star=True, cls="")
    sym_inner = sym.replace('<svg class=""', '<svg x="62" y="40" width="76" height="76"', 1)
    return (
        f'<svg class="{cls}" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" '
        f'aria-label="{escape(L["name"])} – Authorship Transparency Identifier (self-declared)">'
        f'<defs>{defs}'
        f'<path id="t{uid}" d="M 18 100 A 82 82 0 0 1 182 100"/>'
        f'<path id="u{uid}" d="M 14 100 A 86 86 0 0 0 186 100"/></defs>'
        f'<circle cx="100" cy="100" r="96" fill="none" stroke="{ring}" stroke-width="3.2"/>'
        f'<circle cx="100" cy="100" r="68" fill="none" stroke="{ring}" stroke-width="1.4"/>'
        f'<text font-family="Inter,system-ui,sans-serif" font-weight="600" font-size="8.4" letter-spacing="1.5" fill="{col}" text-anchor="middle">'
        f'<textPath href="#t{uid}" startOffset="50%">{escape(top)}</textPath></text>'
        f'<text font-family="Inter,system-ui,sans-serif" font-weight="600" font-size="7.6" letter-spacing="1.4" fill="{col}" text-anchor="middle">'
        f'<textPath href="#u{uid}" startOffset="50%" side="left">{escape(bottom.upper())}</textPath></text>'
        f'{_star4(14, 100, 5.5, col)}{_star4(186, 100, 5.5, col)}'
        f'{sym_inner}'
        f'<text x="100" y="131" font-family="Inter,system-ui,sans-serif" font-weight="700" font-size="9" letter-spacing=".9" fill="{col}" text-anchor="middle">{escape(name)}</text>'
        f'</svg>')


def lockup_html(label: str, id_text: str | None = None, uid: str = "l", mono: str | None = None,
                small: bool = False) -> str:
    """Horizontal lockup: symbol | label name, tagline and self-declared line. Styled by site.css."""
    L = LABELS[label]
    sym = symbol_svg(label, mono=mono, uid=f"{uid}s", cls="ati-lockup-symbol", star=False)
    line3 = "Self-declared" + (f" · {escape(id_text)}" if id_text else "")
    tag = f'<small class="ati-lockup-tag">{escape(L["tagline"])}</small>' if label != "human-authored" else \
          '<small class="ati-lockup-tag">No generative AI wrote the text</small>'
    mono_cls = " ati-mono" if mono else ""
    sm = " ati-lockup-sm" if small else ""
    return (f'<span class="ati-lockup ati-{label}{mono_cls}{sm}" role="img" '
            f'aria-label="{escape(L["name"])} – Authorship Transparency Identifier, self-declared">'
            f'{sym}<span class="ati-lockup-sep"></span><span class="ati-lockup-txt">'
            f'<strong>{escape(L["name"].upper())}</strong>{tag}<small class="ati-lockup-self">{line3}</small></span></span>')
