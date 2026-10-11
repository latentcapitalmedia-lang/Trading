# chartink·crypto

A Chartink-style stock screener, rebuilt for crypto. It scans **spot USDT pairs
across Binance, Bybit, KuCoin, Bitget and OKX** with a visual AND/OR/NOT condition
builder, a Chartink-compatible text clause language, saved scans, watchlists,
alerts and a full JSON/HTML/CSV API.

* **Spot only** — no futures, no shorting, no leveraged or inverse tokens and no
  stablecoins. Every result is a coin you can buy outright.
* **Halal screen** — a coin is shown only when **3 of the 5** specialist
  platforms below mark it compliant (on by default, one switch to lift it):
  Shariyah Review Board (SRB), Islamic Finance Gateway (IFG), CryptoUmmah,
  SharLife and SC Malaysia. `GET /api/halal` returns every verdict.
* **Five venues, one universe** — a pair qualifies if *any* of the five
  exchanges lists it; the Chartink "segment" select narrows a scan to one venue.

No database, no build step, no Node. It is a Flask server plus static files.

---

## Quick start

Double-click **`run.bat`** — it launches the server and opens
<http://127.0.0.1:5000/>.

Or from a terminal:

```bat
cd chartink-crypto
"C:\Users\abuza\AppData\Local\Programs\Python\Python313\python.exe" app.py
```

Then open <http://127.0.0.1:5000/>.

| | |
|---|---|
| Port | `5000` (override with the `PORT` environment variable) |
| Python | 3.13 — `pip install -r requirements.txt` (flask, requests) |
| Data | Binance / Bybit / KuCoin / Bitget / OKX public APIs (klines, tickers) + CoinGecko (market cap/rank) |
| Halal data | `data/halal.json` — 5-platform verdict snapshot |
| State | JSON files in `data/`; caches are in-memory per process |

The first scan after a restart is slow (cold cache: several hundred symbols of
daily candles, roughly 10–20s). Every scan after that is fast.

---

## The screener

Open the **Screener** tab. The page is laid out the way Chartink lays it out:

* an action row — **Run Scan**, **Save Scan**, **Create Alert**, **More ▾**;
* a scope notice (halal screen, exchange segment, spot-only);
* a left rail — **Columns**, **Filters**, **Group/Sort**;
* a panel with **Design** and **Result** tabs — the results live *inside* the
  panel, so you never lose the builder, and the panel header always shows
  progress plus `26 of 26 coins matched · [clause]`.

There are two interchangeable ways to write a scan — switch between them at any
time, they stay in sync:

1. **Clause box** — the *Advanced* disclosure holds Chartink-style text you type.
2. **Visual builder** — nested groups with `all / any 1 … any 5` joins, one
   condition per row, with per-row comment / copy / duplicate / enable /
   explain / remove actions and drag-to-reorder.

**Run Scan** parses whatever text you typed first (a dirty clause box wins over
the builder), so you always scan what you are looking at. Unfinished rows — a
missing comparison operator — flash and stop the run with Chartink's own
message. An empty builder says *"No filters applied"*.

### Results

* Table columns: `Sr.` `Stock Name` `Symbol` `Exchange` `Halal` `Price`
  `24h %` + every field you filtered on + `24h Volume` `Mkt Cap` `Trend`
  `★` `⌁` `+` — sortable, searchable, paginated (10–50 per page).
* **View tabs**: Table, Bar, Pie, Line, Area, Heatmap, Billboard, Stacked bar,
  Scatter.
* Toolbar: **Customize columns**, **Copy**, **CSV**, **Excel**, search,
  **Settings** (segment, timeframe, universe, trend column, halal screen,
  auto-refresh every 60s).
* **+** on the header adds any field as a real computed column — the values come
  back from `POST /api/columns`, no rescan.

**Magic Filters** turns plain English ("coins up by 4% and rising volume") into
builder rows, in **Append** or **Replace** mode. **Save Scan** stores your scan
under *My scans* in the Scans tab (localStorage).

### Clause syntax

```text
# comparisons
[rsi(14)] < 30
[close] >= [high_52w(365)]
[macd_line(12,26,9)] crossed above [macd_signal(12,26,9)]

# boolean logic — and / or / not, brackets optional
[price_vs_sma(50)] > 0 and ([adx(14)] > 25 or [rsi(14)] > 60)
not [market_cap] < 1000000
volume > 5000000

# a bare field means "> 0"
[supertrend_dir(10,3)]
```

* Operators: `>` `<` `>=` `<=` `=` `==` `!=`, plus `crossed above` /
  `crossed below` (also accepted as `cross above`, `crosses above`, …).
