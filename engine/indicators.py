"""Technical indicators.

Every function takes and returns plain Python lists of floats.
Input lists are assumed to have no ``None`` values; outputs use ``None`` for
warm-up bars where the value is not yet defined.
"""

from __future__ import annotations

import math


def sma(src, n):
    n = int(n)
    out = [None] * len(src)
    if n <= 0:
        return src[:]
    acc = 0.0
    for i, v in enumerate(src):
        acc += v
        if i >= n:
            acc -= src[i - n]
        if i >= n - 1:
            out[i] = acc / n
    return out


def ema(src, n):
    n = int(n)
    out = [None] * len(src)
    if n <= 0 or len(src) < n:
        return out
    k = 2.0 / (n + 1)
    prev = sum(src[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(src)):
        prev = src[i] * k + prev * (1.0 - k)
        out[i] = prev
    return out


def ema_defined(values, n):
    """EMA over a series that may start with ``None`` values."""
    n = int(n)
    out = [None] * len(values)
    if n <= 0:
        return out
    k = 2.0 / (n + 1)
    prev = None
    seed = 0.0
    count = 0
    for i, v in enumerate(values):
        if v is None:
            continue
        if prev is None:
            seed += v
            count += 1
            if count == n:
                prev = seed / n
                out[i] = prev
        else:
            prev = v * k + prev * (1.0 - k)
            out[i] = prev
    return out


def rsi(src, n=14):
    n = int(n)
    out = [None] * len(src)
    if n <= 0 or len(src) <= n:
        return out
    ag = al = 0.0
    for i in range(1, n + 1):
        d = src[i] - src[i - 1]
        ag += max(d, 0.0)
        al += max(-d, 0.0)
    ag /= n
    al /= n
    out[n] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    for i in range(n + 1, len(src)):
        d = src[i] - src[i - 1]
        g = max(d, 0.0)
        l = max(-d, 0.0)
        ag = (ag * (n - 1) + g) / n
        al = (al * (n - 1) + l) / n
        out[i] = 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)
    return out


def _macd_line(src, fast, slow):
    f = ema(src, fast)
    s = ema(src, slow)
    return [
        (a - b) if a is not None and b is not None else None
        for a, b in zip(f, s)
    ]


def macd(src, fast=12, slow=26, signal=9):
    fast, slow, signal = int(fast), int(slow), int(signal)
    line = _macd_line(src, fast, slow)
    sig = ema_defined(line, signal)
    hist = [
        (a - b) if a is not None and b is not None else None
        for a, b in zip(line, sig)
    ]
    return line, sig, hist


def stdev(values, n):
    """Population standard deviation of the last ``n`` bars."""
    n = int(n)
    out = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    for i in range(n - 1, len(values)):
        w = values[i - n + 1: i + 1]
        mean = sum(w) / n
        out[i] = math.sqrt(sum((v - mean) ** 2 for v in w) / n)
    return out


def bollinger(src, n=20, mult=2.0):
    n = int(n)
    mult = float(mult)
    basis = sma(src, n)
    upper = [None] * len(src)
    lower = [None] * len(src)
    sd = stdev(src, n)
    for i in range(len(src)):
        if basis[i] is None or sd[i] is None:
            continue
        upper[i] = basis[i] + mult * sd[i]
        lower[i] = basis[i] - mult * sd[i]
    return basis, upper, lower


def true_range(high, low, close):
    tr = [high[0] - low[0]]
    for i in range(1, len(close)):
        tr.append(
            max(
                high[i] - low[i],
                abs(high[i] - close[i - 1]),
                abs(low[i] - close[i - 1]),
            )
        )
    return tr


def atr(high, low, close, n=14):
    n = int(n)
    out = [None] * len(close)
    if n <= 0 or len(close) <= n:
        return out
    tr = true_range(high, low, close)
    prev = sum(tr[1: n + 1]) / n
    out[n] = prev
    for i in range(n + 1, len(close)):
        prev = (prev * (n - 1) + tr[i]) / n
        out[i] = prev
    return out


