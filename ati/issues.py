"""Turn a GitHub issue (from the register or update form) into a registry action.

Pure functions over plain dicts so the whole flow is testable without GitHub.
Issue content is untrusted input: it is parsed as data, normalised, validated, length-limited and only
ever rendered through an auto-escaping template. No submitted text is echoed back into issue comments.
"""
from __future__ import annotations
import ipaddress, re, unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from urllib.parse import urlsplit
from . import forms, labels as L
from .records import ID_RE, next_id, normalize_isbn, validate_record

NO_RESPONSE = "_No response_"
# Invisible "filler" characters that render as blank but are not whitespace.
FILLERS = {"ㅤ", "⠀", "ᅟ", "ᅠ", "ﾠ", "͏", "឴", "឵"}
KEEP_FORMAT = {"‌", "‍"}  # ZWNJ / ZWJ are needed by some scripts and emoji


@dataclass
class Result:
    number: int
    action: str                      # created | rejected | held | withdrawn | ignored | already
    message: str = ""
    close: bool = False
    labels: list[str] = field(default_factory=list)
    record_id: str | None = None
    record: dict | None = None       # new or changed record to persist


def parse_sections(body: str) -> dict[str, str]:
    """Issue-form bodies are '### Label' headings followed by the answer."""
    out: dict[str, str] = {}
    cur, buf = None, []
    for line in (body or "").replace("\r\n", "\n").split("\n"):
        if line.startswith("### "):
            if cur is not None:
                out[cur] = "\n".join(buf).strip()
            cur, buf = line[4:].strip(), []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        out[cur] = "\n".join(buf).strip()
    return out


def _strip_unsafe(s: str, keep_newlines: bool) -> str:
    """NFC-normalise and drop control, format, private-use, surrogate and filler characters."""
    out = []
    for ch in unicodedata.normalize("NFC", s):
        cat = unicodedata.category(ch)
        if ch in ("\n", "\t") and keep_newlines:
            out.append(ch)
        elif cat in ("Cc", "Cs", "Co") or ch in FILLERS:
            out.append(" " if ch in ("\n", "\t") else "")
        elif cat == "Cf" and ch not in KEEP_FORMAT:
            continue
        else:
            out.append(ch)
    return "".join(out)


def _clean(s: str, multiline: bool = False) -> str:
    s = _strip_unsafe(s or "", keep_newlines=multiline)
    if s.strip() == NO_RESPONSE:
        return ""
    if multiline:
        return re.sub(r"[^\S\n]+", " ", s).strip()
    return re.sub(r"\s+", " ", s).strip()


def _has_letters(s: str) -> bool:
    return any(c.isalnum() for c in s)


def _key(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s).casefold()).strip()


def _checked(raw: str) -> list[str]:
    return [m.group(1).strip() for m in re.finditer(r"^- \[[xX]\] (.+)$", raw or "", re.M)]


def _valid_url(url: str) -> bool:
    if not url or len(url) > 300 or re.search(r"[\s<>\"']", url):
        return False
    try:
        u = urlsplit(url)
        port = u.port
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https") or not host or "@" in u.netloc or port not in (None, 80, 443):
        return False
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")) or "." not in host:
        return False
    try:
        ipaddress.ip_address(host)
        return False  # raw IP addresses are not a book page
    except ValueError:
        pass
    return True


def detect(sections: dict[str, str]) -> str | None:
    if forms.label_of(forms.REGISTER, "title") in sections and forms.label_of(forms.REGISTER, "label") in sections:
        return "register"
    if forms.label_of(forms.UPDATE, "record_id") in sections:
        return "update"
    return None


