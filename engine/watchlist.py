"""Watchlist groups: five exchange lists, favourites, and five custom lists.

The five exchange groups are never stored — they are re-derived on every
request from the merged universe and filtered to that venue's halal coins.
That is what keeps them current: a coin listed on Binance this morning is in
the Binance group this morning, including when the five platforms have not
assessed it yet and it passes on ``halal_source == "auto"``.

Only favourites (shared with the screener's stars) and the custom groups are
persisted.

Rows load in two phases so the table paints immediately:

  * phase 0 - straight off the universe snapshot: symbol, price, 24h volume,
    24h change, market cap;
  * phase 2 - a background job (:func:`scanner.start_values`) that fills the
    seven columns needing candle history, including the weekly MACD that is
    computed from weekly bars rather than daily ones.
"""

from __future__ import annotations

import json
import os
import uuid

from . import exchange, scanner

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "data")
GROUPS_FILE = os.path.join(DATA_DIR, "watchlist_groups.json")
FAVOURITES_FILE = os.path.join(DATA_DIR, "watchlist.json")

# id, label, venue (None = derived from stored symbols rather than a venue)
BUILTIN = (
    ("binance", "Binance", "binance"),
    ("bybit", "Bybit", "bybit"),
    ("kucoin", "KuCoin", "kucoin"),
    ("bitget", "Bitget", "bitget"),
    ("okx", "OKX", "okx"),
    ("favourite", "Favourite", None),
)

MAX_CUSTOM = 5
DEFAULT_LIMIT = 150
LIMITS = (50, 100, 150, 250, 0)      # 0 = every halal coin on that venue

# Large enough that "All" really is every coin above the volume floor.
UNIVERSE_SIZE = 5000

MAX_NAME = 32
MAX_SYMBOLS = 400


# --------------------------------------------------------------------------
# the twelve columns
# --------------------------------------------------------------------------

# ``phase`` 0 is served from the universe snapshot, 2 from the compute job.
COLUMNS = (
    {"key": "symbol",        "title": "Symbol",            "fmt": "symbol", "phase": 0},
    {"key": "price",         "title": "Price",             "fmt": "price",  "phase": 0},
    {"key": "volume_24h",    "title": "24h volume",        "fmt": "usd",    "phase": 0},
    {"key": "volume_7d",     "title": "Weekly volume",     "fmt": "usd",    "phase": 2},
    {"key": "change_24h",    "title": "24h change %",      "fmt": "num2",   "phase": 0},
    {"key": "change_7d",     "title": "Weekly change %",   "fmt": "num2",   "phase": 2},
    {"key": "macd_w",        "title": "Weekly MACD hist",  "fmt": "num4",   "phase": 2},
    {"key": "macd_d",        "title": "Daily MACD hist",   "fmt": "num4",   "phase": 2},
    {"key": "rsi",           "title": "RSI(14)",           "fmt": "num2",   "phase": 2},
    {"key": "market_cap",    "title": "Market cap",        "fmt": "usd",    "phase": 2},
    {"key": "volatility_w",  "title": "Weekly volatility", "fmt": "num2",   "phase": 2},
    {"key": "volatility_d",  "title": "Daily volatility",  "fmt": "num2",   "phase": 2},
)

# One token per phase-2 column, in the same order as the phase-2 entries of
# COLUMNS. Weekly MACD is written as an offset prefix: the parser only honours
# a timeframe outside the brackets, so "[weekly macd]" is not the same column.
COMPUTE_COLUMNS = (
    "volume_7d(7)",
    "roc(7)",
    "closed weekly macd_histogram(12,26,9)",
    "macd_histogram(12,26,9)",
    "rsi(14)",
    "market_cap",
    "volatility_w(7)",
    "volatility_d",
)

_phase2_keys = tuple(c["key"] for c in COLUMNS if c["phase"] == 2)


