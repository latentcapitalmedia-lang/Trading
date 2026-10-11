"""API test suite: python tests/test_api.py [base_url]"""

import csv
import io
import json
import os
import sys
import time

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5000"

FAILS = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name} {extra}")


def get(path, **kw):
    r = requests.get(BASE + path, timeout=120, **kw)
    return r


def post(path, **kw):
    r = requests.post(BASE + path, timeout=300, **kw)
    return r


def jload(r):
    """Body as JSON, or {} when the route answered with HTML (405, 500…)."""
    try:
        return r.json()
    except ValueError:
        return {}


def put(path, **kw):
    return requests.put(BASE + path, timeout=60, **kw)


def delete(path, **kw):
    return requests.delete(BASE + path, timeout=60, **kw)


print("static")
r = get("/")
check("GET / serves the app", r.ok and "chartink" in r.text.lower() and "<canvas" not in r.text)
for asset in ("/static/style.css", "/static/app.js", "/static/pages.js", "/static/chart.js"):
    r = get(asset)
    check(f"GET {asset}", r.ok and len(r.text) > 500, f"status={r.status_code} len={len(r.text)}")

print("metadata")
r = get("/api/health")
check("health", r.ok and r.json().get("ok") is True)

r = get("/api/fields")
cat = r.json()["fields"] if r.ok else []
total = sum(len(g["fields"]) for g in cat)
check("fields catalogue", r.ok and total >= 40, f"{total}")

r = get("/api/presets")
presets = r.json().get("presets", []) if r.ok else []
check("presets", r.ok and len(presets) >= 15, len(presets))

clause = "[rsi(14)] < 80 and ([volume_ratio(20)] > 0 or [close] > [sma(50)])"
r = get("/api/parse", params={"clause": clause})
check("parse", r.ok and r.json().get("ast", {}).get("t") == "and", r.text[:160])

r = get("/api/validate", params={"clause": clause})
check("validate", r.ok and "rsi(14)" in r.json().get("clause", ""), r.text[:160])

r = get("/api/validate", params={"clause": "[bogus(3)] > 1"})
check("validate rejects unknown field", r.status_code == 400 and "unknown field" in r.text, r.text[:160])

print("data")
r = get("/api/universe", params={"size": 40})
rows = r.json().get("rows", []) if r.ok else []
check("universe", r.ok and 10 <= len(rows) <= 40, len(rows))
sym = rows[0]["symbol"] if rows else "BTCUSDT"

r = get("/api/ticker", params={"symbols": "BTCUSDT,ETHUSDT"})
check("ticker", r.ok and "BTCUSDT" in r.json().get("rows", {}), r.text[:140])

r = get("/api/klines", params={"symbol": sym, "interval": "1d", "limit": 100})
k = r.json() if r.ok else {}
check("klines", r.ok and len(k.get("close", [])) >= 100, r.text[:140])

r = get(f"/api/chart/{sym}", params={"interval": "1h", "limit": 120})
check("chart payload", r.ok and len(r.json().get("close", [])) == 120 and "market_cap" in r.json())

r = get("/api/klines", params={"symbol": "NOSUCHPAIR"})
check("klines 404s on bad symbol", r.status_code in (400, 404, 502), r.status_code)

print("scanning")
small = dict(universe=25)
r = post("/api/scan", json=dict(clause="[close] > 0", **small))
job = r.json().get("job_id") if r.ok else None
check("start scan", r.ok and job, r.text[:160])

job_data = None
for _ in range(180):
    rr = get("/api/scan/" + str(job))
    job_data = rr.json()
    if job_data.get("status") in ("done", "error"):
        break
    time.sleep(0.4)
check("scan completes", job_data and job_data["status"] == "done", str(job_data)[:200])
check("scan has results", bool(job_data and job_data["results"]), "")
check("scan columns present", bool(job_data and job_data["columns"]), "")
check("scan has field metadata", bool(job_data and job_data.get("fields")), "")
if job_data and job_data["results"]:
    first = job_data["results"][0]
    check("row shape", all(k in first for k in ("symbol", "price", "values", "spark")), list(first))

r = get("/api/scan/deadbeef")
check("unknown job 404s", r.status_code == 404)

r = post("/api/scan/sync", json=dict(clause="[supertrend_dir(10,3)] > 0", universe=25))
check("sync scan", r.ok and "results" in r.json(), r.text[:160])

r = post("/api/scan", json=dict(clause="[bogus] > 1"))
check("bad clause 400", r.status_code == 400 and "error" in r.json(), r.text[:160])

print("chartink-compatible endpoint")
r = post("/screener/process", data={"scan_clause": "[rsi(14)] < 90", "universe": "25"})
j = r.json() if r.ok else {}
check("form encoded", r.ok and "results" in j and "clause" in j, r.text[:160])

