"""Scan planning and execution."""

from __future__ import annotations

import math
import threading
import time
import uuid

from . import exchange
from .expressions import (
    DEFAULT_OFFSET,
    ClauseError,
    collect_fields,
    is_default_offset,
    offset_of,
    offset_suffix,
    offset_text,
    parse,
    pretty,
)
from .fields import FIELDS, resolve


def _display_id(field, params):
    if not params:
        return field
    return f"{field}({','.join(str(p) for p in params)})"


def _spec_id(field, params, offset=None):
    """Display id / cache key for a field plus its candle offset."""
    return _display_id(field, params) + offset_suffix(offset or DEFAULT_OFFSET)


def _normalise(specs, interval="1d"):
    """Bind raw field specs to the registry: defaults, clamps, display ids."""
    for spec in specs:
        item = FIELDS.get(spec["field"])
        if item is None:
            raise ClauseError(f"unknown field '{spec['field']}'")
        definitions = item["params"]
        params = list(spec["params"])
        if len(params) > len(definitions):
            raise ClauseError(
                f"[{spec['field']}] takes at most {len(definitions)} parameter(s)"
            )
        while len(params) < len(definitions):
            params.append(definitions[len(params)]["default"])
        bounded = []
        for value, definition in zip(params, definitions):
            bounded.append(max(definition["min"], min(definition["max"], value)))
        spec["params"] = bounded
        # clause-level offset drives ids/labels; the *effective* timeframe is
        # the plan's base interval when the clause uses the default offset.
        offset = {"state": spec.get("state") or "closed",
                  "tf": spec.get("tf") or "1d"}
        spec["state"] = offset["state"]
        spec["tf"] = offset["tf"] if not is_default_offset(offset) else interval
        spec["id"] = _spec_id(spec["field"], bounded, offset)
        spec["cache_key"] = spec["id"]
        spec["fmt"] = item["fmt"]
        suffix = offset_text(offset)
        spec["label"] = f"{item['label']} · {suffix}" if suffix else item["label"]

    # de-duplicate (collect_fields already keys on cache_key, but defaults may
    # have collapsed two different-looking specs into one)
    unique = []
    seen = set()
    for spec in specs:
        if spec["cache_key"] in seen:
            continue
        seen.add(spec["cache_key"])
        unique.append(spec)
    return unique


def build_plan(clause, interval="1d", limit=400, columns=None):
    """Parse + validate a clause. Returns a JSON-safe plan.

    ``columns`` are extra display-only columns ("rsi(14)" style tokens) that are
    computed for matched rows even though the filter never mentions them.
    """
    ast = parse(clause)
    specs = collect_fields(ast)
    specs.extend(_column_specs(columns))
    unique = _normalise(specs, interval=interval)

    return {
        "clause": pretty(ast),
        "ast": ast,
        "fields": unique,
        "columns": [spec["id"] for spec in unique],
        "interval": interval,
        "limit": int(limit),
    }


def _column_specs(columns):
    """Turn display tokens like ``'rsi(14)'`` into raw field specs.

    A token may carry a candle-offset prefix, and the parser only honours that
    prefix when it sits *outside* the brackets added here: ``weekly [rsi]``
    resolves to ``tf='1w'``, whereas ``[weekly rsi]`` silently resolves to the
    invented field ``'weeklyrsi'`` and then dies as "unknown field".  So the
    plain form is tried first and then leading words are hoisted out one at a
    time until the result names a field that actually exists.
    """
    specs = []
    for token in columns or []:
        token = str(token).strip().strip("[]").strip()
        if not token:
            continue
        specs.extend(_parse_column(token))
    return specs


def _parse_column(token):
    words = token.split()
    first_error = None
    for k in range(len(words)):
        clause = ("[%s] > 0" % token if k == 0 else
                  "%s [%s] > 0" % (" ".join(words[:k]), " ".join(words[k:])))
        try:
            got = collect_fields(parse(clause))
        except ClauseError as exc:
            if first_error is None:
                first_error = exc
            continue
        if got and all(spec.get("field") in FIELDS for spec in got):
            return got
    if first_error is not None:
        raise ClauseError(f"invalid column '{token}' - {first_error.message}",
                          first_error.pos)
    raise ClauseError(f"invalid column '{token}' - unknown field", None)