def validate_registration(sections: dict[str, str], today: date) -> tuple[list[str], dict]:
    errs: list[str] = []
    g = lambda fid: sections.get(forms.label_of(forms.REGISTER, fid), "")
    title, subtitle = _clean(g("title")), _clean(g("subtitle"))
    author, edition = _clean(g("author")), _clean(g("edition"))
    if not title: errs.append("The title is required.")
    elif not _has_letters(title): errs.append("The title must contain letters or numbers.")
    if len(title) > 200: errs.append("The title is longer than 200 characters.")
    if len(subtitle) > 200: errs.append("The subtitle is longer than 200 characters.")
    if not author: errs.append("The author name is required.")
    elif not _has_letters(author): errs.append("The author name must contain letters.")
    if len(author) > 150: errs.append("The author name is longer than 150 characters.")
    if len(edition) > 80: errs.append("The edition is longer than 80 characters.")

    role = L.OPTION_TO_ROLE.get(_clean(g("role")))
    if not role: errs.append("Choose your role in relation to this work.")

    ym = re.fullmatch(r"[0-9]{4}", _clean(g("year")))
    year = int(ym.group()) if ym else 0
    if not ym or not (1900 <= year <= today.year + 1):
        errs.append(f"The year must be a four-digit year between 1900 and {today.year + 1}.")

    isbn_raw = _clean(g("isbn"))
    isbn = normalize_isbn(isbn_raw) if isbn_raw else None
    if isbn_raw and not isbn:
        errs.append("The ISBN is not a valid ISBN-10 or ISBN-13 (check the digits, or leave it blank).")

    url = _clean(g("url"))
    if url and not _valid_url(url):
        errs.append("The link must be an http:// or https:// address on a public website (no spaces, logins or IP addresses).")

    opt = _clean(g("label"))
    label = L.OPTION_TO_LABEL.get(opt)
    if not label: errs.append("Choose one of the three labels.")

    statement = _clean(g("statement"))
    if not (20 <= len(statement) <= 1500):
        errs.append("The statement must be between 20 and 1,500 characters.")
    elif not _has_letters(statement):
        errs.append("The statement must contain words.")

    tools = [_clean(t) for t in (g("ai_tools") or "").split("\n")]
    tools = [t for t in tools if t]
    if len(tools) > 10: errs.append("List at most 10 AI tools.")
    if any(len(t) > 200 for t in tools): errs.append("Each AI tool line must be 200 characters or fewer.")

    comps = []
    for part in L.PARTS:
        key = L.OPTION_TO_AI_USE.get(_clean(g(part)))
        if key is None:
            errs.append(f"Choose an option for: {L.PARTS[part]}.")
        elif key != "na":
            comps.append({"part": part, "ai_use": key})

    if label == "human-authored" and any(c["part"] == "translation" and c["ai_use"] != "none" for c in comps):
        errs.append("A text declared Human Authored cannot have an AI-assisted or AI-generated translation. "
                    "Choose another label, or declare the translation as human-made.")

    ai_used = (label not in (None, "human-authored")) or any(c["ai_use"] in ("assisted", "generated") for c in comps)
    if ai_used and not tools:
        errs.append("List the AI tools used (one per line), since AI was used in this work.")

    given = set(_checked(g("attest")))
    for k, text in L.ATTESTATIONS.items():
        if text not in given:
            errs.append("All four confirmations must be ticked.")
            break

    fmts = [k for k, v in L.FORMATS.items() if v in _checked(g("formats"))]
    work = {"title": title, "author": author, "year": year}
    if subtitle: work["subtitle"] = subtitle
    if isbn: work["isbn"] = isbn
    if edition: work["edition"] = edition
    if fmts: work["formats"] = fmts
    if url: work["url"] = url
    return errs, {"work": work, "label": label, "statement": statement, "components": comps, "ai_tools": tools, "role": role}


def _msg_created(cfg, rid):
    return (f"Thank you. Your declaration is registered as **`{rid}`**.\n\n"
            f"Permanent record: {cfg['base_url']}/r/{rid}/ (it goes live a minute or two after this message).\n\n"
            f"Show the label and ID on your copyright page or store listing; the marks and wording are at "
            f"{cfg['base_url']}/marks/. This record is a self-declaration and is not verified. To withdraw it or "
            f"report a problem, use the [record form]({cfg['update_url']}&record_id={rid}).")


def same_account(declared_by: dict, user: dict) -> bool:
    """Compare by GitHub's numeric id when both sides have it (logins can be renamed and reused)."""
    if declared_by.get("id") and user.get("id"):
        return declared_by["id"] == user["id"]
    return declared_by["github"].lower() == (user.get("login") or "").lower()


def _same_work(a: dict, b: dict) -> bool:
    k = lambda w: (_key(w["title"]), _key(w["author"]), w["year"], _key(w.get("edition", "")))
    if k(a) != k(b):
        return False
    return not (a.get("isbn") and b.get("isbn") and a["isbn"] != b["isbn"])  # different ISBNs = different editions


