"""Live test against Binance: python tests/test_live.py [universe_size]"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import exchange
from engine.scanner import build_plan, run_scan

size = int(sys.argv[1]) if len(sys.argv) > 1 else 15

t = time.time()
rows = exchange.universe(size=size)
print(f"universe: {len(rows)} symbols in {time.time() - t:.2f}s")
for r in rows[:5]:
    print(f"   {r['symbol']:14} ${r['price']:>14,.6g}  {r['change_pct']:+.2f}%  vol ${r['quote_volume']:,.0f}")

t = time.time()
fund = exchange.fundamentals()
print(f"fundamentals: {len(fund)} coins in {time.time() - t:.2f}s")

tests = [
    "[rsi(14)] < 70",
    "[change_pct] > -100 and [close] > 0",
    "[volume_ratio(20)] > 0 and [price_vs_sma(50)] > -1000",
    "[supertrend_dir(10,3)] > 0",
    "[macd_histogram(12,26,9)] > 0",
    "[close] >= [high_52w(365)]",
    "[sma(20)] crossed above [sma(50)]",
    "[adx(14)] > 25 and [rsi(14)] > 50",
    "[bollinger_pct_b(20,2)] < 100",
    "[quote_volume_24h] > 1000000 and [market_cap] > 0",
]

failures = 0
for clause in tests:
    t = time.time()
    try:
        plan = build_plan(clause, interval="1d", limit=400)
        out = run_scan(plan, universe_rows=rows)
    except Exception as exc:  # noqa: BLE001
        failures += 1
        print(f"  ERROR {clause}\n        {type(exc).__name__}: {exc}")
        continue
    elapsed = time.time() - t
    errs = out["error_count"]
    status = "ok " if errs == 0 else f"WARN({errs} errors)"
    if errs:
        failures += 1
    print(f"  {status} {clause:<55} -> {out['matched']:>3}/{out['scanned']}  {elapsed:.2f}s"
          + (f"  ({out['skipped']} too new)" if out.get("skipped") else ""))
    if errs and out["errors"]:
        print(f"        first error: {out['errors'][0]}")
    first = out["results"][0] if out["results"] else None
    if first:
        print(f"        e.g. {first['symbol']} @ {first['price']:,.6g} values={first['values']}")

print()
if failures:
    print(f"{failures} test(s) had problems")
    sys.exit(1)
print("live scan OK")
