"""Backtest: evaluate a clause over the last N closed bars of the base interval.

``POST /api/backtest`` runs a clause bar-by-bar across the recent history of
the screened universe and reports how many symbols matched on each date.
``engine.backtest.run(payload)`` is the whole implementation; ``app.py`` only
turns the request into a payload and the result into JSON.

Offsets are resolved *as of the historical moment* being tested: the tf bars'
close times are binary-searched, then the candle state steps from there
(``closed`` -> latest tf bar closed at or before the moment, ``2nd``/``3rd
closed`` -> one/two further back, ``current`` -> the tf bar containing the
moment).  Symbols with too little history simply never match - they never
raise.
"""

from __future__ import annotations

import threading
from bisect import bisect_right
from datetime import datetime, timezone

from . import exchange
from .expressions import ClauseError
from .fields import resolve
from .scanner import (
    EvalContext,
    _closed_index,
    _prepare,
    _slot_index,
    _spark,
    apply_filters,
    build_plan,
    evaluate,
    fmt_value,
    make_ctx,
    required_tfs,
    screen_filters,
    series_for,
)

MAX_BARS = 400
DEFAULT_BARS = 66
MAX_LIMIT = 1000


def _int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _bar_date(timestamp):
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")


class _TimeIndex:
    """Open/close timestamps of one timeframe's bars for binary searches."""

    def __init__(self, data, tf_seconds):
        self.opens = list(data.get("time") or [])
        self.closes = [t + tf_seconds for t in self.opens]

    def at(self, moment, state):
        if not self.opens:
            return -1
        if state == "current":
            # the bar containing the moment (its open <= moment)
            return bisect_right(self.opens, moment) - 1
        index = bisect_right(self.closes, moment) - 1
        if state == "2nd closed":
            index -= 1
        elif state == "3rd closed":
            index -= 2
        return index


def _index_fn(indices, moment):
    def index_fn(tf, state, data):
        time_index = indices.get(tf)
        if time_index is None:
            return _slot_index(data, state)
        return time_index.at(moment, state)

    return index_fn


def _closed_indices(base, bars):
    """The last ``bars`` closed base-interval bar positions (oldest first)."""
    flags = base.get("closed")
    closes = base.get("close") or []
    if not flags:
        flags = [True] * len(closes)
    usable = min(len(flags), len(closes))
    return [i for i in range(usable) if flags[i]][-bars:]


def _row(symbol, row, market, base, idx, plan, ev, cache):
    """One matched symbol in the same shape as a normal scan result row."""
    close = base["close"]
    previous = close[idx - 1] if idx >= 1 else None
    change_pct = (close[idx] / previous - 1.0) * 100.0 if previous else None
    values = {}
    for spec in plan["fields"]:
        slot_data, slot_idx = ev.slot(spec["tf"], spec["state"])
        raw = None
        if slot_data is not None and 0 <= slot_idx < len(slot_data["close"]):
            raw = resolve(spec, slot_data, cache)[slot_idx]
        values[spec["id"]] = fmt_value(raw, spec["fmt"])
    return {
        "symbol": symbol,
        "base": row.get("base") or symbol[:-4],
        "name": market.get("name"),
        "price": close[idx],
        "change_pct": change_pct,
        "quote_volume": row.get("quote_volume"),
        "market_cap": market.get("market_cap"),
        "rank": market.get("market_cap_rank"),
        "exchanges": row.get("exchanges") or [],
        "halal": row.get("halal"),
        "halal_votes": row.get("halal_votes"),
        "halal_source": row.get("halal_source") or "platform",
        "values": values,
        "spark": _spark(base, idx),
    }


def run(payload):
    """Evaluate a clause over the last ``bars`` closed bars.

    Returns ``{ok, interval, dates, counts, rows?, ...}`` where ``dates`` is
    ascending (oldest first) and ``counts`` has the same length.  ``rows`` is
    only present when a ``date`` was supplied.
    """
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise ClauseError("payload must be an object")

    clause = payload.get("clause") or payload.get("scan_clause") or ""
    interval = str(payload.get("interval") or "1d")
    bars = _int(payload.get("bars"), DEFAULT_BARS)
    bars = max(1, min(bars, MAX_BARS))
    size = _int(payload.get("universe"), 0)

    date = payload.get("date")
    if date is not None and str(date).strip():
        date = str(date).strip()[:10]
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise ClauseError("date must be YYYY-MM-DD")
    else:
        date = None

    limit = min(MAX_LIMIT, bars + 400)
    plan = build_plan(clause, interval=interval, limit=limit)
    _prepare(plan["ast"], plan)

    venue, halal_only = screen_filters(payload)
    rows = apply_filters(
        exchange.universe(size=size) if size else exchange.universe(),
        venue=venue, halal_only=halal_only,
    )
    fund = exchange.fundamentals()
    tfs = required_tfs(plan)
    base_tf = plan["interval"]
    base_seconds = exchange.interval_seconds(base_tf)

    evaluated = set()
    counts = {}      # date -> number of *distinct* symbols that matched
    seen = set()     # (symbol, date) pairs already counted
    matches = {} if date is not None else None
    errors = []
    lock = threading.Lock()

    def work(row):
        symbol = row["symbol"]
        try:
            series = {tf: series_for(symbol, tf, plan) for tf in tfs}
            base = series[base_tf]
            wanted = _closed_indices(base, bars)
            if not wanted:
                return  # nothing closed yet - cannot backtest this symbol
            market = fund.get(symbol[:-4].upper()) or {}
            ctx = {tf: make_ctx(series[tf], market, row) for tf in tfs}
            indices = {
                tf: _TimeIndex(series[tf], exchange.interval_seconds(tf))
                for tf in tfs
            }
            cache = {}  # indicator series do not depend on the bar position
            for idx in wanted:
                moment = base["time"][idx] + base_seconds
                ev = EvalContext(ctx, _index_fn(indices, moment))
                matched = evaluate(plan["ast"], plan, ev, cache, idx)
                day = _bar_date(base["time"][idx])
                want_row = False
                with lock:
                    evaluated.add(day)
                    if matched and (symbol, day) not in seen:
                        seen.add((symbol, day))
                        counts[day] = counts.get(day, 0) + 1
                    want_row = date == day and matched
                if want_row:
                    entry = _row(symbol, row, market, base, idx, plan, ev, cache)
                    with lock:
                        matches[symbol] = entry
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not fail the run
            with lock:
                errors.append({"symbol": symbol, "error": str(exc)})

    list(exchange._executor.map(work, rows))

    # A symbol whose candles stopped long ago (delisted/halted) contributes a
    # window in the past - keep only the most recent `bars` dates so the chart
    # stays one contiguous period, exactly like Chartink's "Select period".
    dates = sorted(evaluated)[-bars:]
    outcome = {
        "ok": True,
        "interval": interval,
        "clause": plan["clause"],
        "dates": dates,
        "counts": [counts.get(day, 0) for day in dates],
        "fields": [
            {"id": f["id"], "fmt": f["fmt"], "label": f["label"]}
            for f in plan["fields"]
        ],
        "scanned": len(rows),
        "errors": errors[:20],
        "error_count": len(errors),
    }
    if date is not None:
        outcome["rows"] = sorted(
            matches.values(), key=lambda r: -(r.get("quote_volume") or 0)
        )
    return outcome
