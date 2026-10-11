"""Market data access: spot klines/24h tickers plus CoinGecko fundamentals.

Five spot venues are merged (Binance, Bybit, KuCoin, Bitget, OKX) — every
symbol is tagged with the exchanges that list it, and candles fall back
Binance -> Bybit -> KuCoin -> Bitget -> OKX so coins that only exist on one
venue still scan.  The preference order doubles as the data-quality order, so
adding Bitget and OKX leaves the historical source of every symbol that all
three of the originals list completely unchanged.

Everything is cached in-process with a TTL so repeated scans and the alert
scheduler do not hammer the exchanges.
"""

from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from . import halal

BINANCE = "https://api.binance.com"
BYBIT = "https://api.bybit.com"
KUCOIN = "https://api.kucoin.com"
BITGET = "https://api.bitget.com/api/v2"
# OKX is not reachable from every network — www.okx.com and aws.okx.com both
# time out here while my/app answer fine.  The first host that responds becomes
# the cached default so a dead entry costs one fast probe, not one per request.
OKX_HOSTS = ("https://my.okx.com", "https://app.okx.com", "https://www.okx.com")
COINGECKO = "https://api.coingecko.com/api/v3"

# in data-quality preference order — also the candle fallback order
VENUES = ("binance", "bybit", "kucoin", "bitget", "okx")

USER_AGENT = "chartink-crypto-screener/1.0"

# Fiat / stablecoin bases — never offered as something to buy.  Each addition
# was confirmed against a 30-day series: pegged ones trade inside ~0.5% of
# their target (USDEB, despite the name, swings 18% and stays out).
STABLE_BASES = {
    "USDT", "USDC", "BUSD", "TUSD", "FDUSD", "DAI", "USDP", "USDD", "USD1",
    "RLUSD", "USDE", "USDS", "USDB", "PYUSD", "GUSD", "SUSD", "LUSD", "FRAX",
    "MIM", "XUSD", "USDX", "UST", "USTC", "VAI",
    "BFUSD", "USDG", "USDGO", "USDTB", "USDY",
    "EUR", "EUR1", "EURT", "EURI", "AEUR", "GBP", "GBPT", "JPY", "KRW",
    "BIDR", "BRL", "BRL1", "ARS", "TRY", "UAH", "RUB", "NGN", "IDRT", "COP", "MXN",
}

# Leveraged / inverse token suffixes. Prefix is kept at >=2 chars so real coins
# that merely end in these letters (e.g. JUP) are NOT dropped.
LEVERAGED_SUFFIXES = (
    "UP", "DOWN", "BULL", "BEAR",
    "LONG", "SHORT",
    "2L", "2S", "3L", "3S", "5L", "5S", "3X", "5X", "10X",
)


def _is_stable(base: str) -> bool:
    return base in STABLE_BASES


def _is_leveraged(base: str) -> bool:
    for sfx in LEVERAGED_SUFFIXES:
        if base.endswith(sfx) and len(base) > len(sfx) + 1:
            return True
    return False


def _is_tokenized_base(base: str) -> bool:
    """True for Bitget's tokenized stock/ETF listings (rMU, rQQQ, preSPCX).

    Bitget has no type field for these, but every real crypto base coin is
    uppercase while theirs is mixed-case.  They carry multi-billion-dollar
    notionals, so leaving them in pushes every actual coin out of the
    volume-ranked universe.
    """
    return bool(base) and base != base.upper()


DEFAULT_INTERVAL = "1d"
DEFAULT_LIMIT = 400
DEFAULT_UNIVERSE = 400
MIN_QUOTE_VOLUME = 500_000


class DataError(RuntimeError):
    """Raised when an upstream data provider cannot be reached."""


class _FatalStatus(Exception):
    """Internal: an HTTP status that will not improve on retry."""


