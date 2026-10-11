"""Registry of every field that can be used inside a scan condition.

A field is a named series computed from OHLCV data (plus optional
fundamental data). Conditions in a clause reference fields by name, e.g.
``[rsi(14)] < 30`` or ``[sma(20)] crossed above [sma(50)]``.
"""

from __future__ import annotations

from . import indicators as ta


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _pct_change(series, n):
    out = [None] * len(series)
    n = int(n)
    for i in range(n, len(series)):
        prev = series[i - n]
        out[i] = (series[i] / prev - 1.0) * 100.0 if prev else None
    return out


def _last(value, length):
    if value is None:
        return [None] * length
    return [value] * length


def _rolling_sum(values, n):
    """Sum over a window of the previous ``n`` bars (None until it is full)."""
    n = max(1, int(n))
    out = [None] * len(values)
    for i in range(n - 1, len(values)):
        window = values[i - n + 1:i + 1]
        if any(v is None for v in window):
            continue
        out[i] = float(sum(window))
    return out


def _rolling_mean(values, n):
    n = max(1, int(n))
    return [None if v is None else v / n for v in _rolling_sum(values, n)]


def _quote_value(c):
    """Traded value per bar, in USD, from whichever series the context has."""
    qv = c.get("quote_volume")
    if qv:
        return qv
    # base volume x close keeps the unit as USD even on a bare context
    return [None if (v is None or px is None) else v * px
            for v, px in zip(c["volume"], c["close"])]


def _tv_volatility_d(c, p):
    """TradingView screener's Volatility.D: ``tr(true) * 100 / abs(low)``."""
    high, low, close = c["high"], c["low"], c["close"]
    if not close:
        return []
    tr = ta.true_range(high, low, close)
    out = [None] * len(close)
    for i in range(len(close)):
        base = low[i]
        if not base or tr[i] is None:
            continue
        out[i] = tr[i] / abs(base) * 100.0
    return out


def _tv_volatility_w(c, p):
    """TradingView screener's Volatility.W.

    Their formula is ``sum((high-low)/abs(low) * 100 / bars, bars)`` over the
    bars elapsed since a week ago — i.e. the mean daily range as a percentage
    of the low, so 7 bars on a daily chart is one week.
    """
    high, low = c["high"], c["low"]
    bars = p[0] if p else 7
    rng = [None if (not low[i] or high[i] is None)
           else (high[i] - low[i]) / abs(low[i]) * 100.0
           for i in range(len(low))]
    return _rolling_mean(rng, bars)


def _scalar(field_name, ctx, length, cast=float):
    fund = ctx.get("fund") or {}
    raw = fund.get(field_name)
    if raw is None:
        return [None] * length
    try:
        return _last(cast(raw), length)
    except (TypeError, ValueError):
        return [None] * length


# --------------------------------------------------------------------------
# definitions
# --------------------------------------------------------------------------

def _f(key, label, cat, fmt, compute, params=None, desc=""):
    return {
        "key": key,
        "label": label,
        "cat": cat,
        "fmt": fmt,
        "params": params or [],
        "desc": desc,
        "_compute": compute,
    }


FIELDS = {}


def _add(*args, **kwargs):
    item = _f(*args, **kwargs)
    FIELDS[item["key"]] = item


# --- Price ---------------------------------------------------------------

_add("close", "Price", "Price", "price",
     lambda c, p: c["close"], desc="Last traded / closing price")
_add("open", "Open", "Price", "price", lambda c, p: c["open"])
_add("high", "High", "Price", "price", lambda c, p: c["high"])
_add("low", "Low", "Price", "price", lambda c, p: c["low"])

_add("change_pct", "Change % (1 bar)", "Price", "num2",
     lambda c, p: _pct_change(c["close"], 1),
     desc="Percent move of the last closed bar")
_add("roc", "Change % (n bars)", "Price", "num2",
     lambda c, p: _pct_change(c["close"], p[0]),
     params=[{"name": "bars", "default": 20, "min": 1, "max": 500}])

_add("high_52w", "52-week high (prior bars)", "Price", "price",
     lambda c, p: _hi(c["high"], p[0]),
     params=[{"name": "bars", "default": 365, "min": 5, "max": 1000}],
     desc="Highest high of the previous n bars, excluding the current one")
_add("low_52w", "52-week low (prior bars)", "Price", "price",
     lambda c, p: _lo(c["low"], p[0]),
     params=[{"name": "bars", "default": 365, "min": 5, "max": 1000}])
