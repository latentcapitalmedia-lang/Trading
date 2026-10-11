"""Quick engine self-test: python tests/test_engine.py"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import indicators as ta
from engine import halal, watchlist
from engine.expressions import ClauseError, parse, pretty, collect_fields
from engine.fields import FIELDS, resolve, describe
from engine.scanner import build_plan, _prepare, evaluate, _column_specs, _normalise

FAILS = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name} {extra}")


def same(a, b, tol=1e-9):
    """Element compare that tolerates the None warm-up slots."""
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < tol


# ---------------------------------------------------------------- indicators
print("indicators")
src = [float(i) for i in range(1, 61)]
s = ta.sma(src, 5)
check("sma warm-up", s[3] is None and abs(s[4] - 3.0) < 1e-9)
check("sma shift", abs(s[5] - 4.0) < 1e-9)

e = ta.ema(src, 5)
check("ema seed", e[4] is not None and abs(e[4] - 3.0) < 1e-9)

up = [100 + i * 0.5 for i in range(60)]
r = ta.rsi(up, 14)
check("rsi all-up ~100", r[-1] is not None and r[-1] > 95, r[-1])

flat = [100.0] * 60
rf = ta.rsi(flat, 14)
check("rsi flat = 100 (no losses)", rf[-1] == 100.0, rf[-1])

line, sig, hist = ta.macd(src)
check("macd aligned", len(line) == len(src) and line[-1] is not None)

h = [v + 1 for v in src]
l = [v - 1 for v in src]
a = ta.atr(h, l, src, 14)
check("atr flat range = 2", a[-1] is not None and abs(a[-1] - 2.0) < 1e-6, a[-1])

adx, pdi, mdi = ta.adx(h, l, src, 14)
check("adx defined", adx[-1] is not None, adx[-1])

st, sd = ta.supertrend(h, l, src, 10, 3.0)
check("supertrend direction", all(d in (1, -1) for d in sd if d is not None))

b, upb, lob = ta.bollinger(src, 20, 2.0)
check("bollinger ordering", b[-1] < upb[-1] and lob[-1] < b[-1])

k, d = ta.stochastic(h, l, src)
check("stochastic in range", 0 <= k[-1] <= 100, k[-1])

m = ta.mfi(h, l, src, [1000.0] * 60, 14)
check("mfi in range", m[-1] is not None and 0 <= m[-1] <= 100, m[-1])

# ------------------------------------------------------------------ parser
print("parser")
cases = [
    "[rsi(14)] < 30",
    "[volume] > 1000000 and [rsi(14)] < 30",
    "([close] > [sma(50)] or [close] > [ema(50)]) and [adx(14)] > 25",
    "[sma(20)] crossed above [sma(50)]",
    "[volume] > 1000000 and [volume_ratio(20)] > 2",
    "not [market_cap] < 1000000",
    "rsi(14) < 30 and volume > 5e6",
    "[macd_line(12,26,9)] crossed above [macd_signal(12,26,9)]",
    "[supertrend_dir(10,3)] > 0",
    "[close] >= [high_52w(365)] and [change_pct] > 3",
    "[bollinger_pct_b(20,2)] < 5 or [stoch_k(14)] < 20",
    "[rsi(14)]",
]
for case in cases:
    try:
        ast = parse(case)
        fields = collect_fields(ast)
        plan = build_plan(case)
        _prepare(plan["ast"], plan)
        check(f"parse: {case}", bool(plan["clause"]), plan["clause"])
    except Exception as exc:  # noqa: BLE001
        check(f"parse: {case}", False, f"{type(exc).__name__}: {exc}")

bad = ["", "[rsi(14)] ~ 3", "[nosuchfield] > 1", "[rsi(14,2,3,4)] > 1", "( [rsi(14)] < 30"]
for case in bad:
    try:
        build_plan(case)
        check(f"reject: {case!r}", False, "should have raised")
    except ClauseError as exc:
        check(f"reject: {case!r}", True, exc.message)

# round-trip: pretty-printed clause must re-parse to the same thing
for case in cases:
    plan1 = build_plan(case)
    plan2 = build_plan(plan1["clause"])
    check(f"round-trip: {case}", plan1["clause"] == plan2["clause"],
          f"{plan1['clause']} != {plan2['clause']}")

# ---------------------------------------------------------- candle offsets
print("offsets")
# the default offset (closed daily) must be omitted from the node entirely
default_ast = parse("[close] > 100")
check("default offset omitted", "offset" not in default_ast["left"],
      default_ast["left"])
check("plain clause has no offset anywhere", "offset" not in repr(default_ast),
      repr(default_ast))

offset_cases = [
    # clause text, expected offset dict (None = default, key must be absent)
    ("current 4h [close] > 100", {"state": "current", "tf": "4h"}),
    ("closed 15m [rsi(14)] < 30", {"state": "closed", "tf": "15m"}),
    ("2nd closed weekly [volume] > 1000", {"state": "2nd closed", "tf": "1w"}),
    ("3rd closed yearly [market_cap] < 1000000", {"state": "3rd closed", "tf": "1y"}),
    ("2nd closed [close] > 0", {"state": "2nd closed", "tf": "1d"}),
    ("3rd closed [close] > 0", {"state": "3rd closed", "tf": "1d"}),
    ("current [close] > 0", {"state": "current", "tf": "1d"}),
    ("closed 45m [close] > 0", {"state": "closed", "tf": "45m"}),
    ("2nd closed 4h [close] > 0", {"state": "2nd closed", "tf": "4h"}),
    # ordinals / unit synonyms / bare numbers
    ("2 closed [close] > 0", {"state": "2nd closed", "tf": "1d"}),
    ("3 closed [close] > 0", {"state": "3rd closed", "tf": "1d"}),
    ("1st closed [close] > 0", None),          # 1st closed == closed == default
    ("closed 15 minutes [rsi(14)] < 30", {"state": "closed", "tf": "15m"}),
    ("current 4 hours [close] > 100", {"state": "current", "tf": "4h"}),
    ("closed 30 min [close] > 0", {"state": "closed", "tf": "30m"}),
    ("current 1 hr [close] > 0", {"state": "current", "tf": "1h"}),
    # daily/weekly/monthly/yearly keywords, state omitted -> closed
    ("weekly [close] > 0", {"state": "closed", "tf": "1w"}),
    ("monthly [volume] > 0", {"state": "closed", "tf": "1M"}),
    ("yearly [close] > 0", {"state": "closed", "tf": "1y"}),
    ("daily [close] > 0", None),               # daily closed is the default
    ("closed [close] > 0", None),
    # canonical timeframe ids are accepted as well as their keywords
    ("current 1w [close] > 0", {"state": "current", "tf": "1w"}),
    ("closed 1M [volume] > 0", {"state": "closed", "tf": "1M"}),
    ("current 1y [close] > 0", {"state": "current", "tf": "1y"}),
    ("closed 1d [close] > 0", None),           # closed daily is the default
    ("1d [close] > 0", None),
]
for text, expected in offset_cases:
    try:
        ast = parse(text)
        got = ast["left"].get("offset")
        check(f"offset parse: {text}", got == expected, f"{got} != {expected}")
        check(f"offset round-trip: {text}", parse(pretty(ast)) == ast,
              f"{pretty(ast)} -> {parse(pretty(ast))}")
    except Exception as exc:  # noqa: BLE001
        check(f"offset parse: {text}", False, f"{type(exc).__name__}: {exc}")

# ordinary numeric operands must never be mistaken for an offset prefix
plain = parse("[rsi(14)] < 30 and volume > 5e6")
check("number operand untouched", plain["kids"][0]["right"]["v"] == 30.0)
check("bare field untouched", plain["kids"][1]["left"]["field"] == "volume")

bad_offsets = [
    "7 closed [close] > 0",
    "4th closed [close] > 0",
    "2.5 closed [close] > 0",
    "9m [close] > 0",
    "1m [close] > 0",
    "6h [close] > 0",
]
for text in bad_offsets:
    try:
        parse(text)
        check(f"reject offset: {text!r}", False, "should have raised")
    except ClauseError as exc:
        check(f"reject offset: {text!r}", True, exc.message)

# ids / labels / tf+state keys on the normalised plan
plan = build_plan(
    "current 4h [rsi(14)] > 50 and 2nd closed weekly [volume] > 1000 "
    "and [close] > 100"
)
by_id = {f["id"]: f for f in plan["fields"]}
check("id default unchanged", "close" in by_id, list(by_id))
check("id offset current4h", "rsi(14)@current4h" in by_id, list(by_id))
check("id offset 2nd closed weekly", "volume@2nd closed weekly" in by_id, list(by_id))
check("spec tf/state", by_id.get("rsi(14)@current4h", {}).get("tf") == "4h"
      and by_id.get("rsi(14)@current4h", {}).get("state") == "current",
      by_id.get("rsi(14)@current4h"))
check("label suffix current 4h",
      by_id.get("rsi(14)@current4h", {}).get("label") == "RSI · current 4h",
      by_id.get("rsi(14)@current4h", {}).get("label"))
check("label suffix 2nd closed weekly",
      by_id.get("volume@2nd closed weekly", {}).get("label")
      == "Volume (bars) · 2nd closed weekly",
      by_id.get("volume@2nd closed weekly", {}).get("label"))
check("default label unchanged", by_id.get("close", {}).get("label") == "Price",
      by_id.get("close", {}).get("label"))
# default offset specs must report the plan's base interval as their tf
plan_4h = build_plan("[rsi(14)] < 80", interval="4h")
check("default tf follows plan interval",
      [f["tf"] for f in plan_4h["fields"]] == ["4h"]
      and [f["id"] for f in plan_4h["fields"]] == ["rsi(14)"],
      plan_4h["fields"])

# collect_fields works before any plan exists: ids + tf/state keys
raw_specs = {f["id"]: f for f in collect_fields(parse(
    "current 4h [rsi(14)] > 50 and 2nd closed weekly [volume] > 1000 "
    "and closed 45m [close] > 0 and [close] > 1"))}
check("collect_fields ids",
      all(k in raw_specs for k in ("rsi(14)@current4h", "volume@2nd closed weekly",
                                   "close@closed45m", "close")),
      list(raw_specs))
check("collect_fields tf/state keys",
      raw_specs.get("rsi(14)@current4h", {}).get("tf") == "4h"
      and raw_specs.get("rsi(14)@current4h", {}).get("state") == "current"
      and raw_specs.get("volume@2nd closed weekly", {}).get("tf") == "1w"
      and raw_specs.get("close@closed45m", {}).get("tf") == "45m",
      raw_specs)

# ------------------------------------------------------------------- fields
print("fields")
check("registry populated", len(FIELDS) >= 35, len(FIELDS))
check("describe() is JSON-safe", len(describe()) == 6, len(describe()))

ctx = {
    "open": src, "high": h, "low": l, "close": src,
    "volume": [1000.0] * len(src),
    "fund": {"market_cap": 5e9, "market_cap_rank": 12, "quote_volume_24h": 2e8},
}
for key, item in FIELDS.items():
    spec = {"field": key, "params": [p["default"] for p in item["params"]],
            "cache_key": key}
    try:
        values = resolve(spec, ctx, {})
        ok = isinstance(values, list) and len(values) == len(src)
        check(f"compute {key}", ok)
    except Exception as exc:  # noqa: BLE001
        check(f"compute {key}", False, f"{type(exc).__name__}: {exc}")

# ---------------------------------------------------------------- evaluation
print("evaluation")
plan = build_plan("[rsi(14)] < 30 and [close] > 0")
_prepare(plan["ast"], plan)
cache = {}
# build a series that ends oversold
falling = [100 - i * 0.6 for i in range(60)]
ctx2 = dict(ctx, close=falling, open=falling, high=[v + 1 for v in falling],
            low=[v - 1 for v in falling])
check("oversold matches", evaluate(plan["ast"], plan, ctx2, {}, len(falling) - 1))

plan3 = build_plan("[sma(20)] crossed above [sma(50)]")
_prepare(plan3["ast"], plan3)
# a cross needs the short average to move from below to above the long one,
# so use a steady decline followed by an outsized up-bar
fall = [80 - i for i in range(80)]
spiky = fall[:]
spiky[-1] = spiky[-2] + 600
ctx3 = dict(ctx, close=spiky, open=spiky, high=[v + 1 for v in spiky],
            low=[v - 1 for v in spiky])
check("cross detects", evaluate(plan3["ast"], plan3, ctx3, {}, len(spiky) - 1))
check("cross not early", not evaluate(plan3["ast"], plan3, ctx3, {}, len(spiky) - 2))

# ------------------------------------------------- per-candle-offset reads
print("offset evaluation")
# one synthetic series whose last bar is still running: every candle state
# must land on its own bar (idx 4 is the last closed bar, 5 is the current one)
synthetic = {
    "open": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
    "high": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
    "low": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
    "close": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
    "volume": [1000.0] * 6,
    "closed": [True, True, True, True, True, False],
    "fund": {"market_cap": 5e9, "market_cap_rank": 12, "quote_volume_24h": 2e8},
}
offset_evals = [
    ("closed [close] = 50", True),      # last closed bar (idx 4)
    ("closed [close] = 60", False),     # 60 is the running bar, not closed
    ("2nd closed [close] = 40", True),  # one bar further back (idx 3)
    ("2nd closed [close] = 50", False),
    ("3rd closed [close] = 30", True),  # two bars back (idx 2)
    ("3rd closed [close] = 50", False),
    ("current [close] = 60", True),     # running bar (idx 5)
    ("current [close] = 50", False),
]
for text, expected in offset_evals:
    plan = build_plan(text)
    _prepare(plan["ast"], plan)
    got = evaluate(plan["ast"], plan, synthetic, {}, 4)
    check(f"eval {text}", got == expected, f"{got} != {expected}")

# a 2nd closed field and a closed field in the SAME clause read different bars
mixed = build_plan(
    "2nd closed [close] = 40 and closed [close] = 50 and current [close] = 60"
)
_prepare(mixed["ast"], mixed)
check("mixed offsets read different bars",
      evaluate(mixed["ast"], mixed, synthetic, {}, 4))
mixed_neg = build_plan("2nd closed [close] = 50 and closed [close] = 50")
_prepare(mixed_neg["ast"], mixed_neg)
check("mixed offsets do not collide",
      not evaluate(mixed_neg["ast"], mixed_neg, synthetic, {}, 4))

# ------------------------------------------------- watchlist-scoped columns
print("watchlist columns")

# TradingView's screener definitions, wired exactly as their support article
# writes them: Volatility.D = tr(true)*100/|low|, Volatility.W = the mean of
# (high-low)/|low|*100 over the window (7 daily bars = one week).
vol_ctx = {
    "open": [100.0, 101.0, 102.0, 103.0],
    "high": [103.0, 104.0, 105.0, 106.0],
    "low": [99.0, 100.0, 101.0, 102.0],
    "close": [101.0, 102.0, 103.0, 104.0],
    "volume": [10.0] * 4,
    "quote_volume": [1000.0, 2000.0, 3000.0, 4000.0],
    "fund": {},
}


def field(name, params, context):
    return resolve({"field": name, "params": params, "cache_key": name},
                   context, {})


for key, fmt in (("volatility_d", "num2"), ("volatility_w", "num2"),
                 ("volume_7d", "usd")):
    check(f"{key} registered as {fmt}",
          key in FIELDS and FIELDS[key].get("fmt") == fmt,
          FIELDS.get(key, {}).get("fmt"))

tr = ta.true_range(vol_ctx["high"], vol_ctx["low"], vol_ctx["close"])
expect_d = [None if (tr[i] is None or not vol_ctx["low"][i])
            else tr[i] / abs(vol_ctx["low"][i]) * 100.0
            for i in range(len(tr))]
check("volatility_d = tr(true) / |low| * 100",
      all(same(a, b) for a, b in zip(field("volatility_d", [], vol_ctx), expect_d)),
      field("volatility_d", [], vol_ctx))

rng = [(vol_ctx["high"][i] - vol_ctx["low"][i]) / abs(vol_ctx["low"][i]) * 100.0
       for i in range(4)]
expect_w = [None, None, sum(rng[0:3]) / 3.0, sum(rng[1:4]) / 3.0]
check("volatility_w = mean range over the window",
      all(same(a, b) for a, b in zip(field("volatility_w", [3], vol_ctx), expect_w)),
      field("volatility_w", [3], vol_ctx))

v7 = field("volume_7d", [3], vol_ctx)
check("volume_7d sums the quote-volume window",
      v7[0] is None and v7[1] is None and same(v7[2], 6000.0)
      and same(v7[3], 9000.0), v7)

no_quote = {k: v for k, v in vol_ctx.items() if k != "quote_volume"}
v7b = field("volume_7d", [3], no_quote)
expect_v = sum(vol_ctx["volume"][i] * vol_ctx["close"][i] for i in range(3))
check("volume_7d falls back to volume*close, still in USD",
      same(v7b[2], expect_v), (v7b[2], expect_v))


def specs_for(token, interval="1d"):
    return _normalise(_column_specs([token]), interval=interval)


# The parser only honours a timeframe written OUTSIDE the brackets, so a weekly
# column has to hoist the leading words out — otherwise "weekly macd" silently
# computes a daily histogram and the watchlist's two MACD columns collapse.
wk = specs_for("closed weekly macd_histogram(12,26,9)")
dy = specs_for("macd_histogram(12,26,9)")
check("weekly macd hoists to the weekly timeframe",
      bool(wk) and wk[0]["tf"] == "1w", wk)
check("weekly macd reads closed bars", bool(wk) and wk[0]["state"] == "closed", wk)
check("bare macd still reads the daily timeframe",
      bool(dy) and dy[0]["tf"] == "1d", dy)
check("weekly and daily macd are separate columns",
      bool(wk) and bool(dy) and wk[0]["id"] != dy[0]["id"],
      (wk and wk[0]["id"], dy and dy[0]["id"]))
check("a bare 1w prefix works too",
      specs_for("1w macd_histogram")[0]["tf"] == "1w")
try:
    specs_for("weekly nonsense")
    check("hoist still rejects unknown fields", False)
except ClauseError:
    check("hoist still rejects unknown fields", True)

# ------------------------------------------------------------------ halal
print("halal source")
assessed = halal.judge("BTC")
check("assessed coin keeps its platform verdict",
      assessed["source"] == "platform" and assessed["assessed"] > 0, assessed)
check("BTC still passes", assessed["halal"] is True, assessed)

fresh = halal.judge("BRANDNEWTOKENXYZ")
check("un-assessed coin takes the auto path",
      fresh["source"] == "auto" and fresh["assessed"] == 0, fresh)
check("plain un-assessed token passes", fresh["halal"] is True, fresh["reason"])

check("auto rejects a pegged instrument",
      halal._auto_screen("USDC") == (False, "pegged"),
      halal._auto_screen("USDC"))
check("auto rejects a leveraged token",
      halal._auto_screen("BTC3L") == (False, "leveraged"),
      halal._auto_screen("BTC3L"))
check("auto rejects a yield receipt",
      halal._auto_screen("WBTC") == (False, "yield receipt"),
      halal._auto_screen("WBTC"))
check("auto accepts a new plain token",
      halal._auto_screen("BRANDNEWTOKENXYZ") == (True, "auto"),
      halal._auto_screen("BRANDNEWTOKENXYZ"))
check("auto-screen is on in the shipped rule", halal.auto_screen_enabled())

annotated = [{"base": "BTC", "symbol": "BTCUSDT"},
             {"base": "BRANDNEWTOKENXYZ", "symbol": "XYZUSDT"}]
halal.annotate(annotated)
check("annotate records the source for both paths",
      annotated[0]["halal_source"] == "platform"
      and annotated[1]["halal_source"] == "auto", annotated)

summary = halal.summary()
check("summary reports the auto-screen",
      "auto_screen" in summary and "platform_verdicts" in summary, summary)

# ------------------------------------------------------------ group schema
print("watchlist groups")
check("twelve columns", len(watchlist.COLUMNS) == 12, len(watchlist.COLUMNS))
check("column order is the documented one",
      [c["key"] for c in watchlist.COLUMNS] == [
          "symbol", "price", "volume_24h", "volume_7d", "change_24h",
          "change_7d", "macd_w", "macd_d", "rsi", "market_cap",
          "volatility_w", "volatility_d"],
      [c["key"] for c in watchlist.COLUMNS])

phase0 = [c for c in watchlist.COLUMNS if c["phase"] == 0]
phase2 = [c for c in watchlist.COLUMNS if c["phase"] == 2]
check("phase split covers every column once",
      len(phase0) + len(phase2) == 12 and not (len(phase2) % 1),
      (len(phase0), len(phase2)))
check("phase-2 columns line up with COMPUTE_COLUMNS",
      len(phase2) == len(watchlist.COMPUTE_COLUMNS),
      (len(phase2), len(watchlist.COMPUTE_COLUMNS)))
# everything that reads candle history has to be phase 2
candle_keys = {"volume_7d", "change_7d", "macd_w", "macd_d", "rsi",
               "volatility_w", "volatility_d", "market_cap"}
check("candle-derived columns are deferred to the job",
      {c["key"] for c in phase2} == candle_keys,
      sorted(c["key"] for c in phase2))

tokens, id2key, fields = watchlist.compute_fields()
check("compute_fields re-keys every phase-2 column",
      sorted(id2key.values()) == sorted(c["key"] for c in phase2), id2key)
check("weekly macd maps to macd_w",
      id2key.get("macd_histogram(12,26,9)@closed weekly") == "macd_w", id2key)
check("daily macd maps to macd_d",
      id2key.get("macd_histogram(12,26,9)") == "macd_d", id2key)
check("market cap rides the same job", id2key.get("market_cap") == "market_cap")

check("missing limit falls back to the default",
      watchlist._limit(None) == watchlist.DEFAULT_LIMIT, watchlist._limit(None))
check("an explicit all is unlimited", watchlist._limit("all") == 0)
check("a numeric limit is honoured", watchlist._limit("250") == 250)
check("nonsense limit falls back to the default",
      watchlist._limit("soon") == watchlist.DEFAULT_LIMIT)
check("five custom groups max", watchlist.MAX_CUSTOM == 5, watchlist.MAX_CUSTOM)
check("six built-in groups",
      [g[0] for g in watchlist.BUILTIN] == ["binance", "bybit", "kucoin",
                                            "bitget", "okx", "favourite"],
      [g[0] for g in watchlist.BUILTIN])

print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {FAILS}")
    sys.exit(1)
print("all checks passed")
