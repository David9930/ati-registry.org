"""Issue-form definitions. The YAML in .github/ISSUE_TEMPLATE is generated from here so that the
field labels the intake parser looks for can never drift from what the forms show.

    python -m ati.forms          # (re)write the YAML files
"""
from __future__ import annotations
import json
from pathlib import Path
from . import labels as L
from .records import ROOT, load_config

BASE = load_config()["base_url"]

UPDATE_ACTIONS = {
    "withdraw": "Withdraw my record",
    "report": "Report a problem with this record",
    "correct": "Request a correction to my record",
}

# (id, type, label, extra)
REGISTER = [
    ("intro", "markdown", None, {"value": (
        "Registration is **free**. Everything you enter below, and your GitHub username, will be **public and permanent**, "
        "like an ISBN record. Please do not include private information.\n\n"
        "This is a *self-declaration*: the registry does not verify it and it is not a certification. "
        f"Read the [label definitions]({BASE}/labels/) first.")}),
    ("title", "input", "Title of the work", {"required": True}),
    ("subtitle", "input", "Subtitle (optional)", {}),
    ("author", "input", "Author name as it appears on the book", {"required": True}),
    ("role", "dropdown", "Your role in relation to this work", {"required": True, "options": list(L.ROLES.values()),
        "description": "The registry does not verify this. Only the author, publisher or someone they have authorized may declare."}),
    ("isbn", "input", "ISBN (optional)", {"placeholder": "978-1-234-56789-7"}),
    ("year", "input", "Year this edition was published", {"required": True, "placeholder": "2026"}),
    ("edition", "input", "Edition (optional)", {"placeholder": "First Edition"}),
    ("formats", "checkboxes", "Formats this declaration covers", {"options": list(L.FORMATS.values())}),
    ("url", "input", "Link to the book's page (optional)", {"placeholder": "https://"}),
    ("label", "dropdown", "Label for the text of the work", {"required": True, "options": [v["form_option"] for v in L.LABELS.values()],
                                                             "description": "Who originated the content, and who wrote the sentences? See the definitions page."}),
    ("statement", "textarea", "In your own words, how was AI used (or not used) in this work?", {"required": True,
        "description": "20 to 1,500 characters. Be specific; readers will see this verbatim."}),
    ("ai_tools", "textarea", "AI tools used (one per line)", {"description": (
        "For each tool: name, provider, plan or tier (free or paid), and what it was used for. "
        "Example: Gemini, Google (free tier): cover art. Required if any AI was used for anything in the work."),
        "placeholder": "Claude, Anthropic (paid plan): editing and continuity checks"}),
    ("cover", "dropdown", "Cover art", {"required": True, "options": list(L.AI_USE.values())}),
    ("interior_art", "dropdown", "Interior illustrations or maps", {"required": True, "options": list(L.AI_USE.values())}),
    ("narration", "dropdown", "Audio narration", {"required": True, "options": list(L.AI_USE.values())}),
    ("translation", "dropdown", "Translation", {"required": True, "options": list(L.AI_USE.values())}),
    ("attest", "checkboxes", "Confirmations", {"options": list(L.ATTESTATIONS.values()), "all_required": True}),
]

UPDATE = [
    ("intro", "markdown", None, {"value": (
        "Use this form to **withdraw** your own record, to **report a problem** with any record, or to request a "
        "**correction** to your own record. This request is public. Do not include private information. "
        f"See [how disputes work]({BASE}/disputes/).")}),
    ("record_id", "input", "Record ID", {"required": True, "placeholder": "ATI-2026-000001"}),
    ("action", "dropdown", "What would you like to do?", {"required": True, "options": list(UPDATE_ACTIONS.values())}),
    ("details", "textarea", "Details", {"required": True, "description": "What is inaccurate, with evidence where you can, or why you are withdrawing or correcting."}),
    ("confirm", "checkboxes", "Confirmation", {"options": ["I understand this request is public."], "all_required": True}),
]


def label_of(fields, fid: str) -> str:
    return next(f[2] for f in fields if f[0] == fid)


def _y(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def to_yaml(name: str, description: str, title: str, labels: list[str], fields) -> str:
    out = [f"name: {_y(name)}", f"description: {_y(description)}", f"title: {_y(title)}",
           "labels: [" + ", ".join(_y(x) for x in labels) + "]", "body:"]
    for fid, typ, label, ex in fields:
        out.append(f"  - type: {typ}")
        if typ != "markdown":
            out.append(f"    id: {fid}")
        out.append("    attributes:")
        if typ == "markdown":
            out.append(f"      value: {_y(ex['value'])}")
        else:
            out.append(f"      label: {_y(label)}")
            if ex.get("description"):
                out.append(f"      description: {_y(ex['description'])}")
            if ex.get("placeholder"):
                out.append(f"      placeholder: {_y(ex['placeholder'])}")
            if typ in ("dropdown", "checkboxes"):
                out.append("      options:")
                for o in ex["options"]:
                    if typ == "dropdown":
                        out.append(f"        - {_y(o)}")
                    else:
                        out.append(f"        - label: {_y(o)}")
                        if ex.get("all_required"):
                            out.append("          required: true")
        if typ in ("input", "textarea", "dropdown") and ex.get("required"):
            out.append("    validations:")
            out.append("      required: true")
    return "\n".join(out) + "\n"


def render_all() -> dict[str, str]:
    cfgyml = ("blank_issues_enabled: false\ncontact_links:\n"
              f"  - name: ATI Registry website\n    url: {BASE}/\n"
              "    about: Definitions, how registration works, and the public registry.\n")
    return {
        "register.yml": to_yaml("Register a book", "Publish a free, public, self-declared AI-use label for a book.",
                                "[Register] ", ["register"], REGISTER),
        "update.yml": to_yaml("Withdraw or report a record", "Withdraw your record, or report a problem with a record.",
                              "[Record] ", ["record-update"], UPDATE),
        "config.yml": cfgyml,
    }


def main():
    d = ROOT / ".github" / "ISSUE_TEMPLATE"
    d.mkdir(parents=True, exist_ok=True)
    for name, text in render_all().items():
        (d / name).write_text(text, encoding="utf-8")
        print("wrote", d / name)


if __name__ == "__main__":
    main()