# --------------------------------------------------------------------------
# evaluation
#
# Every operand of a comparison carries its own ``(value, series, index)`` so
# the two sides can live on different timeframes / candle states.
# --------------------------------------------------------------------------

def _closed_index(data):
    """Index of the last closed bar of a series (the original run_scan rule)."""
    closes = data.get("close") or []
    if not closes:
        return -1
    closed = data.get("closed")
    if not closed:
        return len(closes) - 1
    idx = len(closed) - 1
    if not closed[idx]:
        idx -= 1
    return idx


def _slot_index(data, state, base_idx=None):
    """Bar index for one candle state within one timeframe's series.

    ``current`` is the running bar, ``closed`` the last closed one and
    ``2nd``/``3rd closed`` step back from it.  ``base_idx`` (when given) is an
    evaluation index supplied by the caller and can only pull the closed index
    further back, never forward past the last closed bar.
    """
    closes = data.get("close") or []
    if not closes:
        return -1
    if state == "current":
        return len(closes) - 1
    closed_idx = _closed_index(data)
    if base_idx is not None:
        closed_idx = min(base_idx, closed_idx)
    if state == "2nd closed":
        return closed_idx - 1
    if state == "3rd closed":
        return closed_idx - 2
    return closed_idx


class EvalContext:
    """Maps ``(timeframe, candle state)`` to ``(series, bar index)``.

    ``series`` maps a timeframe to that timeframe's evaluation dict; anything
    missing falls back to ``fallback`` (a single-series context).
    """

    def __init__(self, series=None, index_fn=None, fallback=None):
        self.series = series or {}
        self.fallback = fallback
        self._index_fn = index_fn

    def slot(self, tf, state):
        data = self.series.get(tf, self.fallback)
        if data is None:
            for value in self.series.values():
                data = value
                break
        if data is None:
            return None, -1
        if self._index_fn is not None:
            return data, self._index_fn(tf, state, data)
        return data, _slot_index(data, state)


def _as_eval(ctx, idx):
    """Wrap whatever ``evaluate()`` was handed into an :class:`EvalContext`."""
    if isinstance(ctx, EvalContext):
        return ctx
    if isinstance(ctx, dict) and "close" in ctx:
        # single synthetic series: caller-supplied idx anchors the closed state
        def index_fn(_tf, state, data):
            return _slot_index(data, state, base_idx=idx)
        return EvalContext(index_fn=index_fn, fallback=ctx)
    if isinstance(ctx, dict):
        # {timeframe: series} - each series derives its own indices
        return EvalContext(ctx)
    raise ClauseError("cannot evaluate against this context")


def _compare(left, right, op):
    left_value, left_series, left_idx = left
    right_value, right_series, right_idx = right

    if op in ("crossed above", "crossed below"):
        if (left_series is None or right_series is None
                or left_idx is None or right_idx is None
                or left_idx < 1 or right_idx < 1):
            return False
        if left_idx >= len(left_series) or right_idx >= len(right_series):
            return False
        a0, a1 = left_series[left_idx - 1], left_series[left_idx]
        b0, b1 = right_series[right_idx - 1], right_series[right_idx]
        if any(v is None for v in (a0, a1, b0, b1)):
            return False
        if op == "crossed above":
            return a0 <= b0 and a1 > b1
        return a0 >= b0 and a1 < b1

    if left_value is None or right_value is None:
        return False
    if op == ">":
        return left_value > right_value
    if op == "<":
        return left_value < right_value
    if op == ">=":
        return left_value >= right_value
    if op == "<=":
        return left_value <= right_value
    if op == "==":
        return left_value == right_value
    if op == "!=":
        return left_value != right_value
    raise ClauseError(f"unknown operator {op!r}")


