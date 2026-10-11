/* chartink-crypto: scans, charts, watchlist, alerts and API pages. */
(function () {
  "use strict";

  const { $, $$, el, esc, api, toast, state, fmtPrice, fmtPct, fmtCompact, relTime, pages } = window.App;

  function goScreener(clause) {
    // Resolves true once the builder holds `clause`, false if it could not be
    // applied — callers use it to sequence "load then run" without a race.
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      const timer = setTimeout(() => settle(false), 8000);
      App.setPendingClause(clause, (ok) => { clearTimeout(timer); settle(ok); });
      if (location.hash === "#/screener") App.router();
      else location.hash = "#/screener";
    });
  }

  /* =============================================================== SCANS */
  pages.scans = function (view) {
    view.innerHTML = "";

    const search = el("input", { type: "text", placeholder: "Filter scans…", style: "min-width:200px" });
    const list = el("div", { class: "preset-list" });

    function paint() {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = "";
      const items = (state.presets || []).filter((p) =>
        !q || p.name.toLowerCase().includes(q) || p.clause.toLowerCase().includes(q) || p.cat.toLowerCase().includes(q)
      );
      if (!items.length) {
        list.appendChild(el("div", { class: "empty", text: "No scans match that filter." }));
        return;
      }
      items.forEach((p) => {
        list.appendChild(el("div", { class: "preset" }, [
          el("div", { class: "body" }, [
            el("div", { class: "row" }, [
              el("div", { class: "name", text: p.name }),
              el("span", { class: "badge b-" + p.cat.toLowerCase(), text: p.cat }),
            ]),
            el("div", { class: "clause", text: p.clause }),
            el("div", { class: "desc", text: p.desc || "" }),
          ]),
          el("div", { class: "row" }, [
            el("button", {
              text: "Open",
              onclick: () => goScreener(p.clause),
            }),
            el("button", {
              class: "primary", text: "Run",
              onclick: async () => {
                const ok = await goScreener(p.clause);
                if (ok === false) { toast("Could not load that scan", p.name, "err"); return; }
                App.runScan();
              },
            }),
          ]),
        ]));
      });
    }

    search.addEventListener("input", paint);

    view.appendChild(el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { text: "Scan library" }),
        el("span", { class: "spacer" }),
        el("span", {
          class: "hint",
          text: (function () {
            const all = state.presets || [];
            const mine = all.filter((p) => p.mine).length;
            const builtIn = all.length - mine;
            return mine ? `${builtIn} built-in · ${mine} saved by you` : `${builtIn} built-in scans`;
          })(),
        }),
        search,
      ]),
      el("div", { class: "card-body" }, [list]),
    ]));

    paint();
  };

  /* ============================================================== CHARTS */
  /* Where you left off — symbol, timeframe and bar count come back exactly
     as you exited, so opening Charts resumes the session instead of starting
     over on BTCUSDT. */
  const CHART_LAST = "cx.cv.last";
  function loadLastChart() {
    try {
      const v = JSON.parse(localStorage.getItem(CHART_LAST) || "null");
      if (v && typeof v.symbol === "string" && v.symbol) {
        return {
          symbol: v.symbol,
          interval: typeof v.interval === "string" && v.interval ? v.interval : "1d",
          limit: typeof v.limit === "number" ? v.limit : 300,
        };
      }
    } catch (e) { /* corrupt or unavailable — fall through */ }
    return { symbol: "BTCUSDT", interval: "1d", limit: 300 };
  }
  const chartState = loadLastChart();
  const TIMEFRAMES = ["15m", "1h", "4h", "1d", "1w"];
  /* 0 = ALL: the chart walks back to the symbol's very first bar. */
  const BAR_COUNTS = [100, 300, 500, 1000, 0];

  function rememberChart(s) {
    try { localStorage.setItem(CHART_LAST, JSON.stringify(s)); } catch (e) { /* quota */ }
  }

  /* true while a symbol change started by the chart itself is travelling
     through the hash, so those are not pushed onto the back history twice. */
  let chartNavigating = false;

  pages.chart = function (view, args) {
    /* #/chart reopens the last market you were on; #/chart/SOLUSDT opens that
       one. Timeframe and bar count always come from the stored session. */
    const next = args && args[0] ? args[0].toUpperCase() : chartState.symbol;
    const prev = { symbol: chartState.symbol, interval: chartState.interval, limit: chartState.limit };
    const fromChart = chartNavigating;
    chartNavigating = false;

    chartState.symbol = next;
    view.innerHTML = "";

    if (!window.ChartView || typeof window.ChartView.mount !== "function") {
      view.appendChild(el("div", {
        class: "error-box",
        text: "The chart engine failed to load — static/chartview.js is missing or broken.",
      }));
      view._cleanup = function () {};
      return;
    }

    /* A symbol change that did not originate inside the chart (browser
       back/forward, a link from the screener) still joins the ← history. */
    if (!fromChart && typeof window.ChartView.pushHistory === "function" && prev.symbol !== next) {
      window.ChartView.pushHistory(prev);
    }

    const stop = window.ChartView.mount(view, {
      symbol: chartState.symbol,
      interval: chartState.interval,
      limit: chartState.limit,
      timeframes: TIMEFRAMES,
      barCounts: BAR_COUNTS,
      api,
      toast,
      fmtPrice,
      fmtPct,
      fmtCompact,
      watchlist: function () { return (window.App && App.state.watchlist) || []; },
      onState: function (s) {
        chartState.symbol = s.symbol;
        chartState.interval = s.interval;
        chartState.limit = s.limit;
        rememberChart(s);
      },
      onNavigate: function (entry) {
        chartState.symbol = entry.symbol;
        chartState.interval = entry.interval;
        chartState.limit = entry.limit;
        chartNavigating = true;
        const hash = "#/chart/" + entry.symbol;
        if (location.hash === hash) { chartNavigating = false; App.router(); }
        else location.hash = hash;
      },
    });
    view._cleanup = typeof stop === "function" ? stop : function () {};
  };

  /* ========================================================= TRADINGVIEW */
  /* TradingView's own chart, framed. tradingview.com sends
     `frame-ancestors 'none'`, so the full site — your login, the publishers'
     scripts, the Pine you wrote there — refuses to be an iframe in any
     browser, and no amount of app-side work changes that: it is TradingView's
     own header. That half therefore opens as a real tab, which is what the
     button in the bar below does, deep-linked to the same symbol. What does
     frame is TradingView's own chart host at s.tradingview.com — the genuine
     TV engine (same renderer, drawings, symbol search and indicators menu),
     just unauthenticated. */
  const TV_INTERVALS = [
    ["1m", "1"], ["5m", "5"], ["15m", "15"], ["30m", "30"],
    ["1h", "60"], ["2h", "120"], ["4h", "240"],
    ["1d", "1D"], ["1w", "1W"], ["1M", "1M"],
  ];
  const TV_LAST = "cx.tv.last";

  function tvSymbol(sym) {
    // BTCUSDT -> BINANCE:BTCUSDT; an already-qualified symbol passes through.
    const s = String(sym || "BTCUSDT").toUpperCase().trim();
    return s.indexOf(":") > -1 ? s : "BINANCE:" + s;
  }
  function tvIv(iv) {
    const hit = TV_INTERVALS.filter((p) => p[0] === iv)[0];
    return hit ? hit[1] : "1D";
  }
  /* The widget's drawing toolbar — the whole left-hand column: Cross, Trend
     line, Fib retracement, Gann/Fibonacci, XABCD, Patterns, Long position,
     Brush, Geometric shapes, Text, Icons, Measure, Zoom, Magnet — only
     appears when `hide_side_toolbar` is spelled with underscores. The earlier
     `hidesidetoolbar` (no separators) is not a parameter TradingView knows,
     so it was accepted, ignored, and the column never rendered — which reads
     exactly like the chart having no tools at all. */
  function tvFrameUrl(sym, iv) {
    return "https://s.tradingview.com/widgetembed/?symbol=" + encodeURIComponent(tvSymbol(sym)) +
      "&interval=" + encodeURIComponent(tvIv(iv)) +
      "&theme=dark&style=1&timezone=Etc%2FUTC&symboledit=1&allow_symbol_change=1" +
      "&saveimage=1&withdateranges=1&hideideas=1&hide_side_toolbar=0&studies=%5B%5D";
  }
  function tvSiteUrl(sym, iv) {
    const base = "https://www.tradingview.com/chart/?theme=dark&symbol=" + encodeURIComponent(tvSymbol(sym));
    /* No interval = leave it out entirely. TradingView then opens on the
       visitor's own last-used timeframe, which is what "take me to the real
       site" should mean; a caller that knows better passes one. */
    return iv ? base + "&interval=" + encodeURIComponent(tvIv(iv)) : base;
  }

  /* What a row click opens — this app's own chart, TradingView's framed widget
     inside the app, or TradingView's real site in a new tab. Built here, next
     to the URL builders it needs, then published on `App` so the screener can
     render the same switch instead of growing a second copy of this logic.
     Persisted, because it is a preference about the whole app rather than any
     one page's state — and it is the switch TradingView has no room for in its
     own watchlist, where the chart choice is made once, globally. */
  const OPEN_NAMES = { chart: "the chart", tv: "TradingView", tvsite: "tradingview.com" };
  const OPEN_HINTS = {
    chart: "Click a row to open it on the chart",
    tv: "Click a row to open it on TradingView",
    tvsite: "Click a row to open it on tradingview.com in a new tab",
  };
  function openWithRead() {
    try {
      const v = localStorage.getItem("cx.openWith");
      if (v && OPEN_NAMES[v]) return v;
    } catch (e) { /* private mode */ }
    return "chart";
  }
  /* Open `symbol` the way the switch is currently set. The timeframe is always
     the one the in-app chart would have opened with, so a row click and a deep
     link land on the same bars either way. */
  function openSymbol(symbol) {
    const mode = openWithRead();
    if (mode === "tvsite") {
      /* A real tab. tradingview.com sends `frame-ancestors 'none'`, so a new
         tab is the only way to reach the full logged-in site — your account,
         your saved layouts, the Pine you wrote there. window.open from a click
         is a user gesture, so no browser blocks it. */
      window.open(tvSiteUrl(symbol, chartState.interval), "_blank", "noopener");
      return;
    }
    location.hash = (mode === "tv" ? "#/tradingview/" : "#/chart/") + symbol;
  }
  /* The three-way switch itself. Rebuilt from the stored value every time, so
     two of them on screen can never disagree; `onChange(mode)` fires after the
     write, letting a page refresh its own column hints and headers. */
  function openSeg(onChange) {
    const btns = {};
    const pick = (v) => {
      try { localStorage.setItem("cx.openWith", v); } catch (e) { /* quota */ }
      Object.keys(btns).forEach((k) => btns[k].classList.toggle("selected", k === v));
      if (onChange) onChange(v);
    };
    btns.chart = el("button", {
      class: "segmented__item", text: "Chart",
      title: "Rows open on this app's own chart", onclick: () => pick("chart"),
    });
    btns.tv = el("button", {
      class: "segmented__item", text: "TradingView",
      title: "Rows open on TradingView's chart, framed inside this app", onclick: () => pick("tv"),
    });
    btns.tvsite = el("button", {
      class: "segmented__item", text: "Open in TradingView",
      title: "Rows open the real tradingview.com in a new tab — signed in, with your own layouts and scripts",
      onclick: () => pick("tvsite"),
    });
    const current = openWithRead();
    Object.keys(btns).forEach((k) => btns[k].classList.toggle("selected", k === current));
    return el("div", { class: "segmented segmented--small wl-open" }, [btns.chart, btns.tv, btns.tvsite]);
  }
  App.OpenWith = {
    NAMES: OPEN_NAMES, HINTS: OPEN_HINTS,
    get: openWithRead, open: openSymbol, seg: openSeg,
  };

  function tvLast() {
    try {
      const v = JSON.parse(localStorage.getItem(TV_LAST) || "null");
      if (v && v.symbol) {
        return {
          symbol: String(v.symbol).toUpperCase(),
          interval: TV_INTERVALS.some((p) => p[0] === v.interval) ? v.interval : "1d",
        };
      }
    } catch (e) { /* corrupt or unavailable — fall through */ }
    return { symbol: chartState.symbol, interval: chartState.interval };
  }
  function tvRemember(symbol, interval) {
    try { localStorage.setItem(TV_LAST, JSON.stringify({ symbol: symbol, interval: interval })); } catch (e) { /* quota */ }
  }

  /* Two engines sit behind this one tab. TradingView will not serve its Pine
     Editor or its Bar Replay to an embedded chart at any setting — probed
     every control the widget exposes and neither exists — and its full chart
     sends `frame-ancestors 'none'`, so a browser refuses to nest it at all.
     That is TradingView's own server-side decision, not something an iframe
     parameter can undo. So "Full tools" runs this app's chart engine, which
     carries a real Pine interpreter and a bar-replay transport, and both
     features are therefore here without leaving the app. "TradingView" frames
     TradingView's genuine widget, which stays the way to sign in with an
     account of your own. */
  const TV_MODE_KEY = "cx.tv.mode";
  const TV_NOTE_FULL = "This app's chart engine — the same one behind the Charts tab. " +
    "Left column: every drawing tool (trend line, Fib retracement, Gann and Fibonacci, XABCD, " +
    "patterns, long position, brush, geometric shapes, text, icons, measure, zoom, magnet). " +
    "Pine Editor and bar replay are both on the right-hand rail: the editor runs a real Pine " +
    "Script interpreter over your own bars, and replay steps the price action candle by candle.";
  const TV_NOTE_TV = "TradingView's own chart, framed from s.tradingview.com — its genuine " +
    "renderer, drawing toolbar, symbol search and indicators menu. TradingView withholds its " +
    "Pine Editor and Bar Replay from embedded charts at every setting, and sends " +
    "`frame-ancestors 'none'` on the full site so a browser refuses to nest that page, which is " +
    "why those two live under Full tools.";
  function tvModeRead() {
    try { return localStorage.getItem(TV_MODE_KEY) === "tv" ? "tv" : "full"; }
    catch (e) { return "full"; }
  }
  function tvModeWrite(m) { try { localStorage.setItem(TV_MODE_KEY, m); } catch (e) { /* quota */ } }

  pages.tradingview = function (view, args) {
    view.innerHTML = "";
    const last = tvLast();
    let symbol = String((args && args[0]) || last.symbol).toUpperCase();
    let interval = last.interval;
    if (args && args[1] && TV_INTERVALS.some((p) => p[0] === args[1])) interval = args[1];
    let mode = tvModeRead();

    const symIn = el("input", {
      type: "text", value: symbol, style: "width:128px;text-transform:uppercase",
      title: "Symbol — the framed chart's own symbol search changes it too",
    });
    const ivSel = el("select", { style: "width:80px" });
    TV_INTERVALS.forEach((p) => ivSel.appendChild(el("option", { value: p[0], text: p[0] })));
    ivSel.value = interval;

    let frame = null;
    function makeFrame() {
      return el("iframe", {
        class: "tv-frame",
        title: "TradingView chart — " + symbol,
        src: tvFrameUrl(symbol, interval),
        allowtransparency: "true",
        scrolling: "no",
        frameborder: "0",
      });
    }
    function currentSym() { return (symIn.value || "BTCUSDT").toUpperCase().trim(); }

    const host = el("div", { class: "tv-host" });
    const note = el("span", {});
    const noteWrap = el("div", { class: "tv-note" }, [note]);
    let siteLink = null;
    let stopChart = null;

    /* The engine's own state, not ours: onState fires on every symbol,
       interval and bar-count change the chart makes itself — including from
       its internal symbol search — so it is the one honest mirror. Syncing
       from onNavigate instead would need the host to re-mount the chart to         effect a change, which would drag the router back to #/chart and off         this tab. */
    function chartOpts() {
      return {
        symbol: symbol,
        interval: interval,
        limit: chartState.limit,
        timeframes: TIMEFRAMES,
        barCounts: BAR_COUNTS,
        api, toast, fmtPrice, fmtPct, fmtCompact,
        watchlist: function () { return (window.App && App.state.watchlist) || []; },
        onState: function (s) {
          chartState.symbol = s.symbol;
          chartState.interval = s.interval;
          chartState.limit = s.limit;
          rememberChart(s);
          if (mode !== "full") return;
          symbol = s.symbol;
          if (document.activeElement !== symIn) symIn.value = s.symbol;
          if (TV_INTERVALS.some((p) => p[0] === s.interval)) {
            interval = s.interval;
            ivSel.value = s.interval;
          }
          tvRemember(s.symbol, s.interval);
        },
      };
    }

    const modeSeg = el("div", { class: "segmented segmented--small tv-mode" });
    const modeBtns = {};
    function setModeBtn() {
      Object.keys(modeBtns).forEach((k) => modeBtns[k].classList.toggle("selected", k === mode));
    }
    modeBtns.full = el("button", {
      class: "segmented__item", text: "Full tools",
      title: "This app's chart — every drawing tool, the indicators menu, a Pine Script " +
             "editor and bar replay, all on this page",
      onclick: () => show("full"),
    });
    modeBtns.tv = el("button", {
      class: "segmented__item", text: "TradingView",
      title: "TradingView's own chart, framed — the way to sign in with your account",
      onclick: () => show("tv"),
    });
    modeSeg.appendChild(modeBtns.full);
    modeSeg.appendChild(modeBtns.tv);

    function setNote(next) {
      note.textContent = next === "full" ? TV_NOTE_FULL : TV_NOTE_TV;
      if (siteLink) { if (siteLink.parentNode) siteLink.parentNode.removeChild(siteLink); siteLink = null; }
      if (next === "tv") {
        /* Sign-in still needs the real site, so the link stays — it just stops
           being the headline now that the features it used to promise are
           already on this page. */
        siteLink = el("button", {
          class: "tv-open-link", text: "Open on tradingview.com ↗",
          title: "The framed chart above is TradingView's widget, unauthenticated. This opens " +
                 "the same symbol on their own site in a new tab, where you can sign in.",
          onclick: () => window.open(tvSiteUrl(currentSym(), ivSel.value), "_blank", "noopener"),
        });
        noteWrap.appendChild(siteLink);
      }
    }

    function show(next) {
      mode = next;
      tvModeWrite(next);
      setModeBtn();
      setNote(next);
      host.innerHTML = "";
      /* mount() destroys whatever chart is live, but switching to the framed
         widget leaves nothing to replace it, so the instance has to be torn
         down by hand or its timers and data socket keep running unseen. */
      if (stopChart) { try { stopChart(); } catch (e) { /* noop */ } stopChart = null; }
      if (next === "full") {
        stopChart = window.ChartView.mount(host, chartOpts());
      } else {
        frame = makeFrame();
        host.appendChild(frame);
      }
    }

    function load() {
      symbol = currentSym();
      symIn.value = symbol;
      interval = ivSel.value;
      tvRemember(symbol, interval);
      try { history.replaceState(null, "", location.pathname + "#/tradingview/" + symbol); } catch (e) { /* noop */ }
      /* Full tools changes the live chart in place, so the layout, drawings
         and Pine studies already on it survive a symbol change. The framed
         widget needs a brand-new <iframe> instead: the widget sizes its canvas
         from its own first layout, and re-pointing an existing frame leaves
         that layout already done — so the chart comes back blank, with the
         toolbar drawn over unsized canvases. A fresh element lays out again. */
      if (mode === "full") {
        const c = window.ChartView.current;
        if (c && c.goToSymbol) {
          if (symbol !== chartState.symbol) c.goToSymbol(symbol);
          if (interval !== chartState.interval && c.changeInterval) c.changeInterval(interval);
        } else {
          show("full");
        }
      } else {
        const next = makeFrame();
        if (frame && frame.parentNode) frame.parentNode.replaceChild(next, frame);
        else host.appendChild(next);
        frame = next;
      }
    }
    symIn.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
    ivSel.addEventListener("change", load);

    view.appendChild(el("div", { class: "tv-wrap" }, [
      el("div", { class: "tv-bar" }, [
        el("span", { class: "tv-logo", text: "TradingView" }),
        el("span", { class: "tv-sep" }),
        symIn, ivSel,
        el("button", { class: "primary", text: "Load", onclick: load }),
        el("span", { class: "spacer" }),
        modeSeg,
      ]),
      noteWrap,
      host,
    ]));

    show(mode);

    view._cleanup = function () {
      if (stopChart) { try { stopChart(); } catch (e) { /* noop */ } stopChart = null; }
      /* The framed chart keeps a websocket open; park it rather than leave it
         running behind whatever page is opened next. */
      try { if (frame) frame.src = "about:blank"; } catch (e) { /* noop */ }
    };
  };

  /* =========================================================== WATCHLIST */
  // Six built-in groups — one per exchange plus Favourite — and up to five
  // custom ones, all showing the same twelve columns.  Rows arrive in two
  // phases: the snapshot paints straight from the universe, then a background
  // job fills the eight columns that need candle history.  The weekly MACD
  // among them is genuinely computed from weekly bars, so it can disagree
  // with the daily histogram sitting next to it.
  const COL_HINT = {
    symbol: "Click a row to open it on the chart",
    price: "Last traded price",
    volume_24h: "Quote volume over 24h, merged across every venue that lists it",
    volume_7d: "Sum of the last 7 daily bars' quote volume",
    change_24h: "Price change over the last 24 hours",
    change_7d: "Rate of change over 7 daily bars — roc(7)",
    macd_w: "MACD histogram (12,26,9) on the weekly chart",
    macd_d: "MACD histogram (12,26,9) on the daily chart",
    rsi: "RSI(14) on the daily chart",
    market_cap: "Circulating market capitalisation, from CoinGecko",
    volatility_w: "TradingView screener Volatility.W — mean daily range over 7 bars",
    volatility_d: "TradingView screener Volatility.D — true range of the last bar",
  };

  pages.watchlist = function (view) {
    view.innerHTML = "";

    let meta = null;      // GET /api/watchlist/groups payload
    let active = "binance";
    let limit = null;     // rows per group; null until meta supplies the default
    let cols = [];        // the twelve-column schema
    let rows = [];        // phase-0 rows, left in the server's order so
                          // clearing a sort has something to go back to
    let cells = {};       // symbol -> { column key -> <td> } so phase 2 rewrites
                          // cells in place instead of rebuilding the table
    let rowBy = {};       // symbol -> row; phase 2 writes its values back here,
                          // otherwise there is nothing to sort a computed column by
    let trBy = {};        // symbol -> <tr>; sorting moves these, never rebuilds
    let sortKey = null;   // column key currently sorted, null = server order
    let sortDir = 0;      // 1 ascending, -1 descending, 0 unsorted
    let token = 0;        // bumped when the group changes, killing stale polls
    let pollTimer = null;

    /* What a row click opens — the shared three-way switch from App.OpenWith,
       the same control the screener puts in its results toolbar, so choosing
       it on either page sets it for both. */
    const openPair = (symbol) => App.OpenWith.open(symbol);
    const openSeg = App.OpenWith.seg((v) => {
      COL_HINT.symbol = App.OpenWith.HINTS[v];
      updateHeaders();
      toast("Opening pairs in " + App.OpenWith.NAMES[v], "", "", 2200);
    });
    COL_HINT.symbol = App.OpenWith.HINTS[App.OpenWith.get()];

    const input = el("input", {
      type: "text", placeholder: "Star a symbol…",
      style: "width:130px;text-transform:uppercase",
    });
    const starBtn = el("button", { text: "☆ Add", onclick: starInput });
    const limitSel = el("select", { style: "width:96px" });
    const chipHost = el("div", { class: "wl-chips" });
    const statusHost = el("div", { class: "wl-status", style: "display:none" });
    const body = el("div", { id: "watchBody" });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") starInput(); });

    view.appendChild(el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { text: "Watchlist" }),
        el("span", { class: "hint wl-openhint", text: "open pairs in" }),
        openSeg,
        el("span", { class: "spacer" }),
        input, starBtn, limitSel,
        el("button", { text: "↻ Refresh", onclick: () => loadGroups() }),
      ]),
      chipHost, statusHost, body,
    ]));

    /* ---------------------------------------------------------- groups */
    function groupsOf() { return (meta && meta.groups) || []; }

    function current() {
      return groupsOf().filter((g) => g.id === active)[0];
    }

    function metaUrl() { return "/api/watchlist/groups" + (limit ? "?limit=" + limit : ""); }

    function renderChips() {
      chipHost.innerHTML = "";
      groupsOf().forEach((g) => {
        const chip = el("span", {
          class: "wl-chip" + (g.id === active ? " on" : "") + (g.venue ? " v-" + g.venue : ""),
          onclick: () => { if (g.id !== active) switchGroup(g.id); },
        }, [
          el("b", { text: g.name }),
          el("i", { text: String((g.symbols || []).length) }),
        ]);
        if (g.kind === "custom" && g.id === active) {
          const tools = el("i", { class: "wl-tools" });
          tools.appendChild(el("button", {
            class: "icon", text: "✎", title: "Edit group",
            onclick: (e) => { e.stopPropagation(); groupModal(g); },
          }));
          tools.appendChild(el("button", {
            class: "icon danger", text: "✕", title: "Delete group",
            onclick: (e) => { e.stopPropagation(); confirmDelete(g); },
          }));
          chip.appendChild(tools);
        }
        chipHost.appendChild(chip);
      });

      const used = (meta && meta.used_custom) || 0;
      const max = (meta && meta.max_custom) || 5;
      const full = used >= max;
      chipHost.appendChild(el("span", {
        class: "wl-chip add" + (full ? " full" : ""),
        text: full ? used + "/" + max + " custom groups" : "+ add group",
        title: full
          ? "You have added the maximum of " + max + " custom groups"
          : "Add a custom group (" + used + " of " + max + " used)",
        onclick: () => { if (!full) groupModal(null); },
      }));
    }

    function buildLimitSel(m) {
      limitSel.innerHTML = "";
      (m.limits || []).forEach((n) => {
        limitSel.appendChild(el("option", { value: String(n), text: n ? n + " rows" : "All" }));
      });
      if (limit === null) limit = m.default_limit;
      limitSel.value = String(limit);
      limitSel.onchange = () => { limit = Number(limitSel.value); loadGroups(); };
    }

    async function loadGroups() {
      try {
        meta = await api(metaUrl());
      } catch (e) {
        body.innerHTML = '<div class="error-box">' + esc(e.message) + "</div>";
        return;
      }
      active = meta.active;
      buildLimitSel(meta);
      renderChips();
      await loadRows();
    }

    // Metadata only — used after a star toggles so the Favourite chip's count
    // is right without tearing down the table the user is looking at. It has
    // to wait for the star's POST to land first, or the count reads stale.
    function refreshMeta() {
      Promise.resolve(App.watchSynced())
        .then(() => api(metaUrl()))
        .then((m) => {
          meta = m;
          renderChips();
          if (active === "favourite") loadRows();
        })
        .catch(() => { /* best effort; the next refresh catches up */ });
    }

    async function switchGroup(id) {
      active = id;
      renderChips();
      try {
        await api("/api/watchlist/groups/" + encodeURIComponent(id) + "/activate", { method: "POST" });
      } catch (e) { /* the switch still holds for this session */ }
      loadRows();
    }

    /* ------------------------------------------------------------- rows */
    async function loadRows() {
      const mine = ++token;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (!meta) return;
      body.innerHTML = '<div class="empty">loading…</div>';
      setStatus("");
      try {
        const out = await api(
          "/api/watchlist/groups/" + encodeURIComponent(active) + "?limit=" + (limit || "")
        );
        if (mine !== token) return;
        rows = out.rows || [];
        cols = out.columns || cols;
        paintTable();
        startCompute(mine);
      } catch (e) {
        if (mine !== token) return;
        body.innerHTML = '<div class="error-box">' + esc(e.message) + "</div>";
      }
    }

    /* ------------------------------------------------- phase 2: the job */
    function startCompute(mine) {
      if (!rows.length) { setStatus(""); return; }
      setStatus("Loading indicators…", 0, rows.length);
      // Send the exact symbols phase 0 painted so both halves agree.
      api("/api/watchlist/values", {
        method: "POST",
        body: { symbols: rows.map((r) => r.symbol) },
      }).then((start) => {
        if (mine === token) poll(start.job_id, start.id_to_key || {}, mine);
      }).catch((e) => {
        if (mine === token) setStatus("Indicator job failed: " + e.message, 0, 0, true);
      });
    }

    function poll(jobId, id2key, mine) {
      api("/api/watchlist/values/" + jobId).then((job) => {
        if (mine !== token) return;
        merge(job.values || {}, id2key);
        if (job.status === "done") { setStatus(""); return; }
        if (job.status === "error") {
          setStatus("Indicator job failed: " + (job.error || "unknown"), 0, 0, true);
          return;
        }
        setStatus("Loading indicators…", job.done || 0, job.total || rows.length);
        pollTimer = setTimeout(() => poll(jobId, id2key, mine), 900);
      }).catch((e) => {
        if (mine === token) setStatus("Indicator job failed: " + e.message, 0, 0, true);
      });
    }

    function merge(values, id2key) {
      let touched = false;
      Object.keys(values).forEach((symbol) => {
        const bucket = cells[symbol];
        if (!bucket) return;
        const row = rowBy[symbol];
        const vals = values[symbol];
        Object.keys(vals).forEach((cid) => {
          const key = id2key[cid] || cid;
          const col = colByKey(key);
          if (!bucket[key] || !col) return;
          setCell(bucket[key], col, vals[cid]);
          if (row) row[key] = vals[cid];
          touched = true;
        });
      });
      // the sort source just moved underneath an active sort — settle it
      if (touched && sortKey) applySort();
    }

    function colByKey(key) {
      return cols.filter((c) => c.key === key)[0];
    }

    /* ----------------------------------------------------------- sorting */
    function isMissing(v) {
      return v === null || v === undefined || v === "";
    }

    // Missing values pin to the bottom whichever way we are sorting, so a
    // column that is still filling never shoves a wall of dashes to the top
    // of a descending sort.
    function cmp(a, b, key, dir) {
      const av = a[key], bv = b[key];
      const am = isMissing(av), bm = isMissing(bv);
      if (am || bm) return am ? (bm ? 0 : 1) : -1;
      let c;
      if (key === "symbol") c = String(av).localeCompare(String(bv));
      else {
        const na = Number(av), nb = Number(bv);
        c = (isNaN(na) || isNaN(nb))
          ? String(av).localeCompare(String(bv))
          : na - nb;
      }
      // equal values keep the server's own ranking rather than scrambling
      return c !== 0 ? c * dir : String(a.symbol).localeCompare(String(b.symbol));
    }

    // Reorders the existing <tr>s instead of rebuilding: phase-2 values live
    // in the DOM cells, so a rebuild would throw them away.
    function applySort() {
      const tbody = body.querySelector(".wl-table tbody");
      if (!tbody) return;
      if (!sortKey) {
        rows.forEach((r) => tbody.appendChild(trBy[r.symbol]));
        return;
      }
      // Sorting a column nothing has filled yet is a no-op — leave the
      // server's order alone rather than collapsing to alphabetical.
      if (rows.every((r) => isMissing(r[sortKey]))) return;
      rows.slice()
        .sort((a, b) => cmp(a, b, sortKey, sortDir))
        .forEach((r) => { const tr = trBy[r.symbol]; if (tr) tbody.appendChild(tr); });
    }

    // 1st click ascending, 2nd descending, 3rd clears it.
    function clickSort(key) {
      if (sortKey !== key) { sortKey = key; sortDir = 1; }
      else if (sortDir === 1) sortDir = -1;
      else { sortKey = null; sortDir = 0; }
      updateHeaders();
      applySort();
    }

    function updateHeaders() {
      const ths = body.querySelectorAll(".wl-table thead th");
      cols.forEach((c, i) => {
        const th = ths[i];
        if (!th) return;
        const on = sortKey === c.key;
        th.classList.toggle("sorted", on);
        th.classList.toggle("asc", on && sortDir === 1);
        th.classList.toggle("desc", on && sortDir === -1);
        th.title = (COL_HINT[c.key] || "") + (on
          ? (sortDir === 1
              ? " — sorted ascending, click for descending"
              : " — sorted descending, click to clear the sort")
          : " — click to sort ascending");
      });
    }

    /* ------------------------------------------------------------ table */
    function paintTable() {
      cells = {};
      rowBy = {};
      trBy = {};
      if (!rows.length) { body.innerHTML = emptyState(); return; }

      const table = el("table", { class: "data wl-table" });
      table.appendChild(el("thead", {}, [el("tr", {}, cols.map((c) =>
        el("th", {
          class: (c.key === "symbol" ? "l " : "") + "sortable",
          text: c.title,
          onclick: () => clickSort(c.key),
        }, [el("i", { class: "sort-i" })]))),
      ]));

      const tbody = el("tbody");
      rows.forEach((r) => {
        const bucket = {};
        const tds = cols.map((c) => {
          const td = el("td", { class: c.key === "symbol" ? "l" : "" });
          bucket[c.key] = td;
          return td;
        });
        const tr = el("tr", {
          onclick: () => { openPair(r.symbol); },
        }, tds);
        tbody.appendChild(tr);
        cells[r.symbol] = bucket;
        rowBy[r.symbol] = r;
        trBy[r.symbol] = tr;
        cols.forEach((c) => setCell(bucket[c.key], c, r[c.key]));
      });
      table.appendChild(tbody);

      body.innerHTML = "";
      body.appendChild(el("div", { class: "table-wrap" }, [table]));
      updateHeaders();
      applySort();
    }

    function setCell(td, col, value) {
      if (td._written && td._v === value) return;   // poll re-sends known cells
      td._written = true;
      td._v = value;
      td.textContent = "";
      td.className = col.key === "symbol" ? "l" : "";

      if (value === null || value === undefined || value === "") {
        td.classList.add("dim");
        td.textContent = "–";
        return;
      }
      if (col.key === "symbol") {
        const on = App.isWatched(value);
        td.appendChild(el("button", {
          class: "icon wl-star" + (on ? " on" : ""),
          text: on ? "★" : "☆",
          title: on ? "Remove from Favourite" : "Star for the Favourite group",
          onclick: (e) => { e.stopPropagation(); toggleStar(value); },
        }));
        td.appendChild(el("span", { class: "sym", text: value }));
        return;
      }
      if (col.fmt === "price") { td.textContent = fmtPrice(value); return; }
      if (col.fmt === "usd") { td.textContent = value ? "$" + fmtCompact(value) : "–"; return; }
      if (col.key === "macd_w" || col.key === "macd_d") {
        // Four-colour MACD cells: a green + or red − badge beside the number.
        const up = value >= 0;
        td.classList.add(up ? "pos" : "neg");
        td.appendChild(el("span", { class: "macd-badge " + (up ? "up" : "down"),
                                    text: up ? "+" : "\u2212" }));
        td.appendChild(el("span", { text: Math.abs(Number(value)).toPrecision(4) }));
        return;
      }
      if (col.key === "change_24h" || col.key === "change_7d") {
        td.classList.add(value >= 0 ? "pos" : "neg");
        td.textContent = fmtPct(value);
        return;
      }
      td.textContent = Number(value).toFixed(col.fmt === "num4" ? 4 : 2);
    }

    function toggleStar(symbol) {
      App.toggleWatch(symbol);
      const td = cells[symbol] && cells[symbol].symbol;
      const col = colByKey("symbol");
      if (td && col) { delete td._written; delete td._v; setCell(td, col, symbol); }
      refreshMeta();
    }

    function starInput() {
      const raw = input.value.trim().toUpperCase();
      if (!raw) return;
      const s = /USDT$/.test(raw) ? raw : raw + "USDT";
      if (App.isWatched(s)) { toast("Already watching", s); return; }
      App.toggleWatch(s);
      input.value = "";
      refreshMeta();
    }

    function emptyState() {
      const g = current();
      if (active === "favourite") {
        return '<div class="empty"><div class="big">☆</div>No favourites yet.<br>'
          + '<span class="hint">Star a coin here, or in the screener results.</span></div>';
      }
      if (g && g.kind === "custom") {
        return '<div class="empty"><div class="big">⌗</div>This group has no symbols.<br>'
          + '<span class="hint">Use ✎ on the chip to add some.</span></div>';
      }
      return '<div class="empty"><div class="big">∅</div>No halal coins on this exchange yet.</div>';
    }

    function setStatus(text, done, total, isError) {
      if (!text) { statusHost.innerHTML = ""; statusHost.style.display = "none"; return; }
      statusHost.style.display = "";
      statusHost.className = "wl-status" + (isError ? " err" : "");
      statusHost.innerHTML = "";
      statusHost.appendChild(el("span", { text: text }));
      if (total) {
        const pct = Math.max(0, Math.min(100, Math.round(((done || 0) / total) * 100)));
        statusHost.appendChild(el("div", { class: "wl-bar" }, [
          el("i", { style: "width:" + pct + "%" }),
        ]));
        statusHost.appendChild(el("b", { text: (done || 0) + "/" + total }));
      }
    }

    /* ------------------------------------------------------- CRUD modals */
    function groupModal(group) {
      const editing = !!group;
      const name = el("input", {
        type: "text", placeholder: "e.g. Majors", style: "width:100%",
        value: editing ? group.name : "",
      });
      const syms = el("textarea", { rows: "4", style: "width:100%",
                                    placeholder: "BTCUSDT, ETHUSDT, SOLUSDT" });
      if (editing) syms.value = (group.symbols || []).join(", ");
      const err = el("div", { class: "error-box", style: "display:none" });

      const close = App.modal({
        title: editing ? "Edit group" : "New group",
        body: [
          el("div", {}, [
            el("label", { text: "Name" }), name,
          ]),
          el("div", {}, [
            el("label", { text: "Symbols (comma or space separated)" }),
            el("p", { class: "hint",
                      text: "Exchange groups fill themselves from that platform's halal coins — only custom groups need a list." }),
            syms,
          ]),
          err,
        ],
        actions: [
          { label: "Cancel" },
          {
            label: editing ? "Save" : "Create", kind: "primary", close: false,
            onClick: () => {
              err.style.display = "none";
              err.textContent = "";
              const list = syms.value.split(/[\s,]+/)
                .map((s) => s.trim().toUpperCase()).filter(Boolean);
              const url = editing
                ? "/api/watchlist/groups/" + encodeURIComponent(group.id)
                : "/api/watchlist/groups";
              api(url, { method: editing ? "PUT" : "POST",
                         body: { name: name.value, symbols: list } })
                .then(() => { close(); loadGroups(); })
                .catch((e) => { err.textContent = e.message; err.style.display = ""; });
              return false;
            },
          },
        ],
      });
    }

    function confirmDelete(group) {
      App.modal({
        title: "Delete " + group.name + "?",
        body: [el("p", { text: "The group and its symbol list are removed. "
                               + "Coins you starred stay in the Favourite group." })],
        actions: [
          { label: "Cancel" },
          {
            label: "Delete", kind: "danger",
            onClick: () => {
              api("/api/watchlist/groups/" + encodeURIComponent(group.id),
                  { method: "DELETE" })
                .then((out) => { active = out.active || "binance"; loadGroups(); })
                .catch((e) => toast("Could not delete group", e.message));
            },
          },
        ],
      });
    }

    /* ------------------------------------------------------------ start */
    loadGroups();
    view._cleanup = () => {
      token += 1;                       // stops any poll still in flight
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    };
  };

  /* =============================================================== ALERTS */
  pages.alerts = function (view) {
    view.innerHTML = "";

    const nameInput = el("input", { type: "text", placeholder: "My oversold scan", style: "width:100%" });
    const clauseInput = el("textarea", { rows: "4", style: "width:100%", placeholder: "[rsi(14)] < 30 and [volume_ratio(20)] > 2" });
    const intervalSel = el("select", { style: "width:100%" },
      [["15m", "Every 15 minutes"], ["1h", "Every hour"], ["4h", "Every 4 hours"],
       ["1d", "Every day"], ["1w", "Every week"]].map((p) => el("option", { value: p[0], text: p[1] })));
    intervalSel.value = "1d";
    const venueSel = el("select", { style: "width:100%" },
      [["", "All five exchanges"], ["binance", "Binance"], ["bybit", "Bybit"], ["kucoin", "KuCoin"],
       ["bitget", "Bitget"], ["okx", "OKX"]]
        .map((p) => el("option", { value: p[0], text: p[1] })));
    const createBtn = el("button", {
      class: "primary", text: "Create alert",
      onclick: async () => {
        if (!clauseInput.value.trim()) { toast("Clause required", "Enter a scan clause.", "err"); return; }
        try {
          await api("/api/alerts", {
            method: "POST",
            body: {
              name: nameInput.value || "Untitled scan",
              clause: clauseInput.value,
              interval: intervalSel.value,
              venue: venueSel.value || null,
            },
          });
          toast("Alert created", nameInput.value || "Untitled scan", "ok");
          nameInput.value = ""; clauseInput.value = "";
          loadAlerts();
        } catch (e) { toast("Could not create alert", e.message, "err"); }
      },
    });

    const tokenInput = el("input", { type: "password", placeholder: "123456:ABC-DEF…", style: "width:100%" });
    const chatInput = el("input", { type: "text", placeholder: "-1001234567890", style: "width:100%" });
    const cadenceInput = el("input", { type: "number", min: "60", step: "30", style: "width:100%" });
    const uniInput = el("input", { type: "number", min: "10", max: "1000", step: "10", style: "width:100%" });

    const saveBtn = el("button", {
      text: "Save settings",
      onclick: async () => {
        try {
          const body = {
            telegram_chat_id: chatInput.value.trim(),
            cadence_seconds: parseInt(cadenceInput.value, 10) || 300,
            universe: parseInt(uniInput.value, 10) || 150,
          };
          if (tokenInput.value.trim()) body.telegram_token = tokenInput.value.trim();
          const s = await api("/api/settings", { method: "POST", body });
          applySettings(s);
          toast("Settings saved", "", "ok");
        } catch (e) { toast("Could not save", e.message, "err"); }
      },
    });

    const testBtn = el("button", {
      text: "Send test message",
      onclick: async () => {
        try {
          const r = await api("/api/settings/test-telegram", { method: "POST", body: {} });
          toast(r.ok ? "Test message sent" : "Telegram error", r.ok ? "" : (r.error || "check token + chat id"), r.ok ? "ok" : "err");
        } catch (e) { toast("Telegram error", e.message, "err"); }
      },
    });

    const notifyBtn = el("button", {
      text: "Enable browser notifications",
      onclick: async () => {
        if (!window.Notification) { toast("Not supported", "This browser has no Notification API.", "err"); return; }
        const perm = await Notification.requestPermission();
        toast(perm === "granted" ? "Notifications enabled" : "Permission not granted", "", perm === "granted" ? "ok" : "err");
      },
    });

    function applySettings(s) {
      state.settings = s;
      tokenInput.value = s.telegram_token || "";
      chatInput.value = s.telegram_chat_id || "";
      cadenceInput.value = s.cadence_seconds || 300;
      uniInput.value = s.universe || 150;
    }

    const feed = el("div", { class: "feed" });
    const alertList = el("div", {});
    const statusLine = el("div", { class: "hint", style: "padding:10px 14px;border-top:1px solid var(--line)", text: "" });

    view.appendChild(el("div", { class: "split" }, [
      el("div", {}, [
        el("div", { class: "card", style: "margin-bottom:16px" }, [
          el("div", { class: "card-head", text: "New alert" }),
          el("div", { class: "card-body" }, [
            el("label", { class: "field-label", text: "Name" }), nameInput,
            el("div", { style: "height:11px" }),
            el("label", { class: "field-label", text: "Scan clause" }), clauseInput,
            el("div", { class: "grid2", style: "margin-top:11px" }, [
              el("div", {}, [el("label", { class: "field-label", text: "Check every" }), intervalSel]),
              el("div", {}, [el("label", { class: "field-label", text: "Exchange segment" }), venueSel]),
            ]),
            el("div", { class: "hint", style: "margin-top:8px", text: "Spot pairs only — halal screening follows the screener setting." }),
            el("div", { class: "hint", style: "margin-top:7px", html: 'Use the <a href="#/screener">screener</a> to build a clause, then paste it here.' }),
            el("div", { class: "row", style: "margin-top:12px" }, [createBtn]),
          ]),
        ]),
        el("div", { class: "card" }, [
          el("div", { class: "card-head", text: "Notification settings" }),
          el("div", { class: "card-body" }, [
            el("label", { class: "field-label", text: "Telegram bot token" }), tokenInput,
            el("div", { style: "height:11px" }),
            el("label", { class: "field-label", text: "Telegram chat id" }), chatInput,
            el("div", { class: "grid2", style: "margin-top:11px" }, [
              el("div", {}, [el("label", { class: "field-label", text: "Check every (seconds)" }), cadenceInput]),
              el("div", {}, [el("label", { class: "field-label", text: "Coins per alert" }), uniInput]),
            ]),
            el("div", { class: "row", style: "margin-top:12px" }, [saveBtn, testBtn]),
            el("div", { class: "row", style: "margin-top:8px" }, [notifyBtn]),
            el("div", { class: "hint", style: "margin-top:9px", text: "Create a bot with @BotFather, then message it once and read your chat id from getUpdates." }),
          ]),
        ]),
      ]),
      el("div", {}, [
        el("div", { class: "card", style: "margin-bottom:16px" }, [
          el("div", { class: "card-head" }, [
            el("span", { text: "Your alerts" }),
            el("span", { class: "spacer" }),
            el("button", { class: "ghost", text: "▶ Check now", onclick: async () => {
              toast("Checking alerts…", "this may take a few seconds");
              try { const r = await api("/api/alerts/run", { method: "POST", body: {} }); toast("Check complete", `${r.checked} alerts · ${r.notified} new matches`, "ok"); loadAlerts(); }
              catch (e) { toast("Check failed", e.message, "err"); }
            } }),
          ]),
          alertList, statusLine,
        ]),
        el("div", { class: "card" }, [
          el("div", { class: "card-head", text: "Recent notifications" }),
          feed,
        ]),
      ]),
    ]));

    async function loadAlerts() {
      try {
        const res = await api("/api/alerts");
        applySettings(res.settings || {});
        const alerts = res.alerts || [];

        alertList.innerHTML = "";
        if (!alerts.length) {
          alertList.appendChild(el("div", { class: "empty", text: "No alerts yet. Create one on the left." }));
        }
        alerts.forEach((a) => {
          const venueLabel = a.venue
            ? (a.venue === "kucoin" ? "KuCoin" : a.venue.charAt(0).toUpperCase() + a.venue.slice(1))
            : "All exchanges";
          const halalOn = !!(state.settings && state.settings.halal_only);
          const toggle = el("button", {
            class: "switch" + (a.enabled ? " on" : ""),
            title: a.enabled ? "Enabled — click to pause" : "Paused — click to enable",
            onclick: async () => {
              try {
                await api("/api/alerts/" + a.id, { method: "PUT", body: { enabled: !a.enabled } });
                loadAlerts();
              } catch (e) { toast("Update failed", e.message, "err"); }
            },
          });

          alertList.appendChild(el("div", { class: "alert-row" }, [
            toggle,
            el("div", { class: "body" }, [
              el("div", { class: "name", text: a.name }),
              el("div", { class: "clause", text: a.clause }),
              el("div", { class: "alert-scope" }, [
                el("span", {
                  class: "venue-chip" + (a.venue ? " v-" + a.venue : ""),
                  text: venueLabel,
                  title: a.venue
                    ? "Runs only against " + venueLabel + " spot pairs"
                    : "Runs against Binance, Bybit and KuCoin spot pairs",
                }),
                el("span", {
                  class: "halal-badge " + (halalOn ? "yes" : "no"),
                  title: halalOn
                    ? "Only coins marked compliant by 3 of the 5 platforms are scanned"
                    : "Halal screen is off — every spot pair is scanned",
                }, [el("i", { text: halalOn ? "✓" : "·" }), el("b", { text: halalOn ? "Halal only" : "All coins" })]),
                el("span", { class: "spot-badge", text: "Spot", title: "Spot buying only — no futures, no shorting" }),
              ]),
              el("div", { class: "hint", text: `${a.interval} · top ${a.universe} · last run ${relTime(a.last_run)} · ${a.last_count == null ? "no baseline yet" : a.last_count + " matched"}` }),
            ]),
            el("button", {
              class: "icon danger", text: "✕", title: "Delete alert",
              onclick: async () => {
                try { await api("/api/alerts/" + a.id, { method: "DELETE" }); loadAlerts(); }
                catch (e) { toast("Delete failed", e.message, "err"); }
              },
            }),
          ]));
        });

        const st = res.status || {};
        statusLine.innerHTML =
          `engine: ${st.running ? "<b>running</b>" : "idle"} · last pass ${relTime(st.last_run)} · ` +
          `${st.alerts || 0} alert(s) · ${st.pending || 0} pending` +
          (st.last_error ? ` · <span class="neg">${esc(st.last_error)}</span>` : "");

        const pending = await api("/api/alerts/pending").catch(() => ({ items: [] }));
        feed.innerHTML = "";
        const items = pending.items || [];
        if (!items.length) feed.appendChild(el("div", { class: "empty", text: "Nothing yet. New matches show up here." }));
        items.slice(0, 25).forEach((i) => {
          feed.appendChild(el("div", { class: "feed-item" }, [
            el("span", { class: "t", text: relTime(i.time) }),
            el("b", { text: i.symbol }),
            el("span", { class: "muted", text: i.alert + (i.price ? " @ " + fmtPrice(i.price) : "") }),
          ]));
        });
      } catch (e) {
        toast("Could not load alerts", e.message, "err");
      }
    }

    loadAlerts();
    const timer = setInterval(loadAlerts, 20000);
    view._cleanup = () => clearInterval(timer);
  };

  /* ================================================================== API */
  const ENDPOINTS = [
    ["GET", "/api/health", "Liveness check.", `curl http://127.0.0.1:5000/api/health`],
    ["GET", "/api/fields", "Every field usable inside a clause, grouped by category, with parameter ranges."],
    ["GET", "/api/presets", "The built-in scan library."],
    ["GET", "/api/parse?clause=…", "Parse a clause and return its AST plus the normalised clause text.",
      `curl --get --data-urlencode "clause=[rsi(14)] < 30 or [sma(20)] crossed above [sma(50)]" \\\n     http://127.0.0.1:5000/api/parse`],
    ["GET", "/api/validate?clause=…", "Validate a clause without scanning anything."],
    ["GET", "/api/universe?size=400", "Top USDT pairs by 24h quote volume, with a price snapshot."],
    ["GET", "/api/ticker?symbols=BTCUSDT,ETHUSDT", "24h ticker for an explicit list of symbols."],
    ["GET", "/api/klines?symbol=BTCUSDT&interval=1d&limit=400", "Raw OHLCV candles.",
      `curl "http://127.0.0.1:5000/api/klines?symbol=BTCUSDT&interval=1h&limit=200"`],
    ["GET", "/api/chart/BTCUSDT?interval=1d&limit=300", "Candles shaped for the chart view."],
    ["POST", "/api/scan", "Start a scan in the background; returns a job id to poll.",
      `curl -X POST http://127.0.0.1:5000/api/scan \\\n     -H "Content-Type: application/json" \\\n     -d '{"clause":"[rsi(14)] < 30","interval":"1d","universe":200}'`],
    ["GET", "/api/scan/<job_id>", "Poll scan progress and fetch results when status is \"done\"."],
    ["POST", "/api/scan/sync", "Blocking scan — the simplest thing to call from a script.",
      `curl -X POST http://127.0.0.1:5000/api/scan/sync \\\n     -H "Content-Type: application/json" \\\n     -d '{"clause":"[macd_histogram(12,26,9)] > 0","universe":100}'`],
    ["POST", "/screener/process", "Chartink-compatible endpoint. Send scan_clause as form data, JSON or a query string; add format=html or format=csv.",
      `curl -X POST http://127.0.0.1:5000/screener/process \\\n     -d "scan_clause=[rsi(14)] < 30 and [volume_ratio(20)] > 2" \\\n     -d "universe=200" \\\n     -d "format=csv"`],
    ["GET", "/api/watchlist", "Current watchlist."],
    ["POST", "/api/watchlist", "Replace the watchlist: {\"symbols\":[\"BTCUSDT\"]}."],
    ["GET/POST", "/api/alerts", "List alerts, or create one with {name, clause, interval, universe}."],
    ["PUT/DELETE", "/api/alerts/<id>", "Toggle/update or delete a single alert."],
    ["GET", "/api/alerts/pending", "Notifications waiting to be shown (new scan matches)."],
    ["POST", "/api/alerts/run", "Force the alert engine to check everything now."],
    ["GET/POST", "/api/settings", "Read or update telegram token, chat id, cadence and universe size."],
    ["POST", "/api/settings/test-telegram", "Send a test message through the configured bot."],
  ];

  pages.api = function (view) {
    view.innerHTML = "";

    const wrap = el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { text: "HTTP API" }),
        el("span", { class: "spacer" }),
        el("span", { class: "hint", text: "base: http://127.0.0.1:5000" }),
      ]),
      el("div", { class: "card-body" }, [
        el("div", { class: "hint", style: "margin-bottom:14px", html:
          "Every endpoint is CORS-open, so you can call it from a browser, a spreadsheet or a bot. " +
          "Responses are JSON unless noted." }),

        el("div", { class: "section-title", text: "Clause syntax" }),
        el("pre", {
          style: "background:var(--bg-2);border:1px solid var(--line);border-radius:6px;padding:12px;font-family:var(--mono);font-size:12.5px;color:#a5f3fc;overflow-x:auto;line-height:1.7",
          html: esc(
`# comparisons
[rsi(14)] < 30
[close] >= [high_52w(365)]
[macd_line(12,26,9)] crossed above [macd_signal(12,26,9)]

# boolean logic (and / or / not, brackets optional)
[price_vs_sma(50)] > 0 and ([adx(14)] > 25 or [rsi(14)] > 60)
not [market_cap] < 1000000
volume > 5000000

# a bare field means "> 0"
[supertrend_dir(10,3)]`),
        }),

        el("div", { class: "section-title", style: "margin-top:18px", text: "Endpoints" }),
      ].concat(ENDPOINTS.map(([verb, path, desc, sample]) =>
        el("div", { class: "endpoint" }, [
          el("div", { class: "bar" }, [
            el("span", {
              class: "verb " + (verb === "GET" ? "get" : verb === "POST" ? "post" : verb === "PUT" ? "put" : "del"),
              text: verb,
            }),
            el("span", { class: "path", text: path }),
          ]),
          el("div", { class: "desc", text: desc }),
          sample ? el("pre", { text: sample }) : null,
        ])
      ))),
    ]);

    view.appendChild(wrap);
  };

})();
