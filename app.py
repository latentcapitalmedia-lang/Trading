"""chartink-crypto - a Chartink-style screener for cryptocurrency.

Run it with::

    python app.py

then open http://127.0.0.1:5000
"""

from __future__ import annotations

import csv
import io
import json
import os
import time

from flask import Flask, Response, jsonify, request, send_from_directory

from engine import alerts, backtest, exchange, halal, scanner, watchlist
from engine.expressions import ClauseError
from engine.fields import describe
from engine.presets import load as presets_load
from engine.scanner import build_plan, get_scan, get_values, run_scan, start_scan, start_values

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

PORT = int(os.environ.get("PORT", "5000"))

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.json.sort_keys = False


# --------------------------------------------------------------------------
# static
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.after_request
def allow_cors(response):
    # The API is meant to be callable from scripts and other sites.
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Requested-With"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    if request.path.startswith("/static/"):
        # local tool: never let a stale bundle hide a change
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


@app.errorhandler(ClauseError)
def on_clause_error(exc):
    return jsonify({"error": exc.message, "pos": exc.pos}), 400


@app.errorhandler(404)
def on_not_found(_):
    if request.path.startswith("/api/") or request.path.startswith("/screener/"):
        return jsonify({"error": "not found"}), 404
    return send_from_directory(STATIC_DIR, "index.html")


@app.errorhandler(exchange.DataError)
def on_data_error(exc):
    return jsonify({"error": str(exc)}), 502


# --------------------------------------------------------------------------
# metadata
# --------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return jsonify({"ok": True, "time": time.time(), "app": "chartink-crypto"})


@app.get("/api/fields")
def fields():
    """Every field usable inside a clause."""
    return jsonify({"fields": describe()})


@app.get("/api/presets")
def presets():
    return jsonify(presets_load())


@app.get("/api/parse")
def parse_clause():
    """Parse a clause and return its AST (used by the on-page builder)."""
    clause = request.args.get("clause") or request.args.get("scan_clause") or ""
    plan = build_plan(clause,
                      interval=request.args.get("interval", "1d"),
                      limit=int(request.args.get("limit", 400)))
    return jsonify({"ok": True, "clause": plan["clause"],
                    "columns": plan["columns"], "ast": plan["ast"]})


@app.get("/api/validate")
def validate():
    """Parse a clause and return the normalised version (no scanning)."""
    clause = request.args.get("clause") or request.args.get("scan_clause") or ""
    plan = build_plan(
        clause,
        interval=request.args.get("interval", "1d"),
        limit=int(request.args.get("limit", 400)),
    )
    return jsonify({
        "ok": True,
        "clause": plan["clause"],
        "columns": plan["columns"],
        "fields": [{k: v for k, v in f.items()} for f in plan["fields"]],
        "interval": plan["interval"],
    })


@app.get("/api/universe")
def universe():
    size = int(request.args.get("size", 400))
    venue, _ = scanner.screen_filters({"venue": request.args.get("venue")})
    rows = scanner.apply_filters(
        exchange.universe(size=size), venue=venue,
        halal_only=scanner.as_bool(request.args.get("halal"), False),
    )
    return jsonify({"count": len(rows), "rows": rows})


@app.get("/api/halal")
def halal_screen():
    """The five screening platforms, the majority rule and what it screens out."""
    return jsonify({
        "platforms": halal.platforms(),
        "rule": halal.rule(),
        "updated": halal.updated(),
        "summary": halal.summary(),
    })


@app.get("/api/ticker")
def ticker():
    """24h ticker for explicit symbols: ``/api/ticker?symbols=BTCUSDT,ETHUSDT``"""
    raw = request.args.get("symbols") or ""
    symbols = [s.strip().upper() for s in raw.replace(";", ",").split(",") if s.strip()]
    if not symbols:
        return jsonify({"error": "symbols is required"}), 400
    return jsonify({"rows": exchange.ticker(symbols)})


@app.get("/api/klines")
def klines():
    symbol = (request.args.get("symbol") or "").upper()
    if not symbol:
        return jsonify({"error": "symbol is required"}), 400
    interval = request.args.get("interval", "1d")
    limit = int(request.args.get("limit", 400))
    data = exchange.klines(symbol, interval, limit)
    return jsonify(data)


# --------------------------------------------------------------------------
# scanning
# --------------------------------------------------------------------------

@app.post("/api/scan")
def scan_start():
    """Start a scan in the background; poll ``GET /api/scan/<id>``."""
    payload = request.get_json(silent=True) or request.form.to_dict()
    try:
        job_id = start_scan(payload)
    except ClauseError as exc:
        return jsonify({"error": exc.message, "pos": exc.pos}), 400
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"job_id": job_id})


@app.get("/api/scan/<job_id>")
def scan_status(job_id):
    job = get_scan(job_id)
    if job is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(job)