class _TTLCache:
    # Backfill pages are keyed by their `end_time`, so without a ceiling a
    # long scroll through history would grow this dict forever.
    MAX_ENTRIES = 512

    def __init__(self):
        self._data = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            value, expires = hit
            if expires < time.time():
                del self._data[key]
                return None
            return value

    def set(self, key, value, ttl):
        with self._lock:
            if len(self._data) >= self.MAX_ENTRIES:
                now = time.time()
                for stale in [k for k, (_, exp) in self._data.items() if exp < now]:
                    del self._data[stale]
                # insertion order = oldest first once expiry has had its turn
                for old in list(self._data)[: self.MAX_ENTRIES // 4]:
                    del self._data[old]
            self._data[key] = (value, time.time() + ttl)

    def clear(self):
        with self._lock:
            self._data.clear()


_cache = _TTLCache()
_local = threading.local()
_executor = ThreadPoolExecutor(max_workers=12)

# Last non-empty CoinGecko snapshot. Kept outside _cache deliberately: it is
# only ever read when CoinGecko itself refuses, so a rate-limited upstream
# still yields usable market caps instead of a blank column. The on-disk copy
# is what lets a freshly restarted process do the same.
FUNDAMENTALS_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data",
    "fundamentals.json"
)
_FUNDAMENTALS_LAST = {}


def reset_cache():
    _cache.clear()


def _session():
    sess = getattr(_local, "session", None)
    if sess is None:
        sess = requests.Session()
        sess.headers.update({"User-Agent": USER_AGENT})
        _local.session = sess
    return sess


def _get(url, params=None, timeout=15, attempts=3):
    last = None
    for attempt in range(attempts):
        try:
            resp = _session().get(url, params=params, timeout=timeout)
            if resp.status_code in (418, 429):
                wait = float(resp.headers.get("Retry-After") or (2 ** attempt))
                time.sleep(min(wait, 10))
                last = DataError(f"rate limited by {url}")
                continue
            if 400 <= resp.status_code < 500:
                # a bad request (unknown interval/symbol) will never succeed -
                # fail fast instead of burning the retry budget
                raise _FatalStatus(f"HTTP {resp.status_code} from {url}")
            resp.raise_for_status()
            return resp.json()
        except _FatalStatus as exc:
            raise DataError(str(exc)) from exc
        except DataError as exc:
            last = exc
        except (requests.RequestException, ValueError) as exc:
            last = DataError(f"{type(exc).__name__}: {exc}")
            time.sleep(0.6 * (attempt + 1))
    raise last or DataError(f"request failed: {url}")


# --------------------------------------------------------------------------
# universe
# --------------------------------------------------------------------------

def _binance_pairs():
    cached = _cache.get("pairs:binance")
    if cached is not None:
        return cached

    info = _get(f"{BINANCE}/api/v3/exchangeInfo")
    tickers = _get(f"{BINANCE}/api/v3/ticker/24hr")

    tradable = {}
    for s in info.get("symbols", []):
        if s.get("status") != "TRADING":
            continue
        if s.get("quoteAsset") != "USDT" or not s.get("isSpotTradingAllowed", True):
            continue
        base = s.get("baseAsset", "")
        if _is_stable(base) or _is_leveraged(base):
            continue
        tradable[s["symbol"]] = base

    out = {}
    for t in tickers:
        symbol = t.get("symbol")
        if symbol not in tradable:
            continue
        try:
            quote_volume = float(t.get("quoteVolume") or 0.0)
            price = float(t.get("lastPrice") or 0.0)
            change = float(t.get("priceChangePercent") or 0.0)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        out[symbol] = {
            "base": tradable[symbol],
            "price": price,
            "change_pct": change,
            "quote_volume": quote_volume,
            "trades": int(t.get("count") or 0),
            "high": float(t.get("highPrice") or 0.0),
            "low": float(t.get("lowPrice") or 0.0),
        }
    _cache.set("pairs:binance", out, ttl=120)
    return out


def _bybit_pairs():
    cached = _cache.get("pairs:bybit")
    if cached is not None:
        return cached

    data = _get(f"{BYBIT}/v5/market/tickers", params={"category": "spot"})
    out = {}
    for t in (data.get("result") or {}).get("list", []) or []:
        symbol = t.get("symbol") or ""
        if not symbol.endswith("USDT"):
            continue
        base = symbol[:-4]
        if _is_stable(base) or _is_leveraged(base):
            continue
        try:
            price = float(t.get("lastPrice") or 0.0)
            change = float(t.get("price24hPcnt") or 0.0) * 100.0
            quote_volume = float(t.get("turnover24h") or 0.0)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        out[symbol] = {
            "base": base,
            "price": price,
            "change_pct": change,
            "quote_volume": quote_volume,
            "trades": 0,
            "high": float(t.get("highPrice24h") or 0.0),
            "low": float(t.get("lowPrice24h") or 0.0),
        }
    _cache.set("pairs:bybit", out, ttl=120)
    return out