_add("pct_from_high_52w", "% from 52w high", "Price", "num2",
     lambda c, p: _pct_from(c["close"], _hi(c["high"], p[0])),
     params=[{"name": "bars", "default": 365, "min": 5, "max": 1000}])
_add("pct_from_low_52w", "% from 52w low", "Price", "num2",
     lambda c, p: _pct_from(c["close"], _lo(c["low"], p[0])),
     params=[{"name": "bars", "default": 365, "min": 5, "max": 1000}])
_add("range_pos", "% position in n-bar range", "Price", "num2",
     lambda c, p: _range_pos(c, p[0]),
     params=[{"name": "bars", "default": 100, "min": 2, "max": 1000}])


def _hi(values, n):
    """Highest of the ``n`` bars *before* the current one (breakout semantics)."""
    n = int(n)
    out = [None] * len(values)
    for i in range(n, len(values)):
        out[i] = max(values[i - n: i])
    return out


def _lo(values, n):
    """Lowest of the ``n`` bars *before* the current one."""
    n = int(n)
    out = [None] * len(values)
    for i in range(n, len(values)):
        out[i] = min(values[i - n: i])
    return out


def _pct_from(close, target):
    out = [None] * len(close)
    for i, t in enumerate(target):
        if t:
            out[i] = (close[i] / t - 1.0) * 100.0
    return out


def _range_pos(c, n):
    n = int(n)
    out = [None] * len(c["close"])
    for i in range(n - 1, len(c["close"])):
        hh = max(c["high"][i - n + 1: i + 1])
        ll = min(c["low"][i - n + 1: i + 1])
        out[i] = 100.0 * (c["close"][i] - ll) / (hh - ll) if hh != ll else 50.0
    return out


# --- Trend --------------------------------------------------------------

_add("sma", "Simple moving average", "Trend", "price",
     lambda c, p: ta.sma(c["close"], p[0]),
     params=[{"name": "period", "default": 20, "min": 2, "max": 500}])
_add("ema", "Exponential moving average", "Trend", "price",
     lambda c, p: ta.ema(c["close"], p[0]),
     params=[{"name": "period", "default": 20, "min": 2, "max": 500}])
_add("price_vs_sma", "Price vs SMA %", "Trend", "num2",
     lambda c, p: _vs(c["close"], ta.sma(c["close"], p[0])),
     params=[{"name": "period", "default": 50, "min": 2, "max": 500}],
     desc="Positive = price above the average")
_add("price_vs_ema", "Price vs EMA %", "Trend", "num2",
     lambda c, p: _vs(c["close"], ta.ema(c["close"], p[0])),
     params=[{"name": "period", "default": 50, "min": 2, "max": 500}])
_add("supertrend", "Supertrend line", "Trend", "price",
     lambda c, p: ta.supertrend(c["high"], c["low"], c["close"], p[0], p[1])[0],
     params=[{"name": "period", "default": 10, "min": 2, "max": 100},
             {"name": "mult", "default": 3, "min": 0.5, "max": 10}])
_add("supertrend_dir", "Supertrend direction", "Trend", "int",
     lambda c, p: ta.supertrend(c["high"], c["low"], c["close"], p[0], p[1])[1],
     params=[{"name": "period", "default": 10, "min": 2, "max": 100},
             {"name": "mult", "default": 3, "min": 0.5, "max": 10}],
     desc="1 = uptrend, -1 = downtrend")
_add("adx", "ADX", "Trend", "num2",
     lambda c, p: ta.adx(c["high"], c["low"], c["close"], p[0])[0],
     params=[{"name": "period", "default": 14, "min": 2, "max": 100}])
_add("di_plus", "+DI", "Trend", "num2",
     lambda c, p: ta.adx(c["high"], c["low"], c["close"], p[0])[1],
     params=[{"name": "period", "default": 14, "min": 2, "max": 100}])
_add("di_minus", "-DI", "Trend", "num2",
     lambda c, p: ta.adx(c["high"], c["low"], c["close"], p[0])[2],
     params=[{"name": "period", "default": 14, "min": 2, "max": 100}])
_add("high_n", "n-bar high (prior bars)", "Trend", "price",
     lambda c, p: _hi(c["high"], p[0]),
     params=[{"name": "bars", "default": 20, "min": 2, "max": 500}])
_add("low_n", "n-bar low (prior bars)", "Trend", "price",
     lambda c, p: _lo(c["low"], p[0]),
     params=[{"name": "bars", "default": 20, "min": 2, "max": 500}])


