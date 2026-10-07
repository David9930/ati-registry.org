"""Maintainer tool for the one irreversible-looking action, removal, so it cannot be done half-way.

    python -m ati.moderate remove ATI-2026-000001 --issue 12 --note "Impersonation of the author"

Blanks every descriptive field of the record, sets its status to removed and adds a history event. Commit the result.
"""
from __future__ import annotations
import argparse
from datetime import date
from pathlib import Path
from .records import ROOT, load_records, save_record, scrub_removed


def remove(records_dir: Path, rid: str, issue: int | None, note: str | None, today: date) -> Path:
    rec = next((r for r in load_records(records_dir) if r["id"] == rid), None)
    if rec is None:
        raise SystemExit(f"{rid}: no such record")
    if rec["status"] == "removed":
        raise SystemExit(f"{rid} is already removed")
    return save_record(records_dir, scrub_removed(rec, today, issue, note))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["remove"])
    ap.add_argument("record_id")
    ap.add_argument("--issue", type=int)
    ap.add_argument("--note", help="short neutral reason (shown only in the repository history)")
    ap.add_argument("--records", default=str(ROOT / "records"))
    a = ap.parse_args(argv)
    path = remove(Path(a.records), a.record_id, a.issue, a.note, date.today())
    print(f"removed {a.record_id} -> {path}")
    print("Next: commit, then edit or hide the originating issue and any report that quotes the content. "
          "Earlier versions stay in git history and in CC0 copies.")


if __name__ == "__main__":
    main()
