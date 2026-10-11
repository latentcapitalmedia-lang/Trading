/* Canvas charting: sparklines for the results table and a candlestick chart. */
(function () {
  "use strict";

  const COLORS = {
    up: "#22c55e",
    down: "#ef4444",
    grid: "rgba(30,42,56,.85)",
    axis: "#7f8fa3",
    sma20: "#3b82f6",
    sma50: "#f59e0b",
    cross: "rgba(160,175,195,.5)",
  };

  function fit(canvas, height) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(120, canvas.clientWidth || canvas.parentElement.clientWidth || 600);
    const cssH = height;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH };
  }

  /* ---------------------------------------------------------------- spark */
  function spark(canvas, values, opts) {
    opts = opts || {};
    const color = opts.color || (values[values.length - 1] >= values[0] ? COLORS.up : COLORS.down);
    const { ctx, w, h } = fit(canvas, opts.height || 26);
    ctx.clearRect(0, 0, w, h);
    if (!values || values.length < 2) return;

    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const span = (max - min) || 1;
    const pad = 2.5;
    const x = (i) => (i / (values.length - 1)) * (w - 2) + 1;
    const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);

    // fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + "44");
    grad.addColorStop(1, color + "00");
    ctx.beginPath();
    ctx.moveTo(x(0), y(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
    ctx.lineTo(x(values.length - 1), h);
    ctx.lineTo(x(0), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    ctx.moveTo(x(0), y(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // last dot
    ctx.beginPath();
    ctx.arc(x(values.length - 1), y(values[values.length - 1]), 1.9, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /* ------------------------------------------------------------- candles */
  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      acc += values[i];
      if (i >= n) acc -= values[i - n];
      if (i >= n - 1) out[i] = acc / n;
    }
    return out;
  }

  function niceTicks(min, max, count) {
    if (!(max > min)) return [min];
    const raw = (max - min) / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
    return ticks.length ? ticks : [min, max];
  }

  function fmtPrice(v) {
    if (v === null || v === undefined || !isFinite(v)) return "";
    const a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    if (a >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
    if (a >= 0.01) return v.toFixed(4);
    return v.toPrecision(4);
  }

  function fmtCompact(v) {
    if (v === null || v === undefined || !isFinite(v)) return "";
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(2);
  }

  function timeLabel(ts, interval) {
    const d = new Date(ts * 1000);
    const intraday = /m|h/.test(interval);
    if (intraday) {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    if (/w|M/.test(interval)) {
      return d.toLocaleDateString(undefined, { year: "2-digit", month: "short" });
    }
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /**
   * Draw a candlestick chart with volume and SMA overlays.
   * @param {HTMLCanvasElement} canvas
   * @param {object} k  kline payload {time,open,high,low,close,volume}
   * @param {object} opts {interval, hover: index|null, showVolume}
   */
  function candles(canvas, k, opts) {
    opts = opts || {};
    const interval = opts.interval || "1d";
    const showVolume = opts.showVolume !== false;
    const height = opts.height || 420;
    const { ctx, w, h } = fit(canvas, height);
    ctx.clearRect(0, 0, w, h);

    const n = k.time.length;
    if (n < 2) {
      ctx.fillStyle = COLORS.axis;
      ctx.font = "13px system-ui";
      ctx.fillText("No data", 14, 24);
      return;
    }

    const padL = 8, padR = 74, padT = 12, padB = 22;
    const innerW = w - padL - padR;
    const volH = showVolume ? Math.round((h - padT - padB) * 0.2) : 0;
    const gap = showVolume ? 10 : 0;
    const priceH = h - padT - padB - volH - gap;

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (k.high[i] < lo) lo = k.high[i];
      if (k.high[i] > hi) hi = k.high[i];
    }
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;

    const step = innerW / n;
    const cw = Math.max(1, Math.min(11, step * 0.66));
    const X = (i) => padL + i * step + step / 2;
    const Y = (v) => padT + priceH - ((v - lo) / (hi - lo)) * priceH;

    // grid + price axis
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    const ticks = niceTicks(lo, hi, 6);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ticks.forEach((t) => {
      const y = Math.round(Y(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + innerW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.axis;
      ctx.textAlign = "left";
      ctx.fillText(fmtPrice(t), padL + innerW + 8, y);
    });

    // time axis
    const labelEvery = Math.max(1, Math.round(n / Math.max(3, Math.floor(innerW / 92))));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i < n; i += labelEvery) {
      const x = X(i);
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padT);
      ctx.lineTo(Math.round(x) + 0.5, padT + priceH);
      ctx.stroke();
      const text = timeLabel(k.time[i], interval);
      const half = ctx.measureText(text).width / 2 + 2;
      const tx = Math.min(Math.max(x, padL + half), padL + innerW - half);
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(text, tx, h - padB + 6);
    }

    // volume
    if (showVolume) {
      let vmax = 0;
      for (let i = 0; i < n; i++) if (k.volume[i] > vmax) vmax = k.volume[i];
      const vTop = padT + priceH + gap;
      for (let i = 0; i < n; i++) {
        const up = k.close[i] >= k.open[i];
        const bh = vmax ? (k.volume[i] / vmax) * volH : 0;
        ctx.fillStyle = up ? "rgba(34,197,94,.35)" : "rgba(239,68,68,.35)";
        ctx.fillRect(X(i) - cw / 2, vTop + volH - bh, cw, bh);
      }
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(padL, vTop - 0.5);
      ctx.lineTo(padL + innerW, vTop - 0.5);
      ctx.stroke();
    }

    // candles
    for (let i = 0; i < n; i++) {
      const up = k.close[i] >= k.open[i];
      const color = up ? COLORS.up : COLORS.down;
      const x = Math.round(X(i)) + 0.5;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, Y(k.high[i]));
      ctx.lineTo(x, Y(k.low[i]));
      ctx.stroke();
      const yo = Y(k.open[i]);
      const yc = Y(k.close[i]);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      if (up) {
        ctx.fillRect(x - cw / 2, top, cw, bh);
      } else {
        ctx.fillRect(x - cw / 2, top, cw, bh);
      }
    }

    // moving averages
    [
      { values: sma(k.close, 20), color: COLORS.sma20 },
      { values: sma(k.close, 50), color: COLORS.sma50 },
    ].forEach((line) => {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = line.values[i];
        if (v === null) continue;
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; }
        else ctx.lineTo(X(i), Y(v));
      }
      ctx.stroke();
    });

    // last price marker
    const last = k.close[n - 1];
    const lastUp = k.close[n - 1] >= k.open[n - 1];
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = lastUp ? "rgba(34,197,94,.6)" : "rgba(239,68,68,.6)";
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(Y(last)) + 0.5);
    ctx.lineTo(padL + innerW, Math.round(Y(last)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lastUp ? COLORS.up : COLORS.down;
    const lbl = fmtPrice(last);
    ctx.fillRect(padL + innerW + 4, Y(last) - 8, padR - 8, 16);
    ctx.fillStyle = "#0a0e13";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(lbl, padL + innerW + 8, Y(last));

    // crosshair
    if (opts.hover !== null && opts.hover !== undefined && opts.hover >= 0 && opts.hover < n) {
      const i = opts.hover;
      const x = Math.round(X(i)) + 0.5;
      ctx.strokeStyle = COLORS.cross;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, h - padB);
      ctx.stroke();
      const y = Math.round(Y(k.close[i])) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + innerW, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // date chip
      const label = timeLabel(k.time[i], interval);
      ctx.font = "11px ui-monospace, monospace";
      const tw = ctx.measureText(label).width + 12;
      const cx = Math.min(Math.max(x - tw / 2, padL), padL + innerW - tw);
      ctx.fillStyle = "rgba(22,32,44,.95)";
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.roundRect(cx, h - padB + 1, tw, 16, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#d8e1ec";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx + tw / 2, h - padB + 9);
    }

    canvas._geom = { padL, padT, innerW, priceH, step, n };
  }

  window.ChartKit = { spark, candles, fmtPrice, fmtCompact, sma, timeLabel };
})();