def evaluate(ast, plan, ctx, cache, idx):
    """Evaluate the AST against one symbol's data at bar ``idx``.

    ``ctx`` may be a plain series dict (single timeframe, ``idx`` anchors the
    default closed state), a ``{timeframe: series}`` map or an
    :class:`EvalContext` supplying per-offset indices.
    """
    ev = _as_eval(ctx, idx)
    return _eval_node(ast, plan, ev, cache)


def _eval_node(ast, plan, ev, cache):
    kind = ast.get("t")

    if kind == "and":
        return all(_eval_node(kid, plan, ev, cache) for kid in ast["kids"])
    if kind == "or":
        return any(_eval_node(kid, plan, ev, cache) for kid in ast["kids"])
    if kind == "not":
        return not _eval_node(ast["kid"], plan, ev, cache)

    if kind == "cmp":
        left = _operand(ast["left"], plan, ev, cache)
        right = _operand(ast["right"], plan, ev, cache)
        return _compare(left, right, ast["op"])

    raise ClauseError(f"cannot evaluate node {kind!r}")


def _operand(node, plan, ev, cache):
    if node.get("t") == "num":
        return node["v"], None, None
    if node.get("t") == "field":
        spec = {
            "field": node["field"],
            "params": node["_params"],
            "cache_key": node["_key"],
            "state": node.get("_state", "closed"),
            "tf": node.get("_tf", "1d"),
        }
        data, idx = ev.slot(spec["tf"], spec["state"])
        if data is None or idx is None or idx < 0:
            return None, None, idx
        values = resolve(spec, data, cache)
        value = values[idx] if idx < len(values) else None
        return value, values, idx
    return None, None, None


def _prepare(ast, plan):
    """Attach resolved parameter lists / cache keys to every field node."""
    kind = ast.get("t")
    if kind == "field":
        item = FIELDS.get(ast["field"])
        if item is None:
            raise ClauseError(f"unknown field '{ast['field']}'")
        definitions = item["params"]
        params = list(ast.get("params") or [])
        if len(params) > len(definitions):
            raise ClauseError(
                f"[{ast['field']}] takes at most {len(definitions)} parameter(s)"
            )
        while len(params) < len(definitions):
            params.append(definitions[len(params)]["default"])
        params = [
            max(d["min"], min(d["max"], v)) for v, d in zip(params, definitions)
        ]
        offset = offset_of(ast)
        ast["_params"] = params
        ast["_key"] = _spec_id(ast["field"], params, offset)
        ast["_state"] = offset["state"]
        # the default offset means "the plan's base interval"
        ast["_tf"] = offset["tf"] if not is_default_offset(offset) else (
            plan.get("interval") or offset["tf"]
        )
        return
    if kind in ("and", "or"):
        for kid in ast["kids"]:
            _prepare(kid, plan)
    elif kind == "not":
        _prepare(ast["kid"], plan)
    elif kind == "cmp":
        _prepare(ast["left"], plan)
        if isinstance(ast.get("right"), dict) and ast["right"].get("t"):
            _prepare(ast["right"], plan)


# --------------------------------------------------------------------------
# formatting
# --------------------------------------------------------------------------

def fmt_value(value, fmt):
    if value is None:
        return None
    try:
        if fmt == "price":
            return float(f"{float(value):.8g}")
        if fmt == "num2":
            return round(float(value), 2)
        if fmt == "num4":
            return round(float(value), 4)
        if fmt == "int":
            return int(value)
        if fmt == "vol":
            return round(float(value), 2)
        if fmt == "usd":
            return float(value)
    except (TypeError, ValueError):
        return value
    return value


