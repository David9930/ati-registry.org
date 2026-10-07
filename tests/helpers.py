import json
from pathlib import Path
from ati import forms, labels as L

FIX = Path(__file__).parent / "fixtures"

GOOD = {
    "title": "Test Book", "subtitle": "", "role": L.ROLES["author"], "author": "A. Writer", "isbn": "978-0-306-40615-7", "year": "2026", "edition": "First Edition",
    "formats": ["Ebook"], "url": "https://example.com/book", "label": "AI Master Edited (AME)",
    "statement": "The story is mine. An AI assistant edited and checked continuity; I approved every change.",
    "ai_tools": "Claude, Anthropic (paid plan): editing and continuity checks",
    "cover": L.AI_USE["generated"], "interior_art": L.AI_USE["na"], "narration": L.AI_USE["na"], "translation": L.AI_USE["na"],
    "attest": list(L.ATTESTATIONS.values()),
}


def register_body(**over):
    a = {**GOOD, **over}
    parts = []
    for fid, typ, label, ex in forms.REGISTER:
        if typ == "markdown":
            continue
        v = a.get(fid, "")
        if typ == "checkboxes":
            opts = ex["options"]
            lines = [f"- [{'X' if o in v else ' '}] {o}" for o in opts]
            val = "\n".join(lines)
        else:
            val = v if v != "" else "_No response_"
        parts.append(f"### {label}\n\n{val}")
    return "\n\n".join(parts)


def update_body(record_id="ATI-2026-000001", action="withdraw", details="Because.", confirm=True):
    return "\n\n".join([
        f"### Record ID\n\n{record_id}",
        f"### What would you like to do?\n\n{forms.UPDATE_ACTIONS[action]}",
        f"### Details\n\n{details}",
        f"### Confirmation\n\n- [{'X' if confirm else ' '}] I understand this request is public."])


def issue(number, body, login="author1", bot=False, labels=(), uid=None):
    return {"number": number, "body": body, "user": {"login": login, "type": "Bot" if bot else "User", "id": uid},
            "labels": [{"name": n} for n in labels]}


def cfg():
    from ati.records import load_config
    c = load_config()
    c["update_url"] = "https://github.com/o/r/issues/new?template=update.yml"
    return c


def fixture_record(**over):
    r = json.loads((FIX / "ATI-2026-000001.json").read_text())
    r.update(over)
    return r