@app.post("/api/scan/sync")
def scan_sync():
    """Blocking scan - handy for scripts and curl."""
    payload = request.get_json(silent=True) or request.form.to_dict()
    try:
        plan = build_plan(
            payload.get("clause") or payload.get("scan_clause") or "",
            interval=payload.get("interval", "1d"),
            limit=int(payload.get("limit", 400)),
            columns=payload.get("columns"),
        )
        venue, halal_only = scanner.screen_filters(payload)
        outcome = run_scan(
            plan,
            universe_rows=scanner.apply_filters(
                exchange.universe(size=int(payload.get("universe") or 0))
                if payload.get("universe") else exchange.universe(),
                venue=venue, halal_only=halal_only,
            ),
            sort_by=payload.get("sort_by", "volume"),
            max_results=int(payload.get("max_results") or 0),
            halal_only=halal_only,
            venue=venue,
        )
    except ClauseError as exc:
        return jsonify({"error": exc.message, "pos": exc.pos}), 400
    outcome["clause"] = plan["clause"]
    outcome["columns"] = plan["columns"]
    outcome["fields"] = [
        {"id": f["id"], "fmt": f["fmt"], "label": f["label"]} for f in plan["fields"]
    ]
    return jsonify(outcome)


@app.post("/api/backtest")
def backtest_run():
    """Replay a clause over the last N closed bars.

    Body: ``{clause, venue, halal_only, interval, universe, bars, date?}``.
    Returns ascending ``dates``, one ``counts`` entry per date and, when a
    ``date`` was supplied, the matching ``rows`` for that day.
    """
    payload = request.get_json(silent=True) or request.form.to_dict()
    try:
        return jsonify(backtest.run(payload))
    except ClauseError as exc:
        return jsonify({"error": exc.message, "pos": exc.pos}), 400
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/screener/process", methods=["GET", "POST"])
def screener_process():
    """Chartink-compatible scan endpoint.

    Accepts ``scan_clause`` as form data, JSON or a query string and returns
    JSON by default. Append ``format=html`` or ``format=csv`` for other shapes.
    """
    payload = {}
    payload.update(request.args.to_dict())
    if request.form:
        payload.update(request.form.to_dict())
    if request.is_json:
        payload.update(request.get_json(silent=True) or {})

    clause = payload.get("scan_clause") or payload.get("clause") or ""
    fmt = (payload.get("format") or "json").lower()

    try:
        plan = build_plan(
            clause,
            interval=payload.get("interval", "1d"),
            limit=int(payload.get("limit", 400)),
            columns=payload.get("columns"),
        )
        size = int(payload.get("universe") or 0)
        venue, halal_only = scanner.screen_filters(payload)
        universe_rows = scanner.apply_filters(
            exchange.universe(size=size) if size else exchange.universe(),
            venue=venue, halal_only=halal_only,
        )
        outcome = run_scan(
            plan,
            universe_rows=universe_rows,
            sort_by=payload.get("sort_by", "volume"),
            max_results=int(payload.get("max_results") or 0),
            include_spark=fmt == "json",
            halal_only=halal_only,
            venue=venue,
        )
    except ClauseError as exc:
        return jsonify({"error": exc.message, "pos": exc.pos}), 400
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    outcome["clause"] = plan["clause"]
    outcome["columns"] = plan["columns"]
    outcome["fields"] = [
        {"id": f["id"], "fmt": f["fmt"], "label": f["label"]} for f in plan["fields"]
    ]

    if fmt == "html":
        return Response(render_html(outcome), mimetype="text/html")
    if fmt == "csv":
        return Response(render_csv(outcome), mimetype="text/csv")
    return jsonify(outcome)


@app.post("/api/columns")
def scan_columns():
    """Compute extra display columns for an existing result set."""
    payload = request.get_json(silent=True) or {}
    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list) or len(symbols) > 500:
        return jsonify({"error": "symbols must be a list of at most 500"}), 400
    try:
        return jsonify(scanner.compute_values(
            [str(s).upper() for s in symbols],
            payload.get("columns"),
            interval=payload.get("interval") or "1d",
        ))
    except ClauseError as exc:
        return jsonify({"error": exc.message, "pos": exc.pos}), 400
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400


def _table_rows(outcome):
    head = ["symbol", "price", "change_pct"] + outcome["columns"]
    rows = []
    for r in outcome["results"]:
        row = [r["symbol"], r.get("price"), r.get("change_pct")]
        for col in outcome["columns"]:
            row.append((r.get("values") or {}).get(col))
        rows.append(row)
    return head, rows


def render_csv(outcome):
    head, rows = _table_rows(outcome)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(head)
    writer.writerows(rows)
    return buf.getvalue()