def _vs(close, ma):
    out = [None] * len(close)
    for i, m in enumerate(ma):
        if m:
            out[i] = (close[i] / m - 1.0) * 100.0
    return out


# --- Momentum -----------------------------------------------------------

_add("rsi", "RSI", "Momentum", "num2",
     lambda c, p: ta.rsi(c["close"], p[0]),
     params=[{"name": "period", "default": 14, "min": 2, "max": 100}])
_add("macd_line", "MACD line", "Momentum", "num4",
     lambda c, p: ta.macd(c["close"], p[0], p[1], p[2])[0],
     params=[{"name": "fast", "default": 12, "min": 2, "max": 200},
             {"name": "slow", "default": 26, "min": 3, "max": 400},
             {"name": "signal", "default": 9, "min": 2, "max": 100}])
_add("macd_signal", "MACD signal", "Momentum", "num4",
     lambda c, p: ta.macd(c["close"], p[0], p[1], p[2])[1],
     params=[{"name": "fast", "default": 12, "min": 2, "max": 200},
             {"name": "slow", "default": 26, "min": 3, "max": 400},
             {"name": "signal", "default": 9, "min": 2, "max": 100}])
_add("macd_histogram", "MACD histogram", "Momentum", "num4",
     lambda c, p: ta.macd(c["close"], p[0], p[1], p[2])[2],
     params=[{"name": "fast", "default": 12, "min": 2, "max": 200},
             {"name": "slow", "default": 26, "min": 3, "max": 400},
             {"name": "signal", "default": 9, "min": 2, "max": 100}])
_add("stoch_k", "Stochastic %K", "Momentum", "num2",
     lambda c, p: ta.stochastic(c["high"], c["low"], c["close"], p[0], 3)[0],
     params=[{"name": "period", "default": 14, "min": 2, "max": 200}])
_add("stoch_d", "Stochastic %D", "Momentum", "num2",
     lambda c, p: ta.stochastic(c["high"], c["low"], c["close"], p[0], p[1])[1],
     params=[{"name": "period", "default": 14, "min": 2, "max": 200},
             {"name": "smooth", "default": 3, "min": 1, "max": 50}])
_add("mfi", "Money flow index", "Momentum", "num2",
     lambda c, p: ta.mfi(c["high"], c["low"], c["close"], c["volume"], p[0]),
     params=[{"name": "period", "default": 14, "min": 2, "max": 100}])

# --- Volatility ---------------------------------------------------------

_add("atr", "ATR", "Volatility", "price",
     lambda c, p: ta.atr(c["high"], c["low"], c["close"], p[0]),
     params=[{"name": "period", "default": 14, "min": 2, "max": 200}])
_add("atr_pct", "ATR % of price", "Volatility", "num2",
     lambda c, p: _div(ta.atr(c["high"], c["low"], c["close"], p[0]), c["close"], 100.0),
     params=[{"name": "period", "default": 14, "min": 2, "max": 200}])
_add("bollinger_upper", "Bollinger upper", "Volatility", "price",
     lambda c, p: ta.bollinger(c["close"], p[0], p[1])[1],
     params=[{"name": "period", "default": 20, "min": 2, "max": 300},
             {"name": "mult", "default": 2, "min": 0.5, "max": 6}])
_add("bollinger_lower", "Bollinger lower", "Volatility", "price",
     lambda c, p: ta.bollinger(c["close"], p[0], p[1])[2],
     params=[{"name": "period", "default": 20, "min": 2, "max": 300},
             {"name": "mult", "default": 2, "min": 0.5, "max": 6}])
_add("bollinger_basis", "Bollinger basis", "Volatility", "price",
     lambda c, p: ta.bollinger(c["close"], p[0], p[1])[0],
     params=[{"name": "period", "default": 20, "min": 2, "max": 300},
             {"name": "mult", "default": 2, "min": 0.5, "max": 6}])
_add("bollinger_pct_b", "Bollinger %B", "Volatility", "num2",
     lambda c, p: _pctb(c, p[0], p[1]),
     params=[{"name": "period", "default": 20, "min": 2, "max": 300},
             {"name": "mult", "default": 2, "min": 0.5, "max": 6}])
_add("bollinger_bandwidth", "Bollinger bandwidth", "Volatility", "num2",
     lambda c, p: _bandwidth(c, p[0], p[1]),
     params=[{"name": "period", "default": 20, "min": 2, "max": 300},
             {"name": "mult", "default": 2, "min": 0.5, "max": 6}])