* `and` / `or` / `not` are case-insensitive; `AND`, `&&` and `||` also work.
* Parameters go in brackets: `rsi(14)`, `sma(50)`, `macd_line(12,26,9)`.
* Double brackets are normalised automatically: `[[rsi(14)]] < 30`.
* Anything invalid raises a `ClauseError` with a position — the UI underlines
  it, `GET /api/parse` returns it as JSON.

### Fields (42)

| Category | Fields |
|---|---|
| Price | `close` `open` `high` `low` `change_pct` `roc` `high_52w` `low_52w` `pct_from_high_52w` `pct_from_low_52w` `range_pos` |
| Trend | `sma` `ema` `price_vs_sma` `price_vs_ema` `supertrend` `supertrend_dir` `adx` `di_plus` `di_minus` `high_n` `low_n` |
| Momentum | `rsi` `macd_line` `macd_signal` `macd_histogram` `stoch_k` `stoch_d` `mfi` |
| Volatility | `atr` `atr_pct` `bollinger_upper` `bollinger_lower` `bollinger_basis` `bollinger_pct_b` `bollinger_bandwidth` |
| Volume | `volume` `volume_sma` `volume_ratio` |
| Fundamentals | `market_cap` `market_cap_rank` `quote_volume_24h` |

`GET /api/fields` returns all of them with labels, parameter ranges and
descriptions — that is what the builder's dropdowns are built from.

**Note on `high_52w` / `low_52w` / `high_n` / `low_n`:** these look back over
*prior* bars only (the current bar is excluded), so `[close] > [high_52w(365)]`
is a genuine breakout, not "equal to today's high".

**Note on fundamentals:** market cap comes from CoinGecko and matches roughly
70–75% of Binance USDT pairs (symbol mismatches on the rest). Rows without the
value simply never satisfy a condition that needs it.

### Halal screening

`engine/halal.py` holds a snapshot of five specialist screening platforms
(`data/halal.json`) and applies a **majority rule**: a coin is halal when **3 or
more** of the 5 mark it `y`. Grey/mashbooh and un-assessed coins count as *no*.

| | |
|---|---|
| Endpoints | `GET /api/halal` — platforms, rule, per-coin verdicts |
| Coverage | 71 coins assessed, 29 pass the majority rule |
| Default | `halal_only: true` — lift it in the screener Settings menu or per request |
| Per request | `POST /api/scan` accepts `halal_only`; `GET /api/universe?halal=1` |

The universe itself is top-400 by 24h quote volume (27 of them currently pass),
so with the screen ON a scan is over 27 coins; switch it off for all 400.

### Exchange segments

The universe is **every spot USDT pair listed on Binance, Bybit, KuCoin, Bitget
or OKX** (~1,100 merged, ~400 after the volume floor). The segment select in the
builder heading — `All exchanges`, `Binance`, `Bybit`, `KuCoin`, `Bitget`, `OKX`
— narrows a scan to one venue, exactly like Chartink's segment list. Klines come
from Binance first, then Bybit, then KuCoin, then Bitget, then OKX.

Tokenized equities and tokenized gold are not coins: Bitget's mixed-case
`baseCoin` and OKX's `instCategory == "3"` are filtered out so an equity ticker
can never reach a result.

---

## Watchlist groups

Six groups ship with the app — **Binance, Bybit, KuCoin, Bitget, OKX** and
**Favourite** — and you can add five more of your own.

The five exchange groups are **not stored anywhere**. Every request re-derives
them from the merged universe and keeps only that venue's halal coins, biggest
first. That is what keeps them current: a coin listed on Binance this morning is
in the Binance group this morning, including coins the five platforms have not
assessed yet — those pass through the auto-screen and are badged `auto`.

Favourite is your starred list, the same `data/watchlist.json` the screener's ★
column writes to. Custom groups live in `data/watchlist_groups.json`, and the
server refuses to create a sixth.

Every group shows the same twelve columns:

| # | Column | Where it comes from |
|---|---|---|
| 1 | Symbol | universe — star toggles Favourite |
| 2 | Price | last trade |
| 3 | 24h volume | quote volume merged across the venues that list it |
| 4 | Weekly volume | `volume_7d(7)` — sum of the last 7 daily bars |
| 5 | 24h change % | 24h tick change |
| 6 | Weekly change % | `roc(7)` |
| 7 | Weekly MACD histogram | `macd_histogram(12,26,9)` on **weekly** bars |
| 8 | Daily MACD histogram | `macd_histogram(12,26,9)` on daily bars |
| 9 | RSI(14) | `rsi(14)` on the daily chart |
| 10 | Market cap | CoinGecko circulating cap |
| 11 | Weekly volatility | `volatility_w(7)` |
| 12 | Daily volatility | `volatility_d` |

Rows load in **two phases** so the table paints immediately:

