"""Paths and site configuration. (Records themselves live in the Worker's database; see worker/.)"""
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_config(path: Path | None = None) -> dict:
    return json.loads((path or ROOT / "config.json").read_text(encoding="utf-8"))