r = post("/screener/process", json={"scan_clause": "[close] > 0", "universe": 25, "format": "json"})
check("json encoded", r.ok and "results" in r.json())

r = post("/screener/process", data={"scan_clause": "[close] > 0", "universe": "25", "format": "html"})
check("html format", r.ok and "cx-table" in r.text and "<tr>" in r.text, r.text[:140])

r = post("/screener/process", data={"scan_clause": "[close] > 0", "universe": "25", "format": "csv"})
check("csv format", r.ok and r.text.splitlines()[0].startswith("symbol,price"), r.text[:140])
parsed = list(csv.reader(io.StringIO(r.text)))
check("csv rows", len(parsed) > 1, len(parsed))

r = get("/screener/process", params={"scan_clause": "[rsi(14)] < 95", "universe": 25})
check("GET variant", r.ok and "results" in r.json())

r = post("/screener/process", data={"scan_clause": "( [rsi(14)] < 30", "universe": "25"})
check("bad clause 400", r.status_code == 400)

print("watchlist")
# data/watchlist.json is the user's real stars, not a test fixture — capture it
# up front and hand it back, or running the suite wipes someone's watchlist.
prior = get("/api/watchlist")
prior_symbols = jload(prior).get("symbols", []) if prior.ok else []
r = get("/api/watchlist")
check("watchlist GET", r.ok and "symbols" in r.json())
r = post("/api/watchlist", json={"symbols": ["BTCUSDT", "ETHUSDT"]})
check("watchlist POST", r.ok and r.json()["symbols"] == ["BTCUSDT", "ETHUSDT"])
r = post("/api/watchlist", json={"symbols": []})
check("watchlist cleared", r.ok and r.json()["symbols"] == [])
r = post("/api/watchlist", json={"symbols": prior_symbols})
check("watchlist restored", r.ok and r.json()["symbols"] == prior_symbols,
      r.text[:160])

print("watchlist groups")
r = get("/api/watchlist/groups")
grp = jload(r)
check("groups list", r.ok and len(grp.get("groups", [])) == 6, r.text[:200])
check("the six built-ins in order",
      [g["id"] for g in grp.get("groups", [])]
      == ["binance", "bybit", "kucoin", "bitget", "okx", "favourite"],
      [g["id"] for g in grp.get("groups", [])])
check("twelve columns in the schema", len(grp.get("columns", [])) == 12,
      len(grp.get("columns", [])))
check("custom cap reported", grp.get("max_custom") == 5, grp.get("max_custom"))
check("row limits offered", grp.get("limits") == [50, 100, 150, 250, 0],
      grp.get("limits"))

r = get("/api/watchlist/groups/binance?limit=5")
rows = jload(r).get("rows", [])
check("phase-0 rows for an exchange group",
      r.ok and 1 <= len(rows) <= 5, f"{r.status_code} n={len(rows)}")
if rows:
    check("every exchange-group row is halal",
          all(x.get("halal") for x in rows), rows[0])
    check("phase-0 keys are the column keys",
          {"symbol", "price", "volume_24h", "change_24h"} <= set(rows[0]),
          sorted(rows[0]))
    check("market cap rides phase 2, so the first paint never waits on CoinGecko",
          "market_cap" not in rows[0], sorted(rows[0]))
r = get("/api/watchlist/groups/nope")
check("unknown group 404s", r.status_code == 404, r.status_code)
r = delete("/api/watchlist/groups/nope")
check("unknown delete 404s", r.status_code == 404, r.status_code)
r = post("/api/watchlist/groups/nope/activate")
check("unknown activate 404s", r.status_code == 404, r.status_code)

r = post("/api/watchlist/groups",
         json={"name": "API test", "symbols": ["BTCUSDT", "ETHUSDT"]})
created = jload(r).get("group", {})
check("create a custom group", r.ok and created.get("name") == "API test",
      r.text[:200])
gid = created.get("id", "")

r = put("/api/watchlist/groups/" + gid,
        json={"name": "Renamed", "symbols": ["SOLUSDT"]})
check("rename and re-point a custom group",
      r.ok and jload(r)["group"]["name"] == "Renamed", r.text[:200])
r = post("/api/watchlist/groups/%s/activate" % gid)
check("activate a custom group",
      r.ok and jload(r).get("active") == gid, r.text[:160])
r = get("/api/watchlist/groups/%s" % gid)
check("a custom group resolves its own symbols",
      r.ok and [x["symbol"] for x in jload(r).get("rows", [])] == ["SOLUSDT"],
      r.text[:200])