# TradingView's own screener definitions, not a stdev of returns:
# https://www.tradingview.com/support/solutions/43000635876
_add("volatility_d", "Volatility (D)", "Volatility", "num2",
     _tv_volatility_d,
     desc="TradingView screener's Volatility.D — the bar's true range as a "
          "percentage of its low.")
_add("volatility_w", "Volatility (W)", "Volatility", "num2",
     _tv_volatility_w,
     params=[{"name": "bars", "default": 7, "min": 1, "max": 60}],
     desc="TradingView screener's Volatility.W — the mean of the last n bars' "
          "(high-low)/low. 7 bars on a daily chart is one week.")

# --- Volume -------------------------------------------------------------

_add("volume", "Volume (bars)", "Volume", "vol",
     lambda c, p: c["volume"])
_add("volume_sma", "Volume SMA", "Volume", "vol",
     lambda c, p: ta.sma(c["volume"], p[0]),
     params=[{"name": "period", "default": 20, "min": 2, "max": 500}])
_add("volume_ratio", "Volume / SMA(volume)", "Volume", "num2",
     lambda c, p: _div(c["volume"], ta.sma(c["volume"], p[0]), 1.0),
     params=[{"name": "period", "default": 20, "min": 2, "max": 500}],
     desc="2 means twice the average volume")
_add("volume_7d", "Traded value, last n bars (USD)", "Volume", "usd",
     lambda c, p: _rolling_sum(_quote_value(c), p[0]),
     params=[{"name": "bars", "default": 7, "min": 1, "max": 120}],
     desc="Sum of traded value over the last n bars — the rolling weekly "
          "volume on a daily chart, comparable with quote_volume_24h.")

# --- Fundamentals -------------------------------------------------------

_add("market_cap", "Market cap (USD)", "Fundamentals", "usd",
     lambda c, p: _scalar("market_cap", c, len(c["close"]), float))
_add("market_cap_rank", "Market cap rank", "Fundamentals", "int",
     lambda c, p: _scalar("market_cap_rank", c, len(c["close"]), int))
_add("quote_volume_24h", "24h quote volume (USD)", "Fundamentals", "usd",
     lambda c, p: _scalar("quote_volume_24h", c, len(c["close"]), float))


def _div(a, b, scale):
    out = [None] * len(a)
    for i, (x, y) in enumerate(zip(a, b)):
        if x is not None and y:
            out[i] = x / y * scale
    return out


def _pctb(c, n, mult):
    basis, upper, lower = ta.bollinger(c["close"], n, mult)
    out = [None] * len(c["close"])
    for i in range(len(out)):
        u, l = upper[i], lower[i]
        if u is None or u == l:
            continue
        out[i] = (c["close"][i] - l) / (u - l) * 100.0
    return out


def _bandwidth(c, n, mult):
    basis, upper, lower = ta.bollinger(c["close"], n, mult)
    out = [None] * len(c["close"])
    for i in range(len(out)):
        u, l, b = upper[i], lower[i], basis[i]
        if u is None or not b:
            continue
        out[i] = (u - l) / b * 100.0
    return out


CATEGORIES = ["Price", "Trend", "Momentum", "Volatility", "Volume", "Fundamentals"]


def describe():
    """JSON-safe description of every field (for the UI and API docs)."""
    out = []
    for cat in CATEGORIES:
        items = [f for f in FIELDS.values() if f["cat"] == cat]
        if not items:
            continue
        out.append({
            "cat": cat,
            "fields": [
                {
                    "key": f["key"],
                    "label": f["label"],
                    "params": f["params"],
                    "fmt": f["fmt"],
                    "desc": f["desc"],
                }
                for f in items
            ],
        })
    return out


def resolve(spec, ctx, cache):
    """Compute a field series for one symbol, memoised in ``cache``.

    The cache key combines the spec's ``cache_key`` with its candle offset so
    the same indicator on two timeframes never collides.
    """
    key = spec["cache_key"]
    state = spec.get("state")
    tf = spec.get("tf")
    if state is not None or tf is not None:
        key = f"{key}|{state or 'closed'}|{tf or '1d'}"
    if key in cache:
        return cache[key]
    item = FIELDS.get(spec["field"])
    if item is None:
        raise KeyError(f"unknown field: {spec['field']}")
    values = item["_compute"](ctx, tuple(spec["params"]))
    cache[key] = values
    return values