def _kucoin_pairs():
    cached = _cache.get("pairs:kucoin")
    if cached is not None:
        return cached

    data = _get(f"{KUCOIN}/api/v1/market/allTickers")
    out = {}
    for t in ((data.get("data") or {}).get("ticker") or []):
        symbol = t.get("symbol") or ""
        if "-" not in symbol:
            continue
        base, _, quote = symbol.partition("-")
        if quote != "USDT":
            continue
        if _is_stable(base) or _is_leveraged(base):
            continue
        try:
            price = float(t.get("last") or 0.0)
            change = float(t.get("changeRate") or 0.0) * 100.0
            quote_volume = float(t.get("volValue") or 0.0)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        out[base + quote] = {
            "base": base,
            "price": price,
            "change_pct": change,
            "quote_volume": quote_volume,
            "trades": 0,
            "high": float(t.get("high") or 0.0),
            "low": float(t.get("low") or 0.0),
        }
    _cache.set("pairs:kucoin", out, ttl=120)
    return out


def _bitget_pairs():
    cached = _cache.get("pairs:bitget")
    if cached is not None:
        return cached

    info = _get(f"{BITGET}/spot/public/symbols")
    tickers = _get(f"{BITGET}/spot/market/tickers")

    tradable = {}
    for s in info.get("data") or []:
        if s.get("status") != "online" or s.get("quoteCoin") != "USDT":
            continue
        base = s.get("baseCoin") or ""
        if _is_stable(base) or _is_leveraged(base):
            continue
        if _is_tokenized_base(base):
            continue
        tradable[s.get("symbol")] = base

    out = {}
    for t in tickers.get("data") or []:
        symbol = t.get("symbol")
        if symbol not in tradable:
            continue
        try:
            price = float(t.get("lastPr") or 0.0)
            change = float(t.get("change24h") or 0.0) * 100.0   # Bitget: a fraction
            quote_volume = float(t.get("usdtVolume") or t.get("quoteVolume") or 0.0)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        out[symbol] = {
            "base": tradable[symbol],
            "price": price,
            "change_pct": change,
            "quote_volume": quote_volume,
            "trades": 0,
            "high": float(t.get("high24h") or 0.0),
            "low": float(t.get("low24h") or 0.0),
        }
    _cache.set("pairs:bitget", out, ttl=120)
    return out


_okx_host = None


def _okx(path, params=None, timeout=10):
    """One OKX call, remembering whichever host answered last time."""
    global _okx_host
    order = [h for h in OKX_HOSTS if h == _okx_host] + [h for h in OKX_HOSTS if h != _okx_host]
    last = None
    for host in order:
        try:
            data = _get(host + path, params=params, timeout=timeout, attempts=2)
        except DataError as exc:
            last = exc
            continue
        _okx_host = host
        return data
    raise last or DataError("okx unreachable")


def _okx_pairs():
    cached = _cache.get("pairs:okx")
    if cached is not None:
        return cached

    info = _okx("/api/v5/public/instruments", {"instType": "SPOT"})
    tickers = _okx("/api/v5/market/tickers", {"instType": "SPOT"})

    tradable = {}
    for i in info.get("data") or []:
        if i.get("state") != "live" or i.get("quoteCcy") != "USDT":
            continue
        # instCategory 3 = tokenized stocks/ETFs (XAAPL, XNVDA, XQQQ ...).
        # They are equities, not coins, and would rank above every real one.
        # Category 1 keeps the genuine X-cryptos (XCH, XLM, XRP, XTZ).
        if str(i.get("instCategory") or "") == "3":
            continue
        base = i.get("baseCcy") or ""
        if _is_stable(base) or _is_leveraged(base):
            continue
        inst = i.get("instId") or ""
        if "-" not in inst:
            continue
        tradable[inst] = base + "USDT"

    out = {}
    for t in tickers.get("data") or []:
        symbol = tradable.get(t.get("instId"))
        if not symbol:
            continue
        try:
            price = float(t.get("last") or 0.0)
            open_24h = float(t.get("open24h") or 0.0)
            # OKX has no change field: derive it the way its own UI does.
            change = (price / open_24h - 1.0) * 100.0 if open_24h > 0 else 0.0
            quote_volume = float(t.get("volCcy24h") or 0.0)   # USDT for spot
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        out[symbol] = {
            "base": symbol[:-4],
            "price": price,
            "change_pct": change,
            "quote_volume": quote_volume,
            "trades": 0,
            "high": float(t.get("high24h") or 0.0),
            "low": float(t.get("low24h") or 0.0),
        }
    _cache.set("pairs:okx", out, ttl=120)
    return out


