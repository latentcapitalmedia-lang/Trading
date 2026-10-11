# Indicator request sheet

Tick the boxes you want, then send this file back (or just reply with the names).

- **You said you'll use 10–15.** Pick freely — there is no penalty for more, but each one is built to
  pixel-diff fidelity against real TradingView, so fewer = faster.
- Anything **already built** is marked ✅ — don't re-pick it, it's done.
- Names match TradingView's own indicator search, so you can verify each one on the live TV tab.

---

## A. Trend — moving averages & channels

Already done ✅: SMA, EMA, WMA, HMA, Bollinger Bands, Keltner Channel, Donchian Channel,
VWAP (session), Supertrend, Parabolic SAR, Ichimoku Cloud, Alligator.

- [ ] **Linear Regression Curve** — least-squares fit line over N bars
- [ ] **Linear Regression Channel** — regression + ±1/±2 std-dev parallel channels
- [ ] **Kaufman Adaptive MA (KAMA)** — efficiency-ratio adaptive smoothing
- [ ] **McGinley Dynamic** — self-adjusting MA, no lag overshoot
- [ ] **Zero-Lag EMA (ZLEMA)** — lag-compensated EMA
- [ ] **DEMA** — double EMA
- [ ] **TEMA** — triple EMA
- [ ] **VWMA** — volume-weighted moving average
- [ ] **Gaussian Filter** — Gaussian-weighted smoothing
- [ ] **Elastic Volume-Weighted MA (EVWMA)** — volume-decay adaptive
- [ ] **Moving Average Ribbon** — stacked MAs coloured by slope
- [ ] **Guppy Multiple MA (GMMA)** — short + long MA groups
- [ ] **Triple Moving Average** — 3 MAs with trend colouring
- [ ] **MA Cross** — SMA crossover signal + background
- [ ] **MA Cross Exponential** — EMA crossover signal + background
- [ ] **Chandelier Exit** — ATR trailing stop, long/short flip
- [ ] **Zig Zag** — swing filter, ignores moves under X%
- [ ] **Vortex Indicator (VI+ / VI−)** — directional trend oscillator
- [ ] **Aroon / Aroon Oscillator** — time since last high/low
- [ ] **Schaff Trend Cycle (STC)** — MACD + stochastic cycle
- [ ] **Balance of Power (BOP)** — buyer/seller pressure per bar
- [ ] **SuperTrend AI** — clustering-based adaptive Supertrend
- [ ] **Elder Ray (Bull/Bear Power** — high/low minus EMA
- [ ] **Trix** — triple-smoothed rate of change
- [ ] **Gann HiLo Activator** — HiLo trail flip indicator
- [ ] **Ehlers Fisher Transform** — normalised to Gaussian tails
- [ ] **WaveTrend (LazyBear)** — momentum oscillator with overbought/oversold
- [ ] **Pivot Points (Standard)** — classic floor pivots, overlay
- [ ] **Pivot Points (Fibonacci)** — Fib-derived pivot levels
- [ ] **Pivot Points (Camarilla)** — Camarilla levels
- [ ] **Pivot Points (Woodie)** — Woodie levels
- [ ] **Pivot Points (DeMark)** — DeMark-adjusted levels
- [ ] **Envelope** — ±X% around an MA
- [ ] **Price Channel** — highest-high / lowest-low channel
- [ ] **Std Dev Channel** — regression + std-dev bands

## B. Oscillators

Already done ✅: RSI, MACD, Stochastic, Stochastic RSI, CCI, Momentum, ROC,
Williams %R, MFI, Awesome Oscillator, Standard Deviation.

- [ ] **Connors RSI** — RSI of RSI + percent-change RSI
- [ ] **True Strength Index (TSI)** — double-smoothed momentum
- [ ] **Ultimate Oscillator** — multi-period buying pressure
- [ ] **Stochastic Momentum Index (SMI)** — centre-line stochastic
- [ ] **Chaikin Oscillator** — AD line EMA difference
- [ ] **Elder Force Index** — volume × price change, EMA-smoothed
- [ ] **Acceleration/Deceleration (AC)** — AO minus its MA
- [ ] **Choppiness Index** — trend-directionality ratio
- [ ] **KST (Know Sure Thing)** — summed ROC smoothed
- [ ] **Coppock Curve** — long-term weighted ROC
- [ ] **Relative Vigor Index (RVI)** — close/open vs range
- [ ] **Vertical Horizontal Filter (VHF)** — trend vs chop
- [ ] **Psychological Line** — up-bars over N
- [ ] **Qstick** — N-period average of (close − open)
- [ ] **Volume Oscillator** — fast vol MA vs slow vol MA %
- [ ] **Historical Volatility** — log-return std dev annualised
- [ ] **Chaikin Volatility** — H-L EMA rate of change
- [ ] **Ulcer Index** — drawdown-depth volatility
- [ ] **Mass Index** — range expansion reversal detection
- [ ] **Correlation Coefficient** — vs another symbol
- [ ] **Divergence Indicator** — auto RSI/price divergence marks
- [ ] **RSI Divergence** — bear/bull divergence labels
- [ ] **NATR** — normalised ATR %
- [ ] **Schaff Trend Cycle** — (also in A if you prefer)

## C. Volume

Already done ✅: Volume, On-Balance Volume, MFI.

- [ ] **Accumulation/Distribution (ADI)** — cumulative CLV
- [ ] **Chaikin Money Flow (CMF)** — money flow over N bars
- [ ] **Ease of Movement (EOM)** — price/volume distance
- [ ] **Negative Volume Index (NVI)** — smart-money on down volume
- [ ] **Positive Volume Index (PVI)** — retail on up volume
- [ ] **Net Volume** — signed up/down volume columns
- [ ] **Volume Rate of Change** — volume ROC
- [ ] **Anchored VWAP** — VWAP from a chosen start bar
- [ ] **VWAP + Std Dev Bands** — session VWAP with ±1/±2 bands
- [ ] **Volume Profile (Visible Range)** — POC / VAH / VAL, per-bar volume distribution
- [ ] **Session Volume Profile** — per-session profile
- [ ] **Relative Volume at Time (RVT)** — volume vs same-time average
- [ ] **Cumulative Delta** — running bid/ask delta
- [ ] **Volume by Price** — horizontal volume-at-price histogram
- [ ] **Money Flow** — raw money flow line
- [ ] **Force Index** — (alias of Elder Force)

## D. Volatility & channels

Already done ✅: ATR.

- [ ] **ATR Bands** — ATR ± multiplier around price
- [ ] **Std Dev Bands** — SMA ± k·stddev
- [ ] **Keltner Channels (Trend-Intensity)** — ATR/ATR-ratio adaptive
- [ ] **Bollinger Bands %B** — price position inside BB
- [ ] **Bollinger Band Width** — band width oscillator
- [ ] **Donchian + ATR trailing**
- [ ] **Historical Volatility Oscillator**

## E. Bill Williams

Already done ✅: Alligator, Awesome Oscillator.

- [ ] **Fractals** — 5-bar swing high/low marks
- [ ] **Gator Oscillator** — Alligator jaw/lip distance
- [ ] **Accelerator Oscillator** — (also in B)
- [ ] **Market Facilitation Index (BW MFI)** — volume vs range
- [ ] **Super AO**

## F. Statistics / math

- [ ] **Linear Regression** — slope / intercept / R²
- [ ] **Percentile Rank** — rank of price in N-bar window
- [ ] **Median** — N-bar median
- [ ] **Mode** — N-bar mode
- [ ] **Covariance**
- [ ] **Root Mean Square**
- [ ] **Curve Fit** — polynomial fit overlay
- [ ] **Sine Wave / Tan** — trig transform
- [ ] **Per** — period of dominant cycle (Hilbert)

## G. Patterns & structure (TV built-in)

- [ ] **Head & Shoulders** — auto-detected, with neckline
- [ ] **Triangle Pattern** — auto converging trendlines
- [ ] **Three Drives Pattern**
- [ ] **Cypher Pattern**
- [ ] **Double Top / Bottom**
- [ ] **Bull/Bear Flag**
- [ ] **Elliott Impulse Wave (12345)**
- [ ] **Elliott Correction Wave (ABC)**
- [ ] **Elliott Triangle Wave**
- [ ] **XABCD Pattern** — harmonic projection
- [ ] **Bars Pattern** — replay a past segment
- [ ] **Date Range** — period shading
- [ ] **Bar Timer** — time left in bar

## H. Published / community indicators (behavioural ports)

> These are not Pine scripts (Pine can't be embedded — it's server-side at TradingView).
> Each is re-implemented from the published logic in JS, so it draws and behaves identically.

### ICT / Smart Money Concepts
- [ ] **Smart Money Concepts (full)** — BOS, CHoCH, structure, swing points
- [ ] **Order Blocks** — last opposing candle before displacement
- [ ] **Fair Value Gaps (FVG)** — 3-candle imbalance boxes
- [ ] **Liquidity Sweeps** — stop-hunt wick detection
- [ ] **Equal Highs / Equal Lows** — liquidity pool lines
- [ ] **Break of Structure (BOS) / Change of Character (CHoCH)**
- [ ] **Optimal Trade Entry (OTE)** — 0.618–0.79 Fib zone
- [ ] **Premium / Discount zones** — equilibrium shading
- [ ] **Killzones / Session Ranges** — London/NY/Asia boxes
- [ ] **Power of 3 (AMD)** — accumulation–manipulation–distribution
- [ ] **Silver Bullet** — time-based FVG window
- [ ] **Market Maker Models** — buy/sell model ranges
- [ ] **Inversion FVG (IFVG)** — reclaimed gaps
- [ ] **Turtle Soup / liquidity raid**
- [ ] **Session Anchors** — daily/weekly open lines (PD arrays)

### LuxAlgo-style toolkits
- [ ] **Price Action Concepts** — candle patterns + structure
- [ ] **Signals & Overlays** — trend/entry-exit confluence
- [ ] **Smart Money Concepts** — (ICT above, choose one)
- [ ] **Backtesting Engine overlay** — auto trade markers
- [ ] **Risk Management** — SL/TP/R:R shading
- [ ] **Automated Trendlines** — auto slope-fit lines
- [ ] **Support & Resistance (auto)** — cluster detection
- [ ] **Volume Profile (auto POC/VAH/VAL)**
- [ ] **Breakout / Momentum signals**
- [ ] **Volatility / Squeeze signals**

### LazyBear & classics
- [ ] **Squeeze Momentum** — BB inside KC, momentum histogram
- [ ] **Linear Regression Curve (LazyBear)**
- [ ] **Chandelier Exit (LazyBear)**
- [ ] **Stochastic Momentum Index (LazyBear)**
- [ ] **WaveTrend Oscillator (LazyBear)**
- [ ] **QQE (Quantitative Qualitative Estimation)** — smoothed RSI + ATR bands
- [ ] **Ehlers Super Smoother** — zero-lag filter
- [ ] **Ehlers Universal Oscillator**
- [ ] **Ehlers Roofing / Band-Pass filter**
- [ ] **Ehlers Auto-Correlation Periodogram**
- [ ] **Jurik Moving Average (JMA)** — low-lag adaptive
- [ ] **Gann HiLo Activator (LazyBear)**
- [ ] **KAMA (LazyBear)**
- [ ] **Stochastic Custom / Fast Stochastic**
- [ ] **RSI Custom (Connors variant)**

### Other widely used
- [ ] **Auto Fib Retracement + Extensions**
- [ ] **Auto Trend Lines**
- [ ] **Volume Weighted EMA (VWEMA)**
- [ ] **Trailing Stop Loss (ATR)**
- [ ] **Breakeven / R-multiple tracker**
- [ ] **Position Size Calculator**
- [ ] **Risk/Reward tool shading**
- [ ] **Delta / Cumulative Delta (footprint-style)**
- [ ] **Session Volume-Weighted Profile**
- [ ] **Heikin Ashi overlay** (already a chart type — indicator version optional)

---

## How to reply

Send me either:

1. **The names** — e.g. *"Order Blocks, Fair Value Gaps, Smart Money Concepts, Squeeze Momentum, QQE, KAMA, Chandelier Exit, Linear Regression Curve, WaveTrend, Volume Profile, Aroon, Connors RSI, Ehlers Fisher Transform, Fractals"*
2. **The file** with boxes ticked
3. **The section letters + numbers** — e.g. *"H1, H2, H4, H6, H12, H22, H26, H32, A2, A18, B4"*

I'll confirm the final list before building anything, then verify each one against the live
tradingview.com tab (same symbol, same timeframe) until the numbers and pixels match.