1. `GET /api/watchlist/groups/<id>` returns the snapshot columns (symbol, price,
   24h volume, 24h change) straight off the universe — ~10 ms warm, and
   deliberately *not* joined to CoinGecko, so a rate-limited upstream can never
   hold the first paint.
2. `POST /api/watchlist/values` starts a background job for the eight columns
   that need candle history. Poll `GET /api/watchlist/values/<job>` for
   `done/total` and the values. The weekly MACD comes off weekly bars: the
   parser only honours a timeframe written *outside* the brackets, so the token
   is `closed weekly macd_histogram(12,26,9)`, not `macd_histogram(12,26,9)`.

Volatility follows TradingView's own screener definition
([support article](https://www.tradingview.com/support/solutions/43000635876-how-is-volatility-calculated-in-the-screener/)):

* `volatility_d` = `true range × 100 / |low|` of the last daily bar
* `volatility_w` = mean of `(high − low) / |low| × 100` over the last 7 bars

| Route | |
|---|---|
| `GET /api/watchlist/groups` | every group, its symbols, the column schema, `used_custom`/`max_custom` |
| `GET /api/watchlist/groups/<id>` | phase-0 rows for one group — `?limit=50\|100\|150\|250\|all` |
| `POST /api/watchlist/groups` | create a custom group — **400** above five |
| `PUT /api/watchlist/groups/<id>` | rename / replace symbols |
| `DELETE /api/watchlist/groups/<id>` | remove a custom group (built-ins 404) |
| `POST /api/watchlist/groups/<id>/activate` | make it the group that opens next |
| `POST /api/watchlist/values` | start phase 2 for a symbol list |
| `GET /api/watchlist/values/<job>` | poll it |

The row cap defaults to 150 and can be 50, 100, 150, 250 or all.

---

## Tabs

| Tab | What it does |
|---|---|
| **Screener** | Chartink-style Design/Result panel: builder + Magic Filters + live results |
| **Scans** | 21 built-in presets plus anything you saved under *My scans*, one click to load and run |
| **Charts** | TradingView-style chart: 27 indicators (12 overlays + 15 panes) with editable parameters, 12 drawing tools, magnet mode, unlimited pan/zoom, timeframe + symbol switch, per-symbol/per-interval layout saved to localStorage (`#/chart/BTCUSDT`) |
| **Watchlist** | Six built-in groups (Binance, Bybit, KuCoin, Bitget, OKX, Favourite) plus up to five custom ones, every row showing the same twelve columns. Exchange groups always hold that platform's current halal coins, so a coin listed this morning appears this morning. Stored server-side, so it follows you between devices |
| **Alerts** | Re-run a saved clause on a timer, scoped by exchange segment and the halal screen; notified on *new* matches (in-app, browser notification, or Telegram) |
| **API** | The endpoint reference below, rendered in the app |

---

## HTTP API

Base: `http://127.0.0.1:5000` — every endpoint is CORS-open.

### Metadata

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/fields` | Every field usable in a clause |
| GET | `/api/presets` | The built-in scan library |
| GET | `/api/halal` | 5-platform halal verdicts + the majority rule |
| GET | `/api/parse?clause=…` | Parse a clause → AST + normalised text |
| GET | `/api/validate?clause=…` | Validate without scanning |

### Market data

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/universe?size=400&venue=binance&halal=1` | Top USDT pairs by 24h quote volume (`venue`, `halal` optional) |
| GET | `/api/ticker?symbols=BTCUSDT,ETHUSDT` | 24h ticker + venues + halal verdict for explicit symbols |
| GET | `/api/klines?symbol=BTCUSDT&interval=1d&limit=400` | Raw OHLCV candles |
| GET | `/api/chart/BTCUSDT?interval=1d&limit=300` | Candles shaped for the chart view |

Intervals: `1m 5m 15m 1h 4h 1d 1w`.

### Scanning

```bash
# start a background job
curl -X POST http://127.0.0.1:5000/api/scan \
     -H "Content-Type: application/json" \
     -d '{"clause":"[rsi(14)] < 30 and volume > 1000000","interval":"1d","universe":200,"venue":"binance","halal_only":true}'
# -> {"job_id":"…","status":"queued"}

# poll it
curl http://127.0.0.1:5000/api/scan/<job_id>

# or just block until it finishes
curl -X POST http://127.0.0.1:5000/api/scan/sync \
     -H "Content-Type: application/json" \
     -d '{"clause":"[rsi(14)] < 30"}'
```

Optional on every scan: `venue` (`binance` / `bybit` / `kucoin` / `bitget` /
`okx` / null), `halal_only` (bool), `columns` (extra computed columns, e.g.
`["rsi(14)","sma(50)"]`).

### Extra columns without a rescan

```bash
curl -X POST http://127.0.0.1:5000/api/columns \
     -H "Content-Type: application/json" \
     -d '{"symbols":["BTCUSDT","ETHUSDT"],"columns":["rsi(14)","price_vs_sma(50)"],"interval":"1d"}'
```

Used by the **+** button on the results header: existing rows get new computed
columns without running the scan again.

### Chartink-compatible endpoint

`POST /screener/process` accepts `scan_clause` as form data, JSON, or a query
string — the same shape Chartink uses, so existing tooling can point at this
server unchanged.

```bash
# JSON
curl -X POST http://127.0.0.1:5000/screener/process \
     -H "Content-Type: application/json" \
     -d '{"scan_clause":"[rsi(14)] < 30"}'

# HTML or CSV
curl -X POST "http://127.0.0.1:5000/screener/process?format=csv" \
     -d "scan_clause=[rsi(14)] < 30"
```

### Watchlist, alerts, settings

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/watchlist` | Read / replace (`{"symbols":["BTCUSDT"]}`) |
| GET / POST | `/api/alerts` | List / create alerts |
| DELETE | `/api/alerts/<id>` | Remove an alert |
| GET | `/api/alerts/pending` | Notifications waiting to be shown |
| POST | `/api/alerts/run` | Force the alert engine to check now |
| GET / POST | `/api/settings` | Read / patch settings |
| POST | `/api/settings/test-telegram` | Send a test Telegram message |

---

## Tests

```bat
set PY="C:\Users\abuza\AppData\Local\Programs\Python\Python313\python.exe"

%PY% tests\test_engine.py    :: indicators, parser, fields, evaluation — offline
%PY% tests\test_live.py      :: real scans against Binance
%PY% tests\test_api.py       :: full API suite — needs the server running
```

---

## Layout

```
chartink-crypto/
├── app.py              Flask routes, CORS + no-cache headers
├── run.bat             launcher (starts server, opens browser)
├── engine/
│   ├── indicators.py   sma ema rsi macd bollinger atr adx stochastic mfi supertrend
│   ├── fields.py       42 filterable fields + metadata
│   ├── expressions.py  clause parser → AST (and back to text)
│   ├── scanner.py      plan build, evaluation, extra-column compute, background jobs
│   ├── exchange.py     Binance/Bybit/KuCoin/Bitget/OKX + CoinGecko clients, merged universe, TTL caches
│   ├── halal.py        5-platform majority screening (data/halal.json), with a structural auto-screen
│   ├── watchlist.py    the 6 built-in + 5 custom watchlist groups, twelve-column schema
│   ├── alerts.py       alert CRUD (clause + segment + cadence), scheduler, Telegram
│   └── presets.py      built-in scan library
├── static/
│   ├── index.html      shell
│   ├── style.css       dark Chartink theme (Atlas section = screener chrome)
│   ├── app.js          state, Chartink builder, results, exports, router
│   ├── pages.js        scans / chart / watchlist / alerts / API pages
│   ├── chartview.js    chart: 27 indicators, 12 drawing tools, pan/zoom, storage
│   ├── chartview.css   chart chrome
│   ├── chart.js        ChartKit: sparkline + result-view canvas charts
│   └── vendor/         lightweight-charts 5.2.1 (standalone production build)
├── data/               presets, alerts, watchlist, watchlist_groups, settings, pending, halal.json, fundamentals (JSON)
└── tests/              engine, live and API suites
```

---

## Caveats

* Public Binance/Bybit/KuCoin/Bitget/OKX/CoinGecko APIs are rate-limited; scans
  share one process-wide cache, so back-to-back scans are cheap but a restart
  starts cold.
* Klines prefer Binance, then Bybit, then KuCoin, then Bitget, then OKX per
  symbol — a coin that only one venue knows still scans, with that venue's
  candles.
* Historical data for very new listings is short — those symbols are reported as
  *too new to scan* rather than treated as errors.
* The halal verdicts are a **snapshot** in `data/halal.json` with an `updated`
  date; refresh that file to re-screen. 71 of the top coins carry an explicit
  platform verdict. A coin **none** of the five platforms has assessed passes
  only if the structural auto-screen lets it through (not stable/fiat, not
  leveraged, not tokenized equity) — those rows are badged `auto`, not `5/5`,
  so a platform verdict is never confused with a guess.
* Data caches live in memory only; restarting the server clears them. Market cap
  is the exception: the last good CoinGecko dump is kept in
  `data/fundamentals.json`, so a restart never shows an empty market-cap column
  even if CoinGecko is rate-limiting at the time.
* This is a development server. Put nginx/Caddy in front of it before exposing
  it beyond localhost.