_VENUE_FETCHERS = {
    "binance": _binance_pairs,
    "bybit": _bybit_pairs,
    "kucoin": _kucoin_pairs,
    "bitget": _bitget_pairs,
    "okx": _okx_pairs,
}


def all_pairs():
    """Merged spot universe across all five exchanges.

    Returns {symbol: row} where row carries `exchanges` (which venues list the
    pair), a price/change snapshot from the preferred venue, and the summed
    24h quote volume used for ranking.
    """
    cached = _cache.get("pairs:merged")
    if cached is not None:
        return cached

    merged = {}
    for venue in VENUES:
        try:
            rows = _VENUE_FETCHERS[venue]()
        except DataError:
            continue                      # one dead venue must not kill scans
        for symbol, row in rows.items():
            entry = merged.get(symbol)
            if entry is None:
                entry = merged[symbol] = {
                    "symbol": symbol,
                    "base": row["base"],
                    "exchanges": [],
                    "quote_volume": 0.0,
                    "price": row["price"],
                    "change_pct": row["change_pct"],
                    "trades": row.get("trades", 0),
                    "high": row.get("high", 0.0),
                    "low": row.get("low", 0.0),
                }
            entry["exchanges"].append(venue)
            entry["quote_volume"] += row["quote_volume"]

    _cache.set("pairs:merged", merged, ttl=120)
    return merged


def venues_for(symbol):
    """Which of the exchanges list this pair (spot)."""
    entry = all_pairs().get(str(symbol).upper())
    return list(entry["exchanges"]) if entry else []


def universe(size=DEFAULT_UNIVERSE, min_quote_volume=MIN_QUOTE_VOLUME):
    """Top N USDT spot pairs by 24h quote volume, with price snapshot attached."""
    size = int(size or DEFAULT_UNIVERSE)
    key = ("universe", size, int(min_quote_volume))
    cached = _cache.get(key)
    if cached is not None:
        return cached

    rows = [e for e in all_pairs().values()
            if e["quote_volume"] >= min_quote_volume and e["price"] > 0]
    rows.sort(key=lambda r: r["quote_volume"], reverse=True)
    rows = [dict(r) for r in rows[:size]]
    halal.annotate(rows)
    _cache.set(key, rows, ttl=120)
    return rows


def snapshot():
    """Every symbol with a 24h price snapshot (no size cap)."""
    return {row["symbol"]: row for row in universe(size=1000, min_quote_volume=0)}


def ticker(symbols):
    """24h ticker data for an explicit list of symbols (watchlist).

    Served from the merged venue snapshot; symbols that no venue knows about
    fall back to a direct Binance lookup.
    """
    symbols = [str(s).upper() for s in symbols][:80]
    if not symbols:
        return {}
    key = ("ticker", ",".join(sorted(symbols)))
    cached = _cache.get(key)
    if cached is not None:
        return cached

    pairs = all_pairs()
    out = {}
    missing = []
    for symbol in symbols:
        row = pairs.get(symbol)
        if row and row.get("price", 0) > 0:
            out[symbol] = {
                "symbol": symbol,
                "price": row["price"],
                "change_pct": row["change_pct"],
                "quote_volume": row["quote_volume"],
                "high": row.get("high", 0.0),
                "low": row.get("low", 0.0),
                "exchanges": row.get("exchanges", []),
            }
        else:
            missing.append(symbol)

    def fetch_binance(symbol):
        try:
            row = _get(f"{BINANCE}/api/v3/ticker/24hr", params={"symbol": symbol})
            return symbol, {
                "symbol": symbol,
                "price": float(row.get("lastPrice") or 0.0),
                "change_pct": float(row.get("priceChangePercent") or 0.0),
                "quote_volume": float(row.get("quoteVolume") or 0.0),
                "high": float(row.get("highPrice") or 0.0),
                "low": float(row.get("lowPrice") or 0.0),
                "exchanges": ["binance"],
            }
        except (DataError, TypeError, ValueError):
            return symbol, None

    if missing:
        for symbol, row in _executor.map(fetch_binance, missing):
            if row and row["price"] > 0:
                out[symbol] = row

    # Watchlist badges need the same halal verdicts the screener shows.
    halal.annotate(list(out.values()))

    _cache.set(key, out, ttl=60)
    return out