def render_html(outcome):
    head, rows = _table_rows(outcome)
    parts = [
        "<table class='cx-table'><thead><tr>",
        "".join(f"<th>{h}</th>" for h in head),
        "</tr></thead><tbody>",
    ]
    for row in rows:
        parts.append("<tr>" + "".join(f"<td>{'' if v is None else v}</td>" for v in row) + "</tr>")
    parts.append("</tbody></table>")
    parts.append(f"<p class='cx-meta'>{len(rows)} of {outcome['scanned']} scanned</p>")
    return "".join(parts)


# --------------------------------------------------------------------------
# klines for the chart page
# --------------------------------------------------------------------------

@app.get("/api/chart/<symbol>")
def chart(symbol):
    interval = request.args.get("interval", "1d")
    try:
        limit = int(request.args.get("limit", 300))
    except (TypeError, ValueError):
        limit = 300
    # 0 / negative = "everything I can get in one page"; the chart pages back
    # from `end_time` until the exchange runs out of history.
    limit = 1000 if limit <= 0 else min(limit, 1000)
    end_time = None
    raw_end = request.args.get("end_time")
    if raw_end:
        try:
            end_time = int(raw_end)
        except (TypeError, ValueError):
            end_time = None
    symbol = symbol.upper()
    # Backfill pages stay on the venue the chart first loaded from.
    source = request.args.get("source") or None
    try:
        data = exchange.klines(symbol, interval, limit, end_time=end_time, source=source)
    except exchange.DataError:
        if end_time is None:
            raise
        # The walk reached the symbol's very first bar.  An empty page with
        # has_more=false is the end of history, not a failure.
        data = {"symbol": symbol, "interval": interval, "source": source,
                "time": [], "open": [], "high": [], "low": [], "close": [],
                "volume": [], "closed": []}
    market = exchange.fundamentals().get(symbol[:-4].upper()) or {}
    times = data["time"]
    return jsonify({
        "symbol": data["symbol"],
        "interval": data["interval"],
        "source": data.get("source"),
        "market_cap": market.get("market_cap"),
        "rank": market.get("market_cap_rank"),
        "name": market.get("name"),
        # a full window means the exchange almost certainly holds older bars
        "has_more": len(times) >= limit,
        "first": times[0] if times else None,
        "time": times,
        "open": data["open"],
        "high": data["high"],
        "low": data["low"],
        "close": data["close"],
        "volume": data["volume"],
        "closed": data["closed"],
    })


# --------------------------------------------------------------------------
# watchlist (server-side, shared across devices)
# --------------------------------------------------------------------------

@app.get("/api/watchlist")
def watchlist_get():
    return jsonify({"symbols": alerts._read(os.path.join(BASE_DIR, "data", "watchlist.json"), {"symbols": []})["symbols"]})


@app.post("/api/watchlist")
def watchlist_set():
    payload = request.get_json(silent=True) or {}
    symbols = [str(s).upper() for s in payload.get("symbols", [])]
    alerts._write(os.path.join(BASE_DIR, "data", "watchlist.json"), {"symbols": symbols})
    return jsonify({"symbols": symbols})


# --------------------------------------------------------------------------
# Pine scripts — server-side mirror of the browser's cx.pine.scripts
#
# localStorage is per-browser and can be evicted wholesale; one did, and every
# saved script went with it. The chart keeps localStorage as its fast path and
# mirrors the same map here, so a wipe now costs nothing beyond a page load.
# --------------------------------------------------------------------------

PINE_FILE = os.path.join(BASE_DIR, "data", "pine_scripts.json")


@app.get("/api/pine")
def pine_get():
    return jsonify(alerts._read(PINE_FILE, {"scripts": {}}))


@app.post("/api/pine")
def pine_set():
    payload = request.get_json(silent=True) or {}
    raw = payload.get("scripts")
    if not isinstance(raw, dict):
        return jsonify({"error": "scripts must be an object of id -> source"}), 400
    # Only strings survive the round trip: the map is written straight back out
    # on the next load, so an accidental non-string would be persisted forever.
    scripts = {str(k): str(v) for k, v in raw.items() if isinstance(v, str) and v.strip()}
    alerts._write(PINE_FILE, {"scripts": scripts})
    return jsonify({"scripts": scripts})


# --------------------------------------------------------------------------
# watchlist groups: five exchange lists, favourites, five custom
# --------------------------------------------------------------------------

@app.get("/api/watchlist/groups")
def watchlist_groups():
    """Group strip metadata: ids, labels, symbols, and the 12-column schema."""
    return jsonify(watchlist.list_groups(limit=request.args.get("limit")))


@app.post("/api/watchlist/groups")
def watchlist_group_create():
    payload = request.get_json(silent=True) or request.form.to_dict()
    try:
        group = watchlist.create(payload.get("name"), payload.get("symbols"))
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"group": group})


