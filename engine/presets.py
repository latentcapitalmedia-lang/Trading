"""Built-in preset scans (the "community scans" library)."""

from __future__ import annotations

import functools
import json
import os

DATA_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "presets.json"
)


@functools.lru_cache(maxsize=1)
def load():
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {"presets": []}
