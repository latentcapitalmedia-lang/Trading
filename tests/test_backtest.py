"""Backtest endpoint test: python tests/test_backtest.py

Everything runs in-process against ``app.test_client()`` with the exchange
layer monkeypatched, so no network access and no running server is needed.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import exchange
from engine.expressions import ClauseError

FAILS = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name} {extra}")


# ---------------------------------------------------------------- fake data
DAY = 86400
NOW = int(time.time())
TODAY = NOW - (NOW % DAY)  # open time of the current (still forming) day bar

SYMBOLS = {
    "AAAUSDT": dict(base="AAA", exchanges=["binance"], halal=True, quote_volume=5e8),
    "BBBUSDT": dict(base="BBB", exchanges=["bybit"], halal=True, quote_volume=4e8),
    "CCCUSDT": dict(base="CCC", exchanges=["kucoin"], halal=False, quote_volume=3e8),
    # freshly listed: only a handful of candles, and no volume to speak of
    "DDDUSDT": dict(base="DDD", exchanges=["binance"], halal=True,
                    quote_volume=10, volume=1.0),
}

# how many bars each symbol reports per interval (DDD is freshly listed)
DEPTH = {"DDDUSDT": 3}

# every clause below keeps DDD out: it has almost no volume
CLAUSE = "[close] > 0 and [volume] > 100"


def _series(symbol, step_seconds, bars, price, close_offset=0):
    """Deterministic OHLCV rows ending with the bar that opens at TODAY."""
    rows = []
    depth = DEPTH.get(symbol, bars)
    bars = min(bars, depth)
    volume = SYMBOLS[symbol].get("volume", 1000000.0)
    for i in range(bars):
        t = TODAY - (bars - 1 - i) * step_seconds
        price += 3.0 if (i % 2 == 0) else -3.0
        rows.append({
            "time": t, "open": price, "high": price, "low": price,
            "close": price, "volume": volume, "quote_volume": 1e8,
            "closed": t + step_seconds <= NOW,
        })
    return {
        "symbol": symbol, "interval": str(step_seconds), "source": "fake",
        "time": [r["time"] for r in rows], "open": [r["open"] for r in rows],
        "high": [r["high"] for r in rows], "low": [r["low"] for r in rows],
        "close": [r["close"] for r in rows], "volume": [r["volume"] for r in rows],
        "quote_volume": [r["quote_volume"] for r in rows],
        "closed": [r["closed"] for r in rows],
    }


def fake_klines(symbol, interval="1d", limit=400):
    if interval == "1d":
        return _series(symbol, DAY, limit, 100.0)
    if interval == "4h":
        return _series(symbol, 4 * 3600, limit, 200.0)
    if interval == "30m":
        # enough 30m candles to bucket into `limit` 45m candles
        bars = min(1000, int(limit * 2700 / 1800) + 10)
        return _series(symbol, 1800, bars, 50.0)
    raise exchange.DataError(f"interval {interval} is not offered on fake venue")


def fake_universe(size=None, **kw):
    rows = []
    for symbol, meta in SYMBOLS.items():
        rows.append({
            "symbol": symbol, "base": meta["base"], "exchanges": meta["exchanges"],
            "price": 100.0, "change_pct": 1.2, "quote_volume": meta["quote_volume"],
            "halal": meta["halal"], "halal_votes": [meta["halal"]] * 5,
        })
    return rows[:size] if size else rows


exchange.klines = fake_klines
exchange.universe = fake_universe
exchange.fundamentals = lambda: {
    "AAA": {"name": "Alpha", "market_cap": 1e9, "market_cap_rank": 3},
    "BBB": {"name": "Beta", "market_cap": 5e8, "market_cap_rank": 9},
    "CCC": {"name": "Gamma", "market_cap": 1e8, "market_cap_rank": 40},
    "DDD": {"name": "Delta", "market_cap": None, "market_cap_rank": None},
}

# importing app must not start a server (main() only runs under __main__)
import app as app_module  # noqa: E402

CLIENT = app_module.app.test_client()

ROW_KEYS = [
    "symbol", "base", "name", "price", "change_pct", "quote_volume",
    "market_cap", "rank", "exchanges", "halal", "halal_votes", "halal_source",
    "values", "spark",
]


def post(payload):
    return CLIENT.post("/api/backtest", json=payload)


# ------------------------------------------------------------- basic shape
print("shape")
r = post(dict(clause=CLAUSE, interval="1d", universe=10, bars=30))
data = r.get_json() or {}
check("status 200", r.status_code == 200, r.status_code)
check("ok", data.get("ok") is True, data)
check("interval echoed", data.get("interval") == "1d", data.get("interval"))
check("clause normalised", "clause" in data, list(data))

dates = data.get("dates") or []
counts = data.get("counts") or []
check("dates ascending", dates == sorted(dates), dates[:5])
check("dates are YYYY-MM-DD", all(len(d) == 10 for d in dates), dates[:3])
check("one count per date", len(counts) == len(dates), f"{len(counts)} vs {len(dates)}")
check("bars honoured", len(dates) == 30, len(dates))
check("halal screen applied", all(c == 2 for c in counts), counts)
check("short-history symbol does not error", data.get("error_count") == 0,
      data.get("errors"))
check("scanned keeps the halal screen", data.get("scanned") == 3, data.get("scanned"))
check("no rows without a date", "rows" not in data, list(data))
check("fields metadata", data.get("fields") and data["fields"][0].get("id") == "close",
      data.get("fields"))

# rows appear only for the requested date
print("date rows")
last = dates[-1]
r = post(dict(clause=CLAUSE, interval="1d", universe=10, bars=30, date=last))
data = r.get_json() or {}
rows = data.get("rows")
check("rows for requested date", r.status_code == 200 and isinstance(rows, list),
      str(data)[:160])
check("only halal symbols in rows", rows is not None
      and sorted(x["symbol"] for x in rows) == ["AAAUSDT", "BBBUSDT"],
      rows and [x["symbol"] for x in rows])
if rows:
    keys = sorted(rows[0])
    check("row keys", keys == sorted(ROW_KEYS), keys)
    check("rows sorted by quote volume",
          [x["quote_volume"] for x in rows]
          == sorted([x["quote_volume"] for x in rows], reverse=True),
          [x["quote_volume"] for x in rows])
    check("price is the bar close", all(isinstance(x["price"], (int, float))
                                        for x in rows), rows[0].get("price"))
    check("spark present", all(isinstance(x["spark"], list) and x["spark"]
                               for x in rows))
    check("values formatted", all("close" in x["values"] for x in rows),
          rows[0].get("values"))
    # change_pct must compare the matched bar with the previous one
    src = fake_klines("AAAUSDT", "1d", 30)
    idx = [i for i, t in enumerate(src["time"])
           if time.strftime("%Y-%m-%d", time.gmtime(t)) == last][0]
    expect = (src["close"][idx] / src["close"][idx - 1] - 1.0) * 100.0
    aaa = [x for x in rows if x["symbol"] == "AAAUSDT"][0]
    check("change_pct vs previous bar",
          aaa["change_pct"] is not None and abs(aaa["change_pct"] - expect) < 1e-6,
          f"{aaa['change_pct']} vs {expect}")
    check("row price matches that day",
          abs(aaa["price"] - src["close"][idx]) < 1e-9,
          f"{aaa['price']} vs {src['close'][idx]}")

# a date with no history for a symbol must not raise
print("missing date")
r = post(dict(clause=CLAUSE, interval="1d", universe=10, bars=30,
              date="2019-01-01"))
data = r.get_json() or {}
check("unknown date still 200", r.status_code == 200 and data.get("ok") is True,
      str(data)[:160])
check("unknown date -> empty rows", data.get("rows") == [], data.get("rows"))

# ------------------------------------------------------------------ filters
print("filters")
r = post(dict(clause=CLAUSE, interval="1d", universe=10, bars=10,
              venue="bybit"))
data = r.get_json() or {}
check("venue filter", r.status_code == 200 and data.get("scanned") == 1
      and all(c == 1 for c in data.get("counts") or []),
      (data.get("scanned"), data.get("counts")))

r = post(dict(clause=CLAUSE, interval="1d", universe=10, bars=10,
              halal_only=False))
data = r.get_json() or {}
check("halal_only off", data.get("scanned") == 4
      and all(c == 3 for c in data.get("counts") or []),
      (data.get("scanned"), data.get("counts")))

# --------------------------------------------------------------- matching
print("matching")
r = post(dict(clause="[close] > 1000000", interval="1d", universe=10, bars=10))
data = r.get_json() or {}
check("never-matching clause -> zeros", r.status_code == 200
      and data.get("counts") == [0] * len(data.get("dates") or []),
      data.get("counts"))
r = post(dict(clause="[close] > 1000000", interval="1d", universe=10, bars=10,
              date=(data.get("dates") or ["2020-01-01"])[-1]))
check("never-matching date -> [] rows", (r.get_json() or {}).get("rows") == [],
      str(r.get_json())[:160])

r = post(dict(clause="2nd closed [close] > 0 and [volume] > 100",
              interval="1d", universe=10, bars=10))
data = r.get_json() or {}
check("offset clause runs", r.status_code == 200 and data.get("ok") is True,
      str(data)[:160])
check("offset counts", all(c == 2 for c in data.get("counts") or []),
      data.get("counts"))

r = post(dict(clause="current 4h [rsi(14)] > 10 and " + CLAUSE,
              interval="1d", universe=10, bars=10))
data = r.get_json() or {}
check("multi-timeframe clause runs", r.status_code == 200 and data.get("ok") is True,
      str(data)[:160])
check("multi-timeframe errors stay local", data.get("error_count") == 0,
      data.get("errors"))

# --------------------------------------------------------- bars / defaults
print("bars")
r = post(dict(clause=CLAUSE, interval="1d", universe=10))
check("default bars 66", len((r.get_json() or {}).get("dates") or []) == 66,
      len((r.get_json() or {}).get("dates") or []))

r = post(dict(clause=CLAUSE, interval="1d", universe=10, bars=100000))
dates = (r.get_json() or {}).get("dates") or []
check("bars capped at 400", 0 < len(dates) <= 400, len(dates))

# ------------------------------------------------------------- aggregation
print("aggregation")
r = post(dict(clause="closed 45m [close] > 0 and [volume] > 100",
              interval="45m", universe=10, bars=30))
data = r.get_json() or {}
check("45m backtest runs", r.status_code == 200 and data.get("ok") is True,
      str(data)[:200])
check("45m has dates", len(data.get("dates") or []) > 0, len(data.get("dates") or []))
check("45m counts sane", all(c <= 3 for c in data.get("counts") or []),
      data.get("counts"))

# ------------------------------------------------------------------ errors
print("errors")
r = post(dict(clause=CLAUSE, interval="1d", universe=10, date="01-02-2024"))
check("bad date 400", r.status_code == 400 and "error" in (r.get_json() or {}),
      f"{r.status_code} {r.get_json()}")

r = post(dict(clause="[bogus(3)] > 1", interval="1d", universe=10))
check("bad clause 400", r.status_code == 400 and "error" in (r.get_json() or {}),
      f"{r.status_code} {r.get_json()}")

r = post(dict(clause="7 closed [close] > 0", interval="1d", universe=10))
check("bad offset 400", r.status_code == 400 and "error" in (r.get_json() or {}),
      f"{r.status_code} {r.get_json()}")

r = CLIENT.post("/api/backtest", data={"clause": "[close] > 0", "bars": "12"})
data = r.get_json() or {}
check("form encoded works", r.status_code == 200 and data.get("ok") is True
      and len(data.get("dates") or []) == 12, str(data)[:160])

r = post(None)
check("no payload 400", r.status_code == 400, r.status_code)

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("all backtest checks passed")