def adx(high, low, close, n=14):
    """Returns (adx, plus_di, minus_di) using Wilder's smoothing."""
    n = int(n)
    length = len(close)
    plus_di = [None] * length
    minus_di = [None] * length
    out = [None] * length
    if n <= 0 or length < 2 * n + 1:
        return out, plus_di, minus_di

    trs = [0.0] * length
    pdm = [0.0] * length
    mdm = [0.0] * length
    for i in range(1, length):
        up = high[i] - high[i - 1]
        dn = low[i - 1] - low[i]
        pdm[i] = up if (up > dn and up > 0) else 0.0
        mdm[i] = dn if (dn > up and dn > 0) else 0.0
        trs[i] = max(
            high[i] - low[i],
            abs(high[i] - close[i - 1]),
            abs(low[i] - close[i - 1]),
        )

    a = sum(trs[1: n + 1])
    sp = sum(pdm[1: n + 1])
    sm = sum(mdm[1: n + 1])

    dxs = [None] * length
    for i in range(n, length):
        if i > n:
            a = a - a / n + trs[i]
            sp = sp - sp / n + pdm[i]
            sm = sm - sm / n + mdm[i]
        if a <= 0:
            continue
        pdi = 100.0 * sp / a
        mdi = 100.0 * sm / a
        plus_di[i] = pdi
        minus_di[i] = mdi
        total = pdi + mdi
        dxs[i] = 100.0 * abs(pdi - mdi) / total if total else 0.0

    window = [dxs[i] for i in range(n, 2 * n + 1) if dxs[i] is not None]
    if len(window) < n:
        return out, plus_di, minus_di
    run = sum(window[:n]) / n
    out[2 * n] = run
    for i in range(2 * n + 1, length):
        if dxs[i] is None or out[i - 1] is None:
            break
        run = (out[i - 1] * (n - 1) + dxs[i]) / n
        out[i] = run
    return out, plus_di, minus_di


def stochastic(high, low, close, n=14, smooth=3):
    n, smooth = int(n), int(smooth)
    k = [None] * len(close)
    for i in range(n - 1, len(close)):
        hh = max(high[i - n + 1: i + 1])
        ll = min(low[i - n + 1: i + 1])
        k[i] = 100.0 * (close[i] - ll) / (hh - ll) if hh != ll else 50.0
    d = ema_defined(k, 1) if smooth <= 1 else _sma_defined(k, smooth)
    return k, d


def _sma_defined(values, n):
    n = int(n)
    out = [None] * len(values)
    for i in range(len(values)):
        if i < n - 1:
            continue
        w = values[i - n + 1: i + 1]
        if any(v is None for v in w):
            continue
        out[i] = sum(w) / n
    return out


def mfi(high, low, close, volume, n=14):
    n = int(n)
    out = [None] * len(close)
    if len(close) <= n:
        return out
    pos = neg = 0.0
    for i in range(1, n + 1):
        tp = (high[i] + low[i] + close[i]) / 3.0
        prev_tp = (high[i - 1] + low[i - 1] + close[i - 1]) / 3.0
        flow = tp * volume[i]
        if tp > prev_tp:
            pos += flow
        elif tp < prev_tp:
            neg += flow
    out[n] = 100.0 if neg == 0 else 100.0 - 100.0 / (1.0 + pos / neg)
    for i in range(n + 1, len(close)):
        tp = (high[i] + low[i] + close[i]) / 3.0
        prev_tp = (high[i - 1] + low[i - 1] + close[i - 1]) / 3.0
        flow = tp * volume[i]
        if tp > prev_tp:
            pos += flow
        elif tp < prev_tp:
            neg += flow
        # remove the flow that fell out of the window
        j = i - n
        tpj = (high[j] + low[j] + close[j]) / 3.0
        prev_tpj = (high[j - 1] + low[j - 1] + close[j - 1]) / 3.0
        flowj = tpj * volume[j]
        if tpj > prev_tpj:
            pos -= flowj
        elif tpj < prev_tpj:
            neg -= flowj
        out[i] = 100.0 if neg == 0 else 100.0 - 100.0 / (1.0 + pos / neg)
    return out


def supertrend(high, low, close, n=10, mult=3.0):
    """Returns (line, direction) where direction is 1 (up) or -1 (down)."""
    n, mult = int(n), float(mult)
    a = atr(high, low, close, n)
    line = [None] * len(close)
    direction = [None] * len(close)
    prev_upper = prev_lower = None
    prev_dir = None
    for i in range(len(close)):
        if a[i] is None:
            continue
        mid = (high[i] + low[i]) / 2.0
        bu = mid + mult * a[i]
        bl = mid - mult * a[i]
        if prev_upper is None:
            pu, pl = bu, bl
        else:
            pu = bu if (bu < prev_upper or close[i - 1] > prev_upper) else prev_upper
            pl = bl if (bl > prev_lower or close[i - 1] < prev_lower) else prev_lower
        if prev_dir is None:
            d = -1 if close[i] < pu else 1
        elif prev_dir == 1 and close[i] < pl:
            d = -1
        elif prev_dir == -1 and close[i] > pu:
            d = 1
        else:
            d = prev_dir
        line[i] = pu if d == -1 else pl
        direction[i] = d
        prev_upper, prev_lower, prev_dir = pu, pl, d
    return line, direction


def rolling_extreme(values, n):
    """Returns (highest, lowest) over the trailing ``n`` bars."""
    hi = [None] * len(values)
    lo = [None] * len(values)
    n = int(n)
    for i in range(n - 1, len(values)):
        w = values[i - n + 1: i + 1]
        hi[i] = max(w)
        lo[i] = min(w)
    return hi, lo