# --------------------------------------------------------------------------
# klines
# --------------------------------------------------------------------------

def _interval_seconds(interval):
    unit = interval[-1]
    value = int(interval[:-1]) if interval[:-1].isdigit() else 1
    scale = {"m": 60, "h": 3600, "d": 86400, "w": 604800,
             "M": 2592000, "y": 31536000}.get(unit, 86400)
    return value * scale


interval_seconds = _interval_seconds


# Intervals each venue answers natively.  45m, 3h and 1y are missing on all
# five, so the scanner aggregates them from a finer interval instead.
_BYBIT_INTERVALS = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60",
                    "2h": "120", "4h": "240", "1d": "D", "1w": "W", "1M": "M"}
_KUCOIN_INTERVALS = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
                     "1h": "1hour", "2h": "2hour", "4h": "4hour",
                     "1d": "1day", "1w": "1week", "1M": "1month"}
# Bitget has no monthly candlestick (its API answers 400171 for `1month`).
_BITGET_INTERVALS = {"1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min",
                     "30m": "30min", "1h": "1h", "2h": "2h", "4h": "4h",
                     "6h": "6h", "12h": "12h", "1d": "1day", "1w": "1week"}
# OKX upper-cases the unit and the bar name itself.
_OKX_INTERVALS = {"1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
                  "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H",
                  "1d": "1D", "3d": "3D", "1w": "1W", "1M": "1M"}


