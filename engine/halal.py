"""Halal (shariah-compliant) screening, judged by the five leading platforms.

Source data lives in ``data/halal.json``: five named screening platforms and
their per-coin verdicts, all read from each platform's own published list.

Verdict codes
    y  compliant / halal
    n  non-compliant / haram
    g  grey, mashbooh, doubtful or neutral
    (absent) the platform has not assessed the coin

The default rule is a **majority of the five platforms** (3 or more ``y``).
Neither ``n``, ``g`` nor "not assessed" counts towards the majority, so a coin
needs three independent platforms to call it compliant before it is shown.
"""

from __future__ import annotations

import json
import os
import threading

DATA_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "halal.json"
)

DEFAULT_RULE = {"type": "majority", "min_votes": 3, "platforms": 5}

_lock = threading.Lock()
_data = None


def _load():
    global _data
    with _lock:
        if _data is None:
            try:
                with open(DATA_FILE, "r", encoding="utf-8") as fh:
                    payload = json.load(fh)
            except (OSError, ValueError):
                payload = {}
            _data = {
                "platforms": payload.get("platforms") or [],
                "verdicts": payload.get("verdicts") or {},
                "rule": payload.get("rule") or DEFAULT_RULE,
                "updated": payload.get("updated"),
            }
    return _data


def reset():
    """Drop the in-memory copy (used by tests)."""
    global _data
    with _lock:
        _data = None


def platforms():
    return list(_load()["platforms"])


def rule():
    return dict(_load()["rule"])


def updated():
    return _load().get("updated")


def auto_screen_enabled():
    """Whether un-assessed coins get the structural fallback screen."""
    return bool(_load()["rule"].get("auto_screen", True))


# Interest-bearing / liquid-staking receipt wrappers: holding one mints a
# yield claim rather than the asset itself, so it cannot inherit a platform's
# verdict for the asset underneath it.
RECEIPT_BASES = {
    "STETH", "WSTETH", "WEETH", "RETH", "CBETH", "WBETH", "LSETH", "EETH",
    "METH", "CMETH", "EZETH", "RSETH", "SWETH", "ANKRETH", "RE2TH",
    "MSOL", "JITOSOL", "STSOL", "BSOL", "JUPSOL", "JSOL", "LITOSOL", "GSOL",
    "LDBTC", "LDETH", "LDUSDT", "LDSOL",
    "CBBTC", "WBTC", "TBTC", "LBTC", "SOLVBTC",
}


def _auto_screen(base):
    """(ok, reason) for a coin none of the five platforms has assessed.

    Deliberately structural only: the exchanges, not this module, decide what
    is tradeable, so every rule here answers "what *kind* of instrument is
    this?" and never "is this coin compliant?" — that stays with the five
    published lists.
    """
    from . import exchange            # deferred: exchange imports this module

    if exchange._is_stable(base):
        return False, "pegged"
    if exchange._is_leveraged(base):
        return False, "leveraged"
    if exchange._is_tokenized_base(base):
        return False, "not crypto"
    if base in RECEIPT_BASES:
        return False, "yield receipt"
    return True, "auto"


def judge(base):
    """Screen one coin by its base ticker.

    Returns a dict with the per-platform verdicts, how many platforms called
    it compliant, how many have assessed it at all, and the final boolean.

    ``source`` is ``"platform"`` when at least one platform has published a
    verdict for the coin — those coins are never overridden — and ``"auto"``
    when the structural fallback decided for an un-assessed (usually newly
    listed) coin.  ``halal`` stays True for the platforms' approved coins
    whether or not ``auto_screen`` is on.
    """
    data = _load()
    base = str(base or "").upper()
    raw = data["verdicts"].get(base) or {}
    min_votes = int(data["rule"].get("min_votes") or 3)

    votes = sum(1 for v in raw.values() if v == "y")
    assessed = sum(1 for v in raw.values() if v in ("y", "n", "g"))

    if assessed:
        return {
            "base": base,
            "halal": votes >= min_votes,
            "votes": votes,
            "assessed": assessed,
            "need": min_votes,
            "source": "platform",
            "reason": "",
            "verdicts": {p["id"]: raw.get(p["id"], "u") for p in data["platforms"]},
        }

    ok, reason = _auto_screen(base)
    if not auto_screen_enabled():
        ok = False
    return {
        "base": base,
        "halal": ok,
        "votes": votes,
        "assessed": assessed,
        "need": min_votes,
        "source": "auto",
        "reason": reason,
        "verdicts": {p["id"]: raw.get(p["id"], "u") for p in data["platforms"]},
    }


def annotate(rows):
    """Attach ``halal`` / ``halal_votes`` / ``halal_detail`` to universe rows."""
    for row in rows:
        detail = judge(row.get("base") or row.get("symbol", "")[:-4])
        row["halal"] = detail["halal"]
        row["halal_votes"] = detail["votes"]
        row["halal_detail"] = detail["verdicts"]
        row["halal_source"] = detail["source"]
    return rows


def is_halal(base):
    return judge(base)["halal"]


def halal_only(rows):
    return [r for r in rows if r.get("halal")]


def summary():
    """Screen counts for the UI (how many coins pass the current rule).

    Read-only over ``data/halal.json`` — deliberately never touches the
    exchange, so ``/api/halal`` stays a free disk read.
    """
    data = _load()
    judged = {base: judge(base) for base in data["verdicts"]}
    return {
        "updated": data.get("updated"),
        "rule": dict(data["rule"]),
        "auto_screen": auto_screen_enabled(),
        "platforms": len(data["platforms"]),
        "assessed": len(judged),
        "halal": sum(1 for d in judged.values() if d["halal"]),
        # assessed coins whose verdict came from the five platforms
        "platform_verdicts": sum(1 for d in judged.values()
                                 if d["source"] == "platform"),
        "receipts": len(RECEIPT_BASES),
    }