def process_issue(issue: dict, records: list[dict], cfg: dict, today: date, account_created: datetime | None = None,
                  force: bool = False) -> Result:
    """`account_created=None` means "could not be looked up": the submission is deferred, not decided."""
    n = issue["number"]
    user_obj = issue.get("user") or {}
    user = user_obj.get("login", "")
    if user_obj.get("type") == "Bot":
        return Result(n, "ignored")
    sections = parse_sections(issue.get("body") or "")
    kind = detect(sections)
    if kind is None:
        return Result(n, "ignored")

    # idempotency: if this issue already produced a change (e.g. the push worked but the reply failed), repeat the reply
    for r in records:
        for h in r["history"]:
            if h.get("issue") == n and kind == "register" and h["event"] == "registered":
                return Result(n, "already", _msg_created(cfg, r["id"]), True, ["processed", "registered"], r["id"])
            if h.get("issue") == n and kind == "update" and h["event"] == "withdrawn":
                return Result(n, "already", f"{r['id']} has been withdrawn. The record stays visible with the status “withdrawn”, "
                              "and the ID will not be reused.", True, ["processed", "withdrawn"], r["id"])

    if kind == "register":
        errs, data = validate_registration(sections, today)
        live = [r for r in records if r["status"] in ("active", "disputed")]
        if not errs and data["work"].get("isbn"):
            dup = next((r for r in live if r["work"].get("isbn") == data["work"]["isbn"]), None)
            if dup:
                errs.append(f"This ISBN is already registered as {dup['id']}. If that record is wrong, use the report form "
                            f"rather than registering the book again.")
        if not errs:
            dup = next((r for r in live if _same_work(r["work"], data["work"]) and same_account(r["declared_by"], user_obj)), None)
            if dup:
                errs.append(f"You have already registered this work as {dup['id']}.")
        if errs:
            body = ("No record was created, because:\n\n" + "\n".join(f"- {e}" for e in errs) +
                    "\n\nPlease open a new registration with the corrections. Submissions are final once made, so editing this one has no effect.")
            return Result(n, "rejected", body, True, ["rejected"])
        if not force:
            if account_created is None:
                return Result(n, "ignored", "account age could not be checked; will retry")
            reasons = []
            if (datetime.now(timezone.utc) - account_created).days < cfg["min_account_age_days"]:
                reasons.append(f"your GitHub account is less than {cfg['min_account_age_days']} days old")
            today_iso = today.isoformat()
            registered_today = [h for r in records for h in r["history"] if h["event"] == "registered" and h["date"] == today_iso]
            if sum(1 for h in registered_today if h.get("by", "").lower() == user.lower()) >= cfg["max_registrations_per_account_per_day"]:
                reasons.append("this account has reached the daily registration limit")
            if len(registered_today) >= cfg.get("max_registrations_per_day_total", 10**9):
                reasons.append("the registry has reached its daily intake limit")
            if reasons:
                return Result(n, "held", "Thank you. This submission is waiting for a quick manual review because "
                              + " and ".join(reasons) + ". Nothing more is needed from you; a maintainer will approve or reply.",
                              False, ["needs-review"])
        rid = next_id(records, today.year)
        declared_by = {"github": user, "role": data["role"]}
        if user_obj.get("id"):
            declared_by["id"] = user_obj["id"]
        rec = {"id": rid, "status": "active", "registered": today.isoformat(), "updated": today.isoformat(),
               "work": data["work"], "label": data["label"], "definitions_version": cfg["definitions_version"],
               "statement": data["statement"], "components": data["components"], "ai_tools": data["ai_tools"],
               "attestation": {k: True for k in L.ATTESTATIONS}, "declared_by": declared_by,
               "history": [{"date": today.isoformat(), "event": "registered", "by": user, "issue": n}]}
        bad = validate_record(rec)
        if bad:  # defensive: should be unreachable because of the checks above
            return Result(n, "rejected", "The submission could not be turned into a valid record. A maintainer has been notified.", True, ["rejected"])
        return Result(n, "created", _msg_created(cfg, rid), True, ["processed", "registered"], rid, rec)

    # update form
    g = lambda fid: sections.get(forms.label_of(forms.UPDATE, fid), "")
    rid = _clean(g("record_id")).upper()
    act = next((k for k, v in forms.UPDATE_ACTIONS.items() if v == _clean(g("action"))), None)
    rec = next((r for r in records if r["id"] == rid), None) if ID_RE.fullmatch(rid) else None
    if rec is None or act is None:
        return Result(n, "rejected", "No record was changed. Check that the record ID is correct (for example `ATI-2026-000001`) "
                      "and that you chose an action, then open a new request.", True, ["rejected"])
    if act != "withdraw":
        if force:  # reports and corrections are resolved by a maintainer editing the record; `approved` changes nothing
            return Result(n, "ignored")
        return Result(n, "held", "Received. Reports and corrections are reviewed by a maintainer; the record is unchanged until then.",
                      False, ["needs-review"], rid)

    if rec["status"] == "withdrawn":
        return Result(n, "rejected", f"{rid} is already withdrawn.", True, ["rejected"])
    if rec["status"] == "removed":
        return Result(n, "rejected", f"{rid} has been removed by the registry and cannot be withdrawn.", True, ["rejected"])
    is_owner = same_account(rec["declared_by"], user_obj)
    if (is_owner and rec["status"] == "active") or force:
        by_maintainer = force and not is_owner
        event = {"date": today.isoformat(), "event": "withdrawn", "by": "maintainer" if by_maintainer else user, "issue": n}
        if by_maintainer:
            event["note"] = "Approved by a maintainer following a request."
        new = {**rec, "status": "withdrawn", "updated": today.isoformat(), "history": rec["history"] + [event]}
        return Result(n, "withdrawn", f"{rid} has been withdrawn. The record stays visible with the status “withdrawn”, and the ID will not be reused.",
                      True, ["processed", "withdrawn"], rid, new)
    why = ("A record that is under dispute can only be withdrawn after a maintainer reviews the request."
           if is_owner else "Only the account that registered a record can withdraw it automatically.")
    return Result(n, "held", f"Received. {why} A maintainer will review this request.", False, ["needs-review"], rid)
