"""Alert engine: rerun saved scans on a timer and notify on new matches."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid

import requests

from . import exchange
from .scanner import as_bool, build_plan, run_scan

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
ALERTS_FILE = os.path.join(DATA_DIR, "alerts.json")
PENDING_FILE = os.path.join(DATA_DIR, "pending.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

DEFAULT_SETTINGS = {
    "telegram_token": "",
    "telegram_chat_id": "",
    "cadence_seconds": 300,
    "universe": 150,
    "default_interval": "1d",
    "browser_notifications": True,
    "halal_only": True,
}

MAX_PENDING = 60

_lock = threading.Lock()
_state = {}          # alert_id -> set of symbols matching on the previous run
_thread = None
_current = {"running": False, "last_run": None, "last_error": None}


# --------------------------------------------------------------------------
# file helpers
# --------------------------------------------------------------------------

def _read(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


_write_lock = threading.Lock()


def _write(path, payload):
    # Serialise writers: concurrent requests otherwise collide on the same
    # temp file and os.replace() fails on Windows (WinError 32).
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, threading.get_ident())
    with _write_lock:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
        os.replace(tmp, path)


def get_settings():
    data = _read(SETTINGS_FILE, {})
    merged = dict(DEFAULT_SETTINGS)
    merged.update({k: v for k, v in data.items() if v is not None})
    return merged


def save_settings(patch):
    merged = get_settings()
    merged.update(patch or {})
    _write(SETTINGS_FILE, merged)
    return merged


def update_settings(payload):
    """Persist settings, ignoring the masked token placeholder from the UI."""
    patch = {k: v for k, v in (payload or {}).items() if k in DEFAULT_SETTINGS}
    token = patch.get("telegram_token")
    if isinstance(token, str) and ("..." in token or token in ("set", "")):
        patch.pop("telegram_token", None)
    for key in ("cadence_seconds", "universe"):
        if key in patch:
            try:
                patch[key] = int(patch[key])
            except (TypeError, ValueError):
                patch.pop(key, None)
    save_settings(patch)
    return _safe_settings()


def _safe_settings():
    """Settings with the bot token masked for the UI."""
    data = dict(get_settings())
    token = data.get("telegram_token") or ""
    data["telegram_token_set"] = bool(token)
    data["telegram_token"] = (token[:6] + "..." + token[-4:]) if len(token) > 12 else ("set" if token else "")
    return data


# --------------------------------------------------------------------------
# alert CRUD
# --------------------------------------------------------------------------

def list_alerts():
    alerts = _read(ALERTS_FILE, {"alerts": []})
    return alerts.get("alerts", [])


def _save_alerts(items):
    _write(ALERTS_FILE, {"alerts": items})


def _clean_venue(value):
    """Normalise an exchange segment (None / 'binance' / ... / 'okx')."""
    venue = str(value or "").strip().lower()
    return venue if venue in exchange.VENUES else None


def create_alert(payload):
    name = (payload.get("name") or "Untitled scan").strip()
    clause = (payload.get("clause") or "").strip()
    if not clause:
        raise ValueError("clause is required")
    plan = build_plan(
        clause,
        interval=payload.get("interval") or get_settings()["default_interval"],
        limit=int(payload.get("limit") or 400),
    )
    alert = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "clause": plan["clause"],
        "interval": plan["interval"],
        "limit": plan["limit"],
        "universe": int(payload.get("universe") or get_settings()["universe"]),
        "venue": _clean_venue(payload.get("venue")),
        "enabled": bool(payload.get("enabled", True)),
        "created": time.time(),
        "last_run": None,
        "last_count": None,
        "notify_browser": bool(payload.get("notify_browser", True)),
        "notify_telegram": bool(payload.get("notify_telegram", True)),
    }
    items = list_alerts()
    items.insert(0, alert)
    _save_alerts(items)
    _state[alert["id"]] = set()
    return alert


def update_alert(alert_id, patch):
    items = list_alerts()
    for alert in items:
        if alert["id"] == alert_id:
            if "clause" in patch and patch["clause"]:
                plan = build_plan(patch["clause"], interval=alert["interval"], limit=alert["limit"])
                alert["clause"] = plan["clause"]
            for key in ("name", "enabled", "notify_browser", "notify_telegram", "interval", "universe"):
                if key in patch:
                    alert[key] = patch[key]
            if "venue" in patch:
                alert["venue"] = _clean_venue(patch.get("venue"))
            _save_alerts(items)
            return alert
    raise KeyError(alert_id)


def delete_alert(alert_id):
    items = list_alerts()
    kept = [a for a in items if a["id"] != alert_id]
    if len(kept) == len(items):
        raise KeyError(alert_id)
    _save_alerts(kept)
    _state.pop(alert_id, None)


# --------------------------------------------------------------------------
# notifications
# --------------------------------------------------------------------------

def pending(limit=MAX_PENDING):
    return _read(PENDING_FILE, {"items": []}).get("items", [])[:limit]


def clear_pending():
    _write(PENDING_FILE, {"items": []})


def _push(alert, rows):
    settings = get_settings()
    now = time.time()
    items = [{"alert": row.pop("_alert_name", alert["name"]),
              "symbol": row["symbol"],
              "price": row.get("price"),
              "time": now} for row in rows]

    if alert.get("notify_browser", True):
        existing = _read(PENDING_FILE, {"items": []}).get("items", [])
        merged = items + existing
        _write(PENDING_FILE, {"items": merged[:MAX_PENDING]})

    token = settings.get("telegram_token")
    chat = settings.get("telegram_chat_id")
    if alert.get("notify_telegram", True) and token and chat:
        lines = [f"<b>{alert['name']}</b> - {len(rows)} new match(es)"]
        for row in rows[:15]:
            price = row.get("price")
            lines.append(
                f"• <code>{row['symbol']}</code> @ {price:,.6g}"
                if isinstance(price, (int, float))
                else f"• <code>{row['symbol']}</code>"
            )
        if len(rows) > 15:
            lines.append(f"...and {len(rows) - 15} more")
        try:
            requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat, "text": "\n".join(lines), "parse_mode": "HTML"},
                timeout=15,
            )
        except requests.RequestException as exc:
            _current["last_error"] = f"telegram: {exc}"


def test_telegram():
    settings = get_settings()
    token = settings.get("telegram_token")
    chat = settings.get("telegram_chat_id")
    if not token or not chat:
        return {"ok": False, "error": "Set both the bot token and the chat id first."}
    try:
        resp = requests.get(
            f"https://api.telegram.org/bot{token}/sendMessage",
            params={"chat_id": chat, "text": "chartink-crypto alert test OK"},
            timeout=15,
        )
        return {"ok": resp.ok, "raw": resp.json()}
    except requests.RequestException as exc:
        return {"ok": False, "error": str(exc)}


# --------------------------------------------------------------------------
# scheduler
# --------------------------------------------------------------------------

def run_once():
    """Evaluate every enabled alert. Returns a summary."""
    settings = get_settings()
    _current["running"] = True
    checked = notified = 0
    try:
        for alert in list_alerts():
            if not alert.get("enabled"):
                continue
            try:
                plan = build_plan(
                    alert["clause"], interval=alert.get("interval", "1d"),
                    limit=alert.get("limit", 400),
                )
                rows = exchange.universe(size=int(alert.get("universe") or 150))
                only_halal = as_bool(get_settings().get("halal_only"), True)
                outcome = run_scan(plan, universe_rows=rows, include_spark=False,
                                   halal_only=only_halal,
                                   venue=(alert.get("venue") or None))
                checked += 1
            except Exception as exc:  # noqa: BLE001
                _current["last_error"] = f"{alert.get('name')}: {exc}"
                continue

            symbols = {row["symbol"] for row in outcome["results"]}
            previous = _state.get(alert["id"])
            if previous is None:
                _state[alert["id"]] = symbols      # first run only records a baseline
            else:
                fresh = symbols - previous
                _state[alert["id"]] = symbols
                if fresh:
                    rows_new = [r for r in outcome["results"] if r["symbol"] in fresh]
                    for r in rows_new:
                        r["_alert_name"] = alert["name"]
                    _push(alert, rows_new)
                    notified += len(rows_new)

            items = list_alerts()
            for stored in items:
                if stored["id"] == alert["id"]:
                    stored["last_run"] = time.time()
                    stored["last_count"] = len(symbols)
            _save_alerts(items)
    finally:
        _current["running"] = False
        _current["last_run"] = time.time()
    return {"checked": checked, "notified": notified}


def status():
    return dict(_current, pending=len(pending()), alerts=len(list_alerts()))


def _loop():
    while True:
        settings = get_settings()
        cadence = max(60, int(settings.get("cadence_seconds") or 300))
        try:
            run_once()
        except Exception as exc:  # noqa: BLE001
            _current["last_error"] = str(exc)
        time.sleep(cadence)


def start():
    global _thread
    if _thread is not None:
        return
    _thread = threading.Thread(target=_loop, daemon=True, name="alert-scheduler")
    _thread.start()