@app.get("/api/watchlist/groups/<group_id>")
def watchlist_group_rows(group_id):
    """Phase 0 - rows straight off the universe, no candles fetched."""
    meta = watchlist.find(group_id)
    if meta is None:
        return jsonify({"error": "unknown group"}), 404
    limit = request.args.get("limit")
    return jsonify(dict(
        meta,
        limit=limit,
        rows=watchlist.rows_for(group_id, limit),
        columns=[dict(c) for c in watchlist.COLUMNS],
        compute_fields=watchlist.compute_fields()[2],
    ))


@app.put("/api/watchlist/groups/<group_id>")
def watchlist_group_update(group_id):
    payload = request.get_json(silent=True) or {}
    try:
        group = watchlist.update(group_id, name=payload.get("name"),
                                 symbols=payload.get("symbols"))
    except KeyError:
        return jsonify({"error": "unknown group"}), 404
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"group": group})


@app.delete("/api/watchlist/groups/<group_id>")
def watchlist_group_delete(group_id):
    try:
        watchlist.delete(group_id)
    except KeyError:
        return jsonify({"error": "unknown group"}), 404
    return jsonify({"ok": True, "active": watchlist.active_id()})


@app.post("/api/watchlist/groups/<group_id>/activate")
def watchlist_group_activate(group_id):
    try:
        return jsonify({"active": watchlist.set_active(group_id)})
    except KeyError:
        return jsonify({"error": "unknown group"}), 404


@app.post("/api/watchlist/values")
def watchlist_values_start():
    """Start phase 2: the seven candle-derived columns, with progress.

    Body carries ``symbols`` directly, or just ``group`` to have the server
    resolve them (they will match the phase-0 payload for the same ``limit``).
    Returns ``job_id`` plus ``id_to_key`` so the poller can drop the scanner's
    ``macd_histogram(12,26,9)@closed weekly`` style ids for table keys.
    """
    payload = request.get_json(silent=True) or {}
    symbols = payload.get("symbols")
    if not symbols:
        try:
            symbols = [r["symbol"] for r in watchlist.rows_for(
                payload.get("group") or watchlist.active_id(),
                payload.get("limit"))]
        except KeyError:
            return jsonify({"error": "unknown group"}), 404
    try:
        job_id = start_values({
            "symbols": symbols,
            "columns": payload.get("columns") or list(watchlist.COMPUTE_COLUMNS),
            "interval": payload.get("interval") or "1d",
        })
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except ClauseError as exc:
        return jsonify({"error": exc.message, "pos": exc.pos}), 400
    return jsonify({"job_id": job_id,
                    "id_to_key": watchlist.compute_fields()[1],
                    "fields": watchlist.compute_fields()[2]})


@app.get("/api/watchlist/values/<job_id>")
def watchlist_values_status(job_id):
    job = get_values(job_id)
    if job is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(dict(job, id_to_key=watchlist.compute_fields()[1]))


# --------------------------------------------------------------------------
# alerts
# --------------------------------------------------------------------------

@app.get("/api/alerts")
def alerts_list():
    return jsonify({"alerts": alerts.list_alerts(), "status": alerts.status(),
                    "settings": alerts._safe_settings()})


@app.post("/api/alerts")
def alerts_create():
    payload = request.get_json(silent=True) or request.form.to_dict()
    try:
        return jsonify(alerts.create_alert(payload))
    except ClauseError as exc:
        return jsonify({"error": exc.message}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.put("/api/alerts/<alert_id>")
def alerts_update(alert_id):
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(alerts.update_alert(alert_id, payload))
    except ClauseError as exc:
        return jsonify({"error": exc.message}), 400
    except KeyError:
        return jsonify({"error": "unknown alert"}), 404


@app.delete("/api/alerts/<alert_id>")
def alerts_delete(alert_id):
    try:
        alerts.delete_alert(alert_id)
        return jsonify({"ok": True})
    except KeyError:
        return jsonify({"error": "unknown alert"}), 404


@app.get("/api/alerts/pending")
def alerts_pending():
    return jsonify({"items": alerts.pending()})


@app.post("/api/alerts/pending/clear")
def alerts_pending_clear():
    alerts.clear_pending()
    return jsonify({"ok": True})


@app.post("/api/alerts/run")
def alerts_run():
    summary = alerts.run_once()
    return jsonify(summary)


@app.get("/api/settings")
def settings_get():
    return jsonify(alerts._safe_settings())


@app.post("/api/settings")
def settings_post():
    payload = request.get_json(silent=True) or {}
    return jsonify(alerts.update_settings(payload))


@app.post("/api/settings/test-telegram")
def settings_test():
    return jsonify(alerts.test_telegram())


# --------------------------------------------------------------------------

def main():
    os.makedirs(os.path.join(BASE_DIR, "data"), exist_ok=True)
    alerts.start()
    print(f"chartink-crypto running on http://127.0.0.1:{PORT}")
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
