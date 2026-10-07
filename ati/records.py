"""Loading, validating and numbering registry records."""
from __future__ import annotations
import json, os, re, tempfile
from datetime import date
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "schema" / "record.schema.json").read_text(encoding="utf-8"))
_validator = Draft202012Validator(SCHEMA)
ID_RE = re.compile(r"^ATI-([0-9]{4})-([0-9]{6})$")


def load_config(path: Path | None = None) -> dict:
    return json.loads((path or ROOT / "config.json").read_text(encoding="utf-8"))


def validate_record(rec: dict) -> list[str]:
    errs = []
    for e in sorted(_validator.iter_errors(rec), key=lambda e: list(e.path)):
        loc = "/".join(str(p) for p in e.path) or "(record)"
        errs.append(f"{loc}: {e.message}")
    return errs


def load_records(directory: Path) -> list[dict]:
    recs = []
    for p in sorted(Path(directory).glob("ATI-*.json")):
        rec = json.loads(p.read_text(encoding="utf-8"))
        if p.stem != rec.get("id"):
            raise ValueError(f"{p.name}: file name does not match id {rec.get('id')!r}")
        errs = validate_record(rec)
        if errs:
            raise ValueError(f"{p.name}: " + "; ".join(errs))
        recs.append(rec)
    return recs


def save_record(directory: Path, rec: dict) -> Path:
    errs = validate_record(rec)
    if errs:
        raise ValueError("invalid record: " + "; ".join(errs))
    p = Path(directory) / f"{rec['id']}.json"
    data = json.dumps(rec, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(dir=str(directory), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
        os.replace(tmp, p)  # atomic: a crash never leaves a half-written record
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return p


def next_id(records: list[dict], year: int) -> str:
    top = 0
    for r in records:
        m = ID_RE.match(r["id"])
        if m and int(m.group(1)) == year:
            top = max(top, int(m.group(2)))
    return f"ATI-{year}-{top + 1:06d}"


def normalize_isbn(raw: str) -> str | None:
    """Return a valid ISBN-13 (digits only) from an ISBN-10 or ISBN-13, else None."""
    s = re.sub(r"^\s*ISBN(?:-?1[03])?\s*:?", "", raw or "", flags=re.I)
    s = re.sub(r"[\s\-\u2010-\u2015\u2212]", "", s).upper()
    if re.fullmatch(r"[0-9]{9}[0-9X]", s):
        total = sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(s))
        if total % 11:
            return None
        core = "978" + s[:9]
        chk = (10 - sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(core)) % 10) % 10
        return core + str(chk)
    if re.fullmatch(r"97[89][0-9]{10}", s):
        total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(s))
        return s if total % 10 == 0 else None
    return None


def format_isbn(isbn13: str) -> str:
    """Display form without guessing hyphen positions."""
    return isbn13