def _spark(data, idx, points=60):
    start = max(0, idx - points + 1)
    window = data["close"][start: idx + 1]
    if not window:
        return []
    step = max(1, len(window) // points)
    sampled = window[::step]
    if sampled[-1] != window[-1]:
        sampled.append(window[-1])
    top = max(sampled)
    bottom = min(sampled)
    span = (top - bottom) or 1.0
    return [round((v - bottom) / span, 4) for v in sampled]


# --------------------------------------------------------------------------
# per-timeframe series
# --------------------------------------------------------------------------

def required_tfs(plan):
    """Every timeframe a plan needs, base interval first.

    Specs use their effective timeframe (the base interval whenever the clause
    relies on the default offset), so this is simply the distinct set of
    ``spec["tf"]`` values.
    """
    tfs = [plan["interval"]]
    for spec in plan["fields"]:
        tf = spec.get("tf") or plan["interval"]
        if tf not in tfs:
            tfs.append(tf)
    return tfs


# Standard spot intervals, ordered by the venue that offers them (Binance is
# the preferred kline source).  45m / 3h / 1y are not offered natively by any
# venue, so they aggregate from the largest of these that fits underneath.
_SOURCE_INTERVALS = (
    "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w", "1M",
)


def source_interval(tf, base_interval="1d"):
    """Largest supported interval strictly below ``tf``.

    The source has to be finer than the bar it is bucketed into, so ``tf``
    itself is never a candidate (that also keeps a venue's "interval not
    offered" error from short-circuiting the aggregation).
    """
    target = exchange.interval_seconds(tf)
    best = None
    best_seconds = -1
    for candidate in set(_SOURCE_INTERVALS) | {base_interval}:
        try:
            seconds = exchange.interval_seconds(candidate)
        except Exception:  # noqa: BLE001 - skip nonsense base intervals
            continue
        if 0 < seconds < target and seconds > best_seconds:
            best, best_seconds = candidate, seconds
    return best or base_interval


def aggregate_series(symbol, tf, limit, base_interval, src=None):
    """Build ``tf`` bars by bucketing a finer interval's candles.

    Used when a venue does not offer an interval natively (45m, 3h, 1y).
    """
    tf_seconds = exchange.interval_seconds(tf)
    src = src or source_interval(tf, base_interval)
    src_seconds = exchange.interval_seconds(src)
    if src_seconds <= 0 or tf_seconds <= 0:
        raise exchange.DataError(f"cannot build {tf} bars for {symbol}")
    if src == tf:
        raise exchange.DataError(f"no {tf} klines for {symbol}")
    need = min(1000, math.ceil(limit * tf_seconds / src_seconds) + 10)
    data = exchange.klines(symbol, src, need)

    buckets = {}
    for j, t in enumerate(data["time"]):
        bucket = (t // tf_seconds) * tf_seconds
        cur = buckets.get(bucket)
        if cur is None:
            buckets[bucket] = {
                "open": data["open"][j],
                "high": data["high"][j],
                "low": data["low"][j],
                "close": data["close"][j],
                "volume": data["volume"][j],
                "quote_volume": data["quote_volume"][j],
                "closed": bool(data["closed"][j]),
            }
        else:
            cur["high"] = max(cur["high"], data["high"][j])
            cur["low"] = min(cur["low"], data["low"][j])
            cur["close"] = data["close"][j]
            cur["volume"] += data["volume"][j]
            cur["quote_volume"] += data["quote_volume"][j]
            cur["closed"] = cur["closed"] and bool(data["closed"][j])

    times = sorted(buckets)
    return {
        "symbol": symbol,
        "interval": tf,
        "source": data.get("source"),
        "aggregated_from": src,
        "time": times,
        "open": [buckets[t]["open"] for t in times],
        "high": [buckets[t]["high"] for t in times],
        "low": [buckets[t]["low"] for t in times],
        "close": [buckets[t]["close"] for t in times],
        "volume": [buckets[t]["volume"] for t in times],
        "quote_volume": [buckets[t]["quote_volume"] for t in times],
        "closed": [buckets[t]["closed"] for t in times],
    }


def series_for(symbol, tf, plan):
    """Klines for one timeframe, aggregating from a finer one when needed."""
    base_interval = plan["interval"]
    limit = int(plan.get("limit") or 400)
    try:
        return exchange.klines(symbol, tf, limit)
    except Exception as exc:  # noqa: BLE001 - venue does not offer the interval
        src = source_interval(tf, base_interval)
        if src == tf:
            raise exc
        return aggregate_series(symbol, tf, limit, base_interval, src=src)


def make_ctx(data, market, row):
    """Evaluation dict for one timeframe's series (fundamentals shared)."""
    return {
        "open": data["open"],
        "high": data["high"],
        "low": data["low"],
        "close": data["close"],
        "volume": data["volume"],
        # traded value, so a "weekly volume" field can be stated in USD and
        # compared against quote_volume_24h instead of mixing units
        "quote_volume": data.get("quote_volume"),
        "closed": data.get("closed"),
        "fund": {
            "market_cap": market.get("market_cap"),
            "market_cap_rank": market.get("market_cap_rank"),
            "quote_volume_24h": row.get("quote_volume"),
        },
    }


# --------------------------------------------------------------------------
# running a scan
# --------------------------------------------------------------------------

def as_bool(value, default=False):
    """Parse an API flag that may arrive as bool, "1"/"true"/"yes" or None."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


VENUES = exchange.VENUES      # single source of truth: all five venues


def screen_filters(payload):
    """Read the universe filters shared by every scan entry point.

    Returns ``(venue, halal_only)`` where ``venue`` is None for "every pair
    listed on any supported venue" and otherwise one of the venue names.
    """
    venue = str(payload.get("venue") or payload.get("segment") or "").strip().lower()
    if venue not in VENUES:
        venue = None
    return venue, as_bool(payload.get("halal_only"), True)


def apply_filters(rows, venue=None, halal_only=False):
    """Restrict universe rows to a venue segment and/or the halal screen."""
    if venue:
        rows = [r for r in rows if venue in (r.get("exchanges") or [])]
    if halal_only:
        # Majority rule (3 of the 5 platforms) already attached by universe()
        rows = [r for r in rows if r.get("halal")]
    return rows


def _debug_steps(ast):
    """Top-level filters of a clause, as ``(node, text)`` pairs.

    Chartink's "Debug scan filters" reports one number per filter line, so a
    compound root (``a and b and c``) is split into its children while a
    single filter or a nested group stays whole.
    """
    kind = ast.get("t")
    kids = ast.get("kids") if kind in ("and", "or") else None
    nodes = list(kids) if kids else [ast]
    return [(node, pretty(node)) for node in nodes]


def run_scan(plan, universe_rows=None, snap=None, on_progress=None, sort_by="volume",
             max_results=0, include_spark=True, halal_only=False, venue=None,
             debug=False):
    """Execute a plan. Returns a list of matching rows.

    ``debug=True`` also counts how far each top-level filter let the universe
    through (the funnel behind Chartink's debug panel).
    """
    _prepare(plan["ast"], plan)
    rows = universe_rows if universe_rows is not None else exchange.universe()
    rows = apply_filters(rows, venue=venue, halal_only=halal_only)
    snap = snap if snap is not None else {r["symbol"]: r for r in rows}
    fund = exchange.fundamentals()
    tfs = required_tfs(plan)
    base_tf = plan["interval"]
    and_root = plan["ast"].get("t") != "or"
    steps = _debug_steps(plan["ast"]) if debug else []
    funnel = []          # one ``(solo, cumulative)`` pair per evaluated symbol

    matches = []
    skipped = []
    total = len(rows)
    errors = []
    done = 0
    lock = threading.Lock()

    def work(row):
        nonlocal done
        symbol = row["symbol"]
        state = {"matched": False, "values": None, "skip": False}

        def finish():
            with lock:
                nonlocal done
                done += 1
                if on_progress:
                    on_progress(done, total)

        try:
            # one klines fetch per distinct timeframe, reused by every field
            # that asks for it
            series = {tf: series_for(symbol, tf, plan) for tf in tfs}
            data = series[base_tf]
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not fail the scan
            with lock:
                errors.append({"symbol": symbol, "error": str(exc)})
            finish()
            return

        try:
            idx = _closed_index(data)
            if idx < 1:
                # freshly listed pair - nothing to evaluate yet, not an error
                state["skip"] = True
                with lock:
                    skipped.append(symbol)
            else:
                ticker = symbol[:-4].upper()
                market = fund.get(ticker) or {}
                ctx = {tf: make_ctx(series[tf], market, row) for tf in tfs}
                ev = EvalContext(ctx)
                for spec in plan["fields"]:
                    _, slot_idx = ev.slot(spec["tf"], spec["state"])
                    if slot_idx < 1:
                        # not enough history on that timeframe yet
                        state["skip"] = True
                        with lock:
                            skipped.append(symbol)
                        break
                if not state["skip"]:
                    cache = {}
                    state["matched"] = evaluate(plan["ast"], plan, ev, cache, idx)
                    if state["matched"]:
                        values = {}
                        for spec in plan["fields"]:
                            slot_data, slot_idx = ev.slot(spec["tf"], spec["state"])
                            slot_values = resolve(spec, slot_data, cache)
                            values[spec["id"]] = fmt_value(
                                slot_values[slot_idx], spec["fmt"]
                            )
                        state["values"] = values
                    if steps:
                        try:
                            solo, cum, alive = [], [], and_root
                            for node, _text in steps:
                                ok = bool(evaluate(node, plan, ev, cache, idx))
                                solo.append(ok)
                                alive = (alive and ok) if and_root else (alive or ok)
                                cum.append(alive)
                            with lock:
                                funnel.append((solo, cum))
                        except Exception:  # noqa: BLE001 - debug must not break a scan
                            pass
        except Exception as exc:  # noqa: BLE001
            with lock:
                errors.append({"symbol": symbol, "error": str(exc)})
        finally:
            finish()

        if state["skip"] or not state["matched"]:
            return

        meta = snap.get(symbol, row)
        market = fund.get(symbol[:-4].upper()) or {}
        entry = {
            "symbol": symbol,
            "base": row.get("base") or symbol[:-4],
            "name": market.get("name"),
            "price": meta.get("price") or data["close"][idx],
            "change_pct": meta.get("change_pct"),
            "quote_volume": meta.get("quote_volume") or row.get("quote_volume"),
            "market_cap": market.get("market_cap"),
            "rank": market.get("market_cap_rank"),
            "exchanges": row.get("exchanges") or [],
            "halal": row.get("halal"),
            "halal_votes": row.get("halal_votes"),
            # "platform" = one of the five lists called it; "auto" = none of
            # them has assessed it yet and the structural screen let it through
            "halal_source": row.get("halal_source") or "platform",
            "values": state["values"],
            "bar_time": data["time"][idx],
        }
        if include_spark:
            entry["spark"] = _spark(data, idx)
        with lock:
            matches.append(entry)

    list(exchange._executor.map(work, rows))

    debug_rows = None
    if steps:
        solo_counts = [0] * len(steps)
        cum_counts = [0] * len(steps)
        for solo, cum in funnel:
            for i, ok in enumerate(solo):
                if ok:
                    solo_counts[i] += 1
            for i, ok in enumerate(cum):
                if ok:
                    cum_counts[i] += 1
        debug_rows = [
            {
                "text": text,
                "matched": cum_counts[i],
                "solo": solo_counts[i],
                "evaluated": len(funnel),
            }
            for i, (_node, text) in enumerate(steps)
        ]

    sorters = {
        "volume": lambda r: -(r.get("quote_volume") or 0),
        "price": lambda r: -(r.get("price") or 0),
        "change": lambda r: -(r.get("change_pct") or 0),
        "mcap": lambda r: -(r.get("market_cap") or 0),
        "symbol": lambda r: r["symbol"],
    }
    matches.sort(key=sorters.get(sort_by, sorters["volume"]))
    if max_results:
        matches = matches[: int(max_results)]

    return {
        "results": matches,
        "scanned": total,
        "matched": len(matches),
        "skipped": len(skipped),
        "errors": errors[:20],
        "error_count": len(errors),
        "debug": debug_rows,
    }


def compute_values(symbols, columns, interval="1d", on_progress=None):
    """Values for display-only columns on a fixed set of symbols.

    Only the requested symbols are touched (their candles are usually still
    warm in the cache from the scan that produced them), so "Add Column" on an
    existing result set is far cheaper than re-running the scan.

    Each column carries its own timeframe, so every distinct ``spec["tf"]`` is
    fetched and resolved separately — a weekly column has to be computed from
    weekly bars, not from the daily ones the base interval uses.

    ``on_progress(done, total)`` fires once per symbol under the result lock,
    which is what the watchlist's two-phase load uses to fill its progress bar.
    """
    specs = _normalise(_column_specs(columns), interval=interval)
    fields = [
        {"id": s["id"], "fmt": s["fmt"], "label": s["label"]} for s in specs
    ]
    if not specs or not symbols:
        return {"values": {}, "fields": fields}

    tfs = []
    for spec in specs:
        tf = spec.get("tf") or interval
        if tf not in tfs:
            tfs.append(tf)

    fund = exchange.fundamentals()
    volumes = {}
    if any(s["field"] == "quote_volume_24h" for s in specs):
        volumes = {
            r["symbol"]: r.get("quote_volume") for r in exchange.universe()
        }

    out = {}
    lock = threading.Lock()
    plan = {"interval": interval, "limit": 400}
    symbols = list(symbols)
    state = {"done": 0}
    total = len(symbols)

    def work(symbol):
        values = None
        try:
            market = fund.get(symbol[:-4].upper()) or {}
            series = {}
            usable = True
            for tf in tfs:
                data = series_for(symbol, tf, plan)
                if len(data.get("close") or []) < 2:
                    usable = False           # freshly listed, nothing to read
                    break
                series[tf] = {
                    "open": data["open"],
                    "high": data["high"],
                    "low": data["low"],
                    "close": data["close"],
                    "volume": data["volume"],
                    "quote_volume": data.get("quote_volume"),
                    "closed": data.get("closed"),
                    "fund": {
                        "market_cap": market.get("market_cap"),
                        "market_cap_rank": market.get("market_cap_rank"),
                        "quote_volume_24h": volumes.get(symbol),
                    },
                }
            if usable:
                ev = EvalContext(series)
                cache = {}
                found = {}
                for spec in specs:
                    slot_data, slot_idx = ev.slot(spec["tf"], spec["state"])
                    if slot_data is None or not (0 <= slot_idx < len(slot_data["close"])):
                        continue    # not enough history on that timeframe
                    resolved = resolve(spec, slot_data, cache)
                    if slot_idx < len(resolved):
                        found[spec["id"]] = fmt_value(resolved[slot_idx],
                                                      spec["fmt"])
                if found:
                    values = found
        except Exception:  # noqa: BLE001 - one bad symbol must not fail the call
            values = None
        with lock:
            if values:
                out[symbol] = values
            state["done"] += 1
            if on_progress:
                on_progress(state["done"], total)
        return None

    list(exchange._executor.map(work, symbols))
    return {"values": out, "fields": fields}


# --------------------------------------------------------------------------
# background jobs (so the UI can show progress)
# --------------------------------------------------------------------------

_jobs = {}
_jobs_lock = threading.Lock()
_JOB_TTL = 600


def _gc_jobs():
    now = time.time()
    stale = [k for k, v in _jobs.items() if now - v["created"] > _JOB_TTL]
    for k in stale:
        _jobs.pop(k, None)


def start_scan(payload):
    """Kick off a scan in the background and return its job id."""
    clause = payload.get("clause") or payload.get("scan_clause") or ""
    interval = payload.get("interval") or "1d"
    limit = int(payload.get("limit") or 400)
    plan = build_plan(clause, interval=interval, limit=limit,
                      columns=payload.get("columns"))

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "queued",
        "done": 0,
        "total": 0,
        "clause": plan["clause"],
        "columns": plan["columns"],
        "fields": [
            {"id": f["id"], "fmt": f["fmt"], "label": f["label"]}
            for f in plan["fields"]
        ],
        "interval": interval,
        "results": [],
        "scanned": 0,
        "matched": 0,
        "errors": [],
        "error": None,
        "created": time.time(),
        "elapsed": 0.0,
    }
    with _jobs_lock:
        _gc_jobs()
        _jobs[job_id] = job

    size = int(payload.get("universe") or 0)
    venue, halal_only = screen_filters(payload)
    # Screens only show spot coins the halal platforms endorse - flip with halal_only=false.
    job["halal_only"] = halal_only
    job["venue"] = venue or "all"
    universe_rows = apply_filters(
        exchange.universe(size=size) if size else exchange.universe(),
        venue=venue, halal_only=halal_only,
    )
    sort_by = payload.get("sort_by") or "volume"
    max_results = int(payload.get("max_results") or 0)
    job["total"] = len(universe_rows)
    job["status"] = "running"
    started = time.time()

    def progress(done, total):
        job["done"] = done
        job["total"] = total
        job["elapsed"] = round(time.time() - started, 2)

    def runner():
        try:
            outcome = run_scan(
                plan,
                universe_rows=universe_rows,
                on_progress=progress,
                sort_by=sort_by,
                max_results=max_results,
                halal_only=halal_only,
                venue=venue,
                debug=bool(payload.get("debug")),
            )
            job.update(outcome)
            job["status"] = "done"
        except Exception as exc:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = str(exc)
        finally:
            job["elapsed"] = round(time.time() - started, 2)

    threading.Thread(target=runner, daemon=True, name=f"scan-{job_id[:8]}").start()
    return job_id


def get_scan(job_id):
    with _jobs_lock:
        return _jobs.get(job_id)


def start_values(payload):
    """Compute display columns for a fixed symbol list in the background.

    Used by the watchlist's second phase: the group's universe rows paint
    instantly, then this job fills the eight calculated columns and reports
    ``done/total`` so the table can show a progress bar.  Same job registry as
    :func:`start_scan`, so one poller handles both.
    """
    symbols = [str(s).upper() for s in (payload.get("symbols") or [])]
    if not symbols:
        raise ValueError("symbols is required")
    if len(symbols) > 500:
        raise ValueError("symbols must be a list of at most 500")
    columns = [str(c) for c in (payload.get("columns") or [])]
    if not columns:
        raise ValueError("columns is required")
    interval = payload.get("interval") or "1d"
    # validate up front so the API can answer 400 instead of handing back a job
    # that is already doomed
    _normalise(_column_specs(columns), interval=interval)

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "kind": "values",
        "status": "running",
        "done": 0,
        "total": len(symbols),
        "symbols": symbols,
        "columns": columns,
        "interval": interval,
        "fields": [],
        "values": {},
        "error": None,
        "created": time.time(),
        "elapsed": 0.0,
    }
    with _jobs_lock:
        _gc_jobs()
        _jobs[job_id] = job

    started = time.time()

    def progress(done, total):
        job["done"] = done
        job["total"] = total
        job["elapsed"] = round(time.time() - started, 2)

    def runner():
        try:
            outcome = compute_values(symbols, columns, interval=interval,
                                     on_progress=progress)
            job["values"] = outcome["values"]
            job["fields"] = outcome["fields"]
            job["status"] = "done"
        except Exception as exc:  # noqa: BLE001 - report it, never raise into a thread
            job["status"] = "error"
            job["error"] = str(exc)
        finally:
            job["elapsed"] = round(time.time() - started, 2)
            job["done"] = job["total"]

    threading.Thread(target=runner, daemon=True, name=f"values-{job_id[:8]}").start()
    return job_id


def get_values(job_id):
    with _jobs_lock:
        return _jobs.get(job_id)