def _klines_binance(symbol, interval, limit, end_time=None):
    # `endTime` walks the book backwards: Binance answers with the newest
    # `limit` bars that close at or before it, which is how the chart pages
    # through everything it has ever traded.
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    if end_time:
        params["endTime"] = int(end_time) * 1000
    raw = _get(f"{BINANCE}/api/v3/klines", params=params)
    if not raw:
        raise DataError(f"no binance klines for {symbol}")
    # time, open, high, low, close, volume, quote volume
    return [(int(r[0] // 1000), float(r[1]), float(r[2]), float(r[3]),
             float(r[4]), float(r[5]), float(r[7])) for r in raw]


def _klines_bybit(symbol, interval, limit, end_time=None):
    iv = _BYBIT_INTERVALS.get(interval)
    if not iv:
        raise DataError(f"interval {interval} is not offered on bybit")
    params = {"category": "spot", "symbol": symbol, "interval": iv, "limit": min(limit, 1000)}
    if end_time:
        params["end"] = int(end_time) * 1000
    data = _get(f"{BYBIT}/v5/market/kline", params=params)
    raw = (data.get("result") or {}).get("list") or []
    if not raw:
        raise DataError(f"no bybit klines for {symbol}")
    rows = [(int(r[0]) // 1000, float(r[1]), float(r[2]), float(r[3]),
             float(r[4]), float(r[5]), float(r[6])) for r in raw]
    rows.reverse()                      # Bybit answers newest-first
    return rows[-limit:]


def _klines_kucoin(symbol, interval, limit, end_time=None):
    # KuCoin's candles endpoint has no usable range window — it always hands
    # back its most recent slice, so `end_time` is ignored here.  The caller
    # notices the oldest bar never moves and stops paging.
    iv = _KUCOIN_INTERVALS.get(interval)
    if not iv:
        raise DataError(f"interval {interval} is not offered on kucoin")
    pair = f"{symbol[:-4]}-USDT" if symbol.endswith("USDT") else symbol
    data = _get(f"{KUCOIN}/api/v1/market/candles", params={"symbol": pair, "type": iv})
    raw = data.get("data") or []
    if not raw:
        raise DataError(f"no kucoin klines for {symbol}")
    # KuCoin order is time, open, close, high, low, volume, turnover
    rows = [(int(r[0]), float(r[1]), float(r[3]), float(r[4]),
             float(r[2]), float(r[5]), float(r[6])) for r in raw]
    rows.reverse()                      # newest first
    return rows[-limit:]


def _klines_bitget(symbol, interval, limit, end_time=None):
    iv = _BITGET_INTERVALS.get(interval)
    if not iv:
        raise DataError(f"interval {interval} is not offered on bitget")
    params = {"symbol": symbol, "granularity": iv, "limit": str(min(limit, 300))}
    if end_time:
        # Bitget answers with the `limit` bars ending at `endTime`.
        params["endTime"] = int(end_time) * 1000
    raw = _get(f"{BITGET}/spot/market/candles", params=params).get("data") or []
    if not raw:
        raise DataError(f"no bitget klines for {symbol}")
    # time, open, high, low, close, volume, quote volume — Bitget already
    # answers oldest-first, but sorting keeps the contract venue-independent.
    rows = [(int(r[0]) // 1000, float(r[1]), float(r[2]), float(r[3]),
             float(r[4]), float(r[5]), float(r[6])) for r in raw]
    rows.sort(key=lambda r: r[0])
    return rows[-limit:]


def _klines_okx(symbol, interval, limit, end_time=None):
    iv = _OKX_INTERVALS.get(interval)
    if not iv:
        raise DataError(f"interval {interval} is not offered on okx")
    if not symbol.endswith("USDT"):
        raise DataError(f"no okx pair for {symbol}")
    inst = f"{symbol[:-4]}-USDT"

    # OKX caps a page at 100 bars and paginates backwards with `after`:
    # "return records earlier than this ts".  `end_time + 1` therefore yields
    # the newest bars that close at or before it, matching Binance's endTime.
    after = str(int(end_time) * 1000 + 1) if end_time else None
    rows, seen = [], set()
    for _ in range(10):                       # 10 pages x 100 = 1000 bars
        params = {"instId": inst, "bar": iv, "limit": "100"}
        if after:
            params["after"] = after
        data = _okx("/api/v5/market/candles", params).get("data") or []
        if not data:
            break
        for r in data:                        # OKX answers newest-first
            stamp = int(r[0]) // 1000
            if stamp in seen:
                continue
            seen.add(stamp)
            rows.append((stamp, float(r[1]), float(r[2]), float(r[3]),
                         float(r[4]), float(r[5]), float(r[6])))
        if len(data) < 100:
            break
        oldest = min(int(r[0]) for r in data)
        if after and oldest >= int(after):
            break                             # no progress, stop paging
        after = str(oldest)
        if len(rows) >= limit:
            break

    if not rows:
        raise DataError(f"no okx klines for {symbol}")
    rows.sort(key=lambda r: r[0])
    return rows[-limit:]


_KLINE_VENUES = (
    ("binance", _klines_binance),
    ("bybit", _klines_bybit),
    ("kucoin", _klines_kucoin),
    ("bitget", _klines_bitget),
    ("okx", _klines_okx),
)


def klines(symbol, interval=DEFAULT_INTERVAL, limit=DEFAULT_LIMIT, end_time=None, source=None):
    """OHLCV for one symbol, falling back Binance -> Bybit -> KuCoin -> Bitget -> OKX.

    The winning venue is recorded as ``data["source"]`` so the UI can say
    where the candles came from. A coin that exists on only one exchange
    still scans, as long as that exchange answers.

    ``end_time`` (unix seconds) asks for the newest bar *closing at or before*
    that instant instead of the newest bar overall — that is what lets the
    chart walk all the way back to a symbol's first trade, 1000 bars a page.
    ``source`` pins that walk to the venue the chart already loaded from, so
    one history never mixes two exchanges' candles.
    """
    interval = interval or DEFAULT_INTERVAL
    limit = max(50, min(int(limit or DEFAULT_LIMIT), 1000))
    key = ("klines", symbol, interval, limit, end_time, source)
    cached = _cache.get(key)
    if cached is not None:
        return cached

    seconds = _interval_seconds(interval)
    now = time.time()
    last_error = None
    venues = _KLINE_VENUES
    if source:
        pinned = [(name, fn) for name, fn in _KLINE_VENUES if name == source]
        if pinned:
            venues = pinned

    for venue, fetch in venues:
        try:
            rows = fetch(symbol, interval, limit, end_time)
        except DataError as exc:
            last_error = exc
            continue
        except Exception as exc:  # noqa: BLE001 - a malformed payload must not kill a scan
            last_error = DataError(f"{venue}: {type(exc).__name__}: {exc}")
            continue

        if not rows:
            last_error = DataError(f"no klines for {symbol} on {venue}")
            # Walking back and a venue answers "nothing at or before that
            # instant" means its book stops there.  Falling through to the
            # next exchange would hand back bars *newer* than the request.
            if end_time:
                break
            continue

        data = {
            "symbol": symbol,
            "interval": interval,
            "source": venue,
            "time": [r[0] for r in rows],
            "open": [r[1] for r in rows],
            "high": [r[2] for r in rows],
            "low": [r[3] for r in rows],
            "close": [r[4] for r in rows],
            "volume": [r[5] for r in rows],
            "quote_volume": [r[6] for r in rows],
            # a bar counts as closed once its window has elapsed
            "closed": [r[0] + seconds <= now for r in rows],
        }
        _cache.set(key, data, ttl=max(15, min(seconds, 300)))
        return data

    raise last_error or DataError(f"no kline data for {symbol}")


def klines_many(symbols, interval=DEFAULT_INTERVAL, limit=DEFAULT_LIMIT, on_done=None):
    """Fetch klines for many symbols in parallel. Returns {symbol: data|error}."""
    results = {}
    done = 0
    lock = threading.Lock()

    def work(symbol):
        nonlocal done
        try:
            payload = klines(symbol, interval, limit)
            value = {"ok": True, "data": payload}
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not fail the scan
            value = {"ok": False, "error": str(exc)}
        with lock:
            results[symbol] = value
            done += 1
            if on_done:
                try:
                    on_done(done, len(symbols))
                except Exception:  # noqa: BLE001
                    pass
        return value

    list(_executor.map(work, list(symbols)))
    return results


# --------------------------------------------------------------------------
# fundamentals
# --------------------------------------------------------------------------

def _fundamentals_snapshot():
    """The last good CoinGecko dump, read from disk.

    Lets a freshly restarted process answer immediately instead of spending its
    first thirty seconds being rate-limited into an empty market-cap column.
    """
    try:
        with open(FUNDAMENTALS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and data:
            return data
    except (OSError, ValueError):
        pass  # missing or half-written: fall through to "no snapshot"
    return {}


def _save_fundamentals_snapshot(out):
    """Persist a successful fetch. A read-only data dir must never break a scan."""
    try:
        with open(FUNDAMENTALS_FILE, "w", encoding="utf-8") as fh:
            json.dump(out, fh)
    except OSError:
        pass


def fundamentals():
    """Market-cap data from CoinGecko keyed by UPPER-CASE ticker symbol."""
    cached = _cache.get("fundamentals")
    if cached is not None:
        return cached
    out = {}
    try:
        for page in (1, 2, 3, 4):
            rows = _get(
                f"{COINGECKO}/coins/markets",
                params={
                    "vs_currency": "usd",
                    "order": "market_cap_desc",
                    "per_page": 250,
                    "page": page,
                },
            )
            if not rows:
                break
            for row in rows:
                ticker = (row.get("symbol") or "").upper()
                if not ticker or ticker in out:
                    continue
                out[ticker] = {
                    "market_cap": row.get("market_cap"),
                    "market_cap_rank": row.get("market_cap_rank"),
                    "name": row.get("name"),
                }
    except DataError:
        out = {}

    if out:
        _FUNDAMENTALS_LAST.clear()
        _FUNDAMENTALS_LAST.update(out)
        _save_fundamentals_snapshot(out)
        _cache.set("fundamentals", out, ttl=900)
        return out

    # CoinGecko is rate-limiting us. Hand back the last snapshot we did get —
    # seeding it from disk if this process has never fetched one — because
    # slightly stale market caps beat a blank column, and come back in a minute
    # rather than remembering "these coins have no market cap" for a quarter of
    # an hour.
    if not _FUNDAMENTALS_LAST:
        _FUNDAMENTALS_LAST.update(_fundamentals_snapshot())
    stale = dict(_FUNDAMENTALS_LAST)
    _cache.set("fundamentals", stale, ttl=60)
    return stale