# fill the five custom slots, then the sixth must be refused
made = [gid] if gid else []
while len(made) < 5:
    r = post("/api/watchlist/groups", json={"name": "filler", "symbols": ["BTCUSDT"]})
    if not r.ok:
        break
    made.append(jload(r)["group"]["id"])
check("five custom groups fit", len(made) == 5, len(made))
r = post("/api/watchlist/groups", json={"name": "over", "symbols": ["BTCUSDT"]})
check("the sixth custom group is refused",
      r.status_code == 400, (r.status_code, r.text[:160]))

for g in made:
    delete("/api/watchlist/groups/" + g)
r = get("/api/watchlist/groups")
check("custom groups cleaned up",
      jload(r).get("used_custom") == 0, jload(r).get("used_custom"))
check("active falls back to binance",
      jload(r).get("active") == "binance", jload(r).get("active"))

print("watchlist phase 2")
r = post("/api/watchlist/values", json={"symbols": ["BTCUSDT", "ETHUSDT"]})
job = jload(r)
check("start the compute job", r.ok and job.get("job_id"), r.text[:200])
check("id->key map re-keys the weekly macd",
      job.get("id_to_key", {}).get("macd_histogram(12,26,9)@closed weekly") == "macd_w",
      str(job.get("id_to_key"))[:240])
jid = job.get("job_id", "")
job_data = {}
for _ in range(90):
    time.sleep(1)
    r = get("/api/watchlist/values/" + jid)
    job_data = jload(r)
    if job_data.get("status") in ("done", "error"):
        break
check("the compute job finishes", job_data.get("status") == "done",
      str(job_data)[:240])
vals = job_data.get("values", {})
check("every symbol got the eight computed columns",
      bool(vals) and all(len(v) == 8 for v in vals.values()),
      str(vals)[:300])
check("weekly and daily macd differ",
      all(v["macd_histogram(12,26,9)@closed weekly"] != v["macd_histogram(12,26,9)"]
          for v in vals.values() if "macd_histogram(12,26,9)@closed weekly" in v),
      str(vals)[:300])
r = get("/api/watchlist/values/deadbeef")
check("unknown compute job 404s", r.status_code == 404, r.status_code)
r = post("/api/watchlist/values", json={"symbols": ["BTCUSDT"], "columns": ["nonsense"]})
check("an unknown column 400s the job up front",
      r.status_code == 400, (r.status_code, r.text[:160]))

print("settings")
r = get("/api/settings")
s = r.json() if r.ok else {}
check("settings GET", r.ok and "telegram_chat_id" in s and "telegram_token" in s)
r = post("/api/settings", json={"cadence_seconds": 240, "universe": 120, "telegram_token": ""})
s2 = r.json()
check("settings POST", r.ok and s2["cadence_seconds"] == 240 and s2["universe"] == 120, s2)
check("empty token not stored", s2["telegram_token"] == "", repr(s2["telegram_token"]))

print("alerts")
r = get("/api/alerts")
check("alerts GET", r.ok and "alerts" in r.json() and "status" in r.json())

created = []
for i in range(2):
    r = post("/api/alerts", json={
        "name": f"api test {i}",
        "clause": "[close] > 0",
        "interval": "1d",
        "universe": 20,
    })
    check(f"create alert {i}", r.ok and "id" in r.json(), r.text[:160])
    if r.ok:
        created.append(r.json()["id"])

if created:
    aid = created[0]
    r = requests.put(BASE + f"/api/alerts/{aid}", json={"enabled": False, "name": "renamed"}, timeout=30)
    check("update alert", r.ok and r.json().get("enabled") is False and r.json().get("name") == "renamed")

    r = requests.put(BASE + "/api/alerts/nope", json={"enabled": True}, timeout=30)
    check("update unknown 404", r.status_code == 404)

    r = post("/api/alerts/run")
    check("run alerts now", r.ok and "checked" in r.json(), r.text[:160])

    r = requests.delete(BASE + f"/api/alerts/{aid}", timeout=30)
    check("delete alert", r.ok)

    r = requests.delete(BASE + "/api/alerts/nope", timeout=30)
    check("delete unknown 404", r.status_code == 404)

# leave exactly one alert behind for the UI to show, then remove it
for cid in created[1:]:
    requests.delete(BASE + f"/api/alerts/{cid}", timeout=30)

r = post("/api/alerts", json={"clause": "", "name": "x"})
check("alert needs clause", r.status_code == 400, r.status_code)

r = get("/api/alerts/pending")
check("pending feed", r.ok and "items" in r.json())

r = post("/api/alerts/pending/clear")
check("clear pending", r.ok)

r = post("/api/settings/test-telegram")
check("telegram test responds", r.ok and ("ok" in r.json()), r.text[:160])

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("all API checks passed")