def compute_fields():
    """The compute job's columns, re-keyed to the table's stable keys.

    ``scanner`` names a column after the field and its parameters, so a key
    like ``macd_histogram(12,26,9)@closed weekly`` is an implementation detail
    the table should not have to know.  Returns ``(tokens, id_to_key, fields)``
    where ``fields`` is what the job's own response reports.
    """
    specs = scanner._normalise(scanner._column_specs(list(COMPUTE_COLUMNS)),
                               interval="1d")
    if len(specs) != len(_phase2_keys):
        # Two tokens collapsed into one column (a params default changed, say).
        # Map by id rather than by position so the table still gets a value.
        raise RuntimeError("watchlist compute columns no longer line up with "
                           f"COLUMNS: {len(specs)} specs, {len(_phase2_keys)} keys")
    id_to_key = {spec["id"]: key for spec, key in zip(specs, _phase2_keys)}
    fields = [{"key": id_to_key[s["id"]], "id": s["id"],
               "fmt": s["fmt"], "label": s["label"]} for s in specs]
    return list(COMPUTE_COLUMNS), id_to_key, fields


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

def _read(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


def _write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _state():
    raw = _read(GROUPS_FILE, {}) or {}
    custom = []
    for g in raw.get("custom") or []:
        if not isinstance(g, dict) or not g.get("id"):
            continue
        custom.append({
            "id": str(g["id"]),
            "name": str(g.get("name") or "Untitled")[:MAX_NAME],
            "symbols": [str(s).upper() for s in (g.get("symbols") or [])][:MAX_SYMBOLS],
        })
    return {"active": str(raw.get("active") or "binance"), "custom": custom}


def _save(state):
    _write(GROUPS_FILE, state)


def favourite_symbols():
    return [str(s).upper() for s in
            (_read(FAVOURITES_FILE, {"symbols": []}) or {}).get("symbols") or []]


def custom_groups():
    return _state()["custom"]


def active_id():
    state = _state()
    known = {g[0] for g in BUILTIN} | {g["id"] for g in state["custom"]}
    return state["active"] if state["active"] in known else "binance"


def set_active(group_id):
    state = _state()
    known = {g[0] for g in BUILTIN} | {g["id"] for g in state["custom"]}
    if group_id not in known:
        raise KeyError("unknown group")
    state["active"] = group_id
    _save(state)
    return group_id


def create(name, symbols=()):
    state = _state()
    if len(state["custom"]) >= MAX_CUSTOM:
        raise ValueError(f"you can add at most {MAX_CUSTOM} custom groups")
    clean = [str(s).upper() for s in (symbols or [])][:MAX_SYMBOLS]
    group = {
        "id": "c" + uuid.uuid4().hex[:10],
        "name": (str(name or "Untitled").strip() or "Untitled")[:MAX_NAME],
        "symbols": clean,
    }
    state["custom"].append(group)
    # You just made it, so show it: landing on an old group leaves the new
    # chip's ✎/✕ tools (they only render on the active chip) out of sight.
    state["active"] = group["id"]
    _save(state)
    return group


def update(group_id, name=None, symbols=None):
    state = _state()
    for group in state["custom"]:
        if group["id"] != group_id:
            continue
        if name is not None:
            group["name"] = (str(name).strip() or "Untitled")[:MAX_NAME]
        if symbols is not None:
            group["symbols"] = [str(s).upper() for s in symbols][:MAX_SYMBOLS]
        _save(state)
        return group
    raise KeyError("unknown group")


def delete(group_id):
    state = _state()
    kept = [g for g in state["custom"] if g["id"] != group_id]
    if len(kept) == len(state["custom"]):
        raise KeyError("unknown group")
    state["custom"] = kept
    if state["active"] == group_id:
        state["active"] = "binance"
    _save(state)
    return state


# --------------------------------------------------------------------------
# rows
# --------------------------------------------------------------------------

def _limit(value):
    """Group row cap. ``None`` (no ``?limit=``) means the default, and only an
    explicit ``all``/``0`` asks for every coin — a missing parameter must not
    quietly turn into "fetch them all"."""
    if value is None:
        return DEFAULT_LIMIT
    if value == "all":
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return DEFAULT_LIMIT


def _universe():
    return exchange.universe(size=UNIVERSE_SIZE)


def _venue_rows(venue, limit):
    """That venue's halal coins, newest listings included, biggest first."""
    rows = [r for r in _universe()
            if venue in (r.get("exchanges") or []) and r.get("halal")]
    rows.sort(key=lambda r: -(r.get("quote_volume") or 0))
    return rows[:limit] if limit else rows


def _stored_rows(symbols, limit):
    """Stored symbols in the order they were pinned, unknown ones kept as-is."""
    known = {r["symbol"]: r for r in _universe()}
    rows = []
    for symbol in symbols:
        row = known.get(symbol)
        if row is None:
            rows.append({"symbol": symbol, "base": symbol[:-4] if len(symbol) > 4
                         else symbol, "exchanges": [], "quote_volume": 0.0,
                         "price": 0.0, "change_pct": None, "halal": True,
                         "halal_source": "unknown"})
        else:
            rows.append(dict(row))
    return rows[:limit] if limit else rows


def resolve(group_id, limit=DEFAULT_LIMIT):
    """Full row payload for one group (phase 0 of the load)."""
    limit = _limit(limit)
    venues = {gid: venue for gid, _name, venue in BUILTIN}
    if group_id in venues and venues[group_id] is not None:
        return _venue_rows(venues[group_id], limit)
    if group_id == "favourite":
        return _stored_rows(favourite_symbols(), limit)
    for group in _state()["custom"]:
        if group["id"] == group_id:
            return _stored_rows(group["symbols"], limit)
    raise KeyError("unknown group")


def rows_for(group_id, limit=DEFAULT_LIMIT):
    """Phase-0 payload for one group: ``resolve`` plus the snapshot columns
    the table paints before the compute job has run.

    Deliberately does **not** join CoinGecko — market cap arrives with the
    phase-2 job instead, so a rate-limited upstream can never hold the first
    paint for thirty seconds.  The keys are the ``COLUMNS`` keys, so the table
    reads every cell the same way regardless of which phase filled it.
    """
    rows = []
    for row in resolve(group_id, limit):
        rows.append({
            "symbol": row.get("symbol"),
            "base": row.get("base"),
            "exchanges": row.get("exchanges") or [],
            "price": row.get("price") or 0.0,
            "volume_24h": row.get("quote_volume") or 0.0,
            "change_24h": row.get("change_pct"),
            "halal": bool(row.get("halal")),
            "halal_source": row.get("halal_source") or "platform",
            "halal_votes": row.get("halal_votes") or 0,
        })
    return rows


def find(group_id):
    for gid, name, venue in BUILTIN:
        if gid == group_id:
            return {"id": gid, "name": name, "venue": venue,
                    "kind": "exchange" if venue else "favourite",
                    "builtin": True}
    for group in _state()["custom"]:
        if group["id"] == group_id:
            return {"id": group["id"], "name": group["name"], "venue": None,
                    "kind": "custom", "builtin": False}
    return None


def list_groups(limit=DEFAULT_LIMIT):
    """Everything the group strip needs, including symbols for the chips."""
    active = active_id()
    groups = []
    for gid, name, venue in BUILTIN:
        meta = find(gid)
        meta["symbols"] = [r["symbol"] for r in resolve(gid, limit)]
        groups.append(meta)
    for group in _state()["custom"]:
        meta = find(group["id"])
        meta["symbols"] = list(group["symbols"])
        groups.append(meta)
    return {
        "groups": groups,
        "active": active,
        "max_custom": MAX_CUSTOM,
        "used_custom": len(_state()["custom"]),
        "limits": list(LIMITS),
        "default_limit": DEFAULT_LIMIT,
        "columns": [dict(c) for c in COLUMNS],
        "compute_fields": compute_fields()[2],
    }
