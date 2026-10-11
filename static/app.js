/* chartink-crypto frontend: state, condition builder, results, router. */
(function () {
  "use strict";

  /* ================================================================ utils */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function el(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "text") node.textContent = v;
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    (kids || []).forEach((kid) => {
      if (kid == null) return;
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.raw ? (opts.headers || {}) : Object.assign({ "Content-Type": "application/json" }, opts.headers),
      body: opts.body === undefined ? undefined : (opts.raw ? opts.body : JSON.stringify(opts.body)),
    });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || text.slice(0, 200) || res.statusText;
      throw new Error(msg);
    }
    return data;
  }

  /* ============================================================ formatting */
  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return "–";
    const a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    if (a >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (a >= 0.01) return v.toFixed(4);
    /* toPrecision() flips to exponential form below 1e-7. That is exactly how
       a MACD histogram parked on zero ended up labelled "1.6e-18" on the
       chart's price scale. TradingView prints plain decimals there, so
       anything that tiny is noise and snaps to zero. */
    if (a < 1e-7) return v < 0 ? "-0" : "0";
    return v.toPrecision(4);
  }

  function fmtPct(v) {
    if (v == null || !isFinite(v)) return "–";
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }

  function fmtCompact(v) {
    if (v == null || !isFinite(v)) return "–";
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(2);
  }

  function fmtCell(v, fmt) {
    if (v == null) return "–";
    if (fmt === "price") return fmtPrice(v);
    if (fmt === "num2") return Number(v).toFixed(2);
    if (fmt === "num4") return Number(v).toFixed(4);
    if (fmt === "int") return Number(v).toLocaleString();
    if (fmt === "vol") return fmtCompact(v);
    if (fmt === "usd") return "$" + fmtCompact(v);
    return String(v);
  }

  function symSplit(symbol) {
    return symbol.slice(0, -4) + "|USDT";
  }

  function relTime(ts) {
    if (!ts) return "never";
    const d = Math.round((Date.now() - ts * 1000) / 1000);
    if (d < 60) return d + "s ago";
    if (d < 3600) return Math.round(d / 60) + "m ago";
    if (d < 86400) return Math.round(d / 3600) + "h ago";
    return Math.round(d / 86400) + "d ago";
  }

  /* ================================================================ toasts */
  function toast(title, sub, kind, ms) {
    const host = $("#toasts");
    const node = el("div", { class: "toast " + (kind || "") }, [
      el("div", { class: "t-title", text: title }),
      sub ? el("div", { class: "t-sub", text: sub }) : null,
    ]);
    host.appendChild(node);
    setTimeout(() => {
      node.style.transition = "opacity .3s, transform .3s";
      node.style.opacity = "0";
      node.style.transform = "translateX(30px)";
      setTimeout(() => node.remove(), 320);
    }, ms || 4200);
    if (kind === "err") console.error(title, sub || "");
  }

  /* ================================================================= modal */
  function modal(opts) {
    const root = $("#modal-root");
    const close = () => { root.innerHTML = ""; };
    const box = el("div", { class: "modal" }, [
      el("div", { class: "m-head", text: opts.title }),
      el("div", { class: "m-body" }, opts.body || []),
      el("div", { class: "m-foot" }, (opts.actions || []).map((a) =>
        el("button", { class: a.kind || "", onclick: () => { if (a.onClick && a.onClick() === false) return; if (a.close !== false) close(); } }, [a.label])
      )),
    ]);
    root.innerHTML = "";
    root.appendChild(el("div", {
      class: "modal-bg",
      onclick: (e) => { if (e.target.classList.contains("modal-bg")) close(); },
    }, [box]));
    return close;
  }

  /* ================================================================= state */
  const state = {
    catalog: [],
    fieldMap: {},
    presets: [],
    tree: null,
    interval: "1d",
    universe: 400,
    sort: "volume",
    results: null,
    running: false,
    pollTimer: null,
    watchlist: loadWatchlist(),
    settings: {},
  };

  function loadWatchlist() {
    try { return JSON.parse(localStorage.getItem("cx_watchlist") || "[]"); }
    catch (e) { return []; }
  }

  /* Screener view state - the Chartink tabs, menus and table preferences. */
  const UI_DEFAULTS = {
    topTab: "design",     // design | result
    leftTab: "filters",   // filters | columns | groupsort
    viewTab: "table",     // table | bar | pie | line | area | heatmap | billboard | stacked | scatter
    segment: "all",       // all | binance | bybit | kucoin
    halalOnly: true,
    perPage: 20,
    page: 1,
    search: "",
    sortCol: "",
    sortDir: 1,
    extraCols: [],
    hiddenCols: [],
    colOrder: [],
    autoRefresh: false,
    showTrend: true,
    chartCol: "",
    magicMode: "append",
    clauseDirty: false,
    typedClause: "",
  };

  function loadUi() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("cx_screener_ui") || "{}"); }
    catch (e) { saved = {}; }
    const ui = Object.assign({}, UI_DEFAULTS, saved);
    if (ui.extraCols == null) ui.extraCols = [];
    if (ui.hiddenCols == null) ui.hiddenCols = [];
    if (ui.colOrder == null) ui.colOrder = [];
    return ui;
  }

  function saveUi() {
    try { localStorage.setItem("cx_screener_ui", JSON.stringify(state.ui)); }
    catch (e) { /* private mode */ }
  }

  state.ui = loadUi();

  // Watchlist POSTs are chained so rapid toggles cannot land out of order
  // and overwrite the server copy with a stale list.
  let watchQueue = Promise.resolve();

  function saveWatchlist() {
    localStorage.setItem("cx_watchlist", JSON.stringify(state.watchlist));
    watchQueue = watchQueue.then(() =>
      api("/api/watchlist", { method: "POST", body: { symbols: state.watchlist.slice() } }).catch(() => {})
    );
  }

  // Resolves once the server holds the list this toggle just wrote. Anything
  // that reads the Favourite group back off the server (the watchlist page)
  // has to wait on this or it races the POST and sees the old count.
  function watchSynced() { return watchQueue; }

  function isWatched(symbol) { return state.watchlist.indexOf(symbol) !== -1; }

  function toggleWatch(symbol) {
    const i = state.watchlist.indexOf(symbol);
    if (i === -1) state.watchlist.push(symbol);
    else state.watchlist.splice(i, 1);
    saveWatchlist();
    // Pages that embed stars (screener results, charts) need a redraw to show
    // the new state. The watchlist page paints its own star column, and
    // re-running the router there would throw away the loaded table and the
    // indicator job that is still filling it.
    if (location.hash.indexOf("#/watchlist") !== 0) router();
    return i === -1;
  }

  /* ============================================================== clauses */
  const OPS = [">", "<", ">=", "<=", "==", "!=", "crossed above", "crossed below"];
  const CROSS_OPS = ["crossed above", "crossed below"];

  function fieldToken(key, params) {
    const p = params && params.length ? "(" + params.join(",") + ")" : "";
    return "[" + key + p + "]";
  }

  function numStr(v) {
    if (v === "" || v == null || isNaN(v)) return "0";
    return String(Number(v));
  }

  function nodeClause(node) {
    if (node.type === "group") return groupClause(node);
    if (node.enabled === false) return "";
    const pre = offsetWord(node.offset);
    const left = (pre ? pre + " " : "") + fieldToken(node.field, node.params);
    let right;
    if (node.rhs.t === "num") {
      // An empty right-hand side is an unfinished filter - Chartink's
      // "Remove all on right" leaves a row that cannot be scanned yet.
      if (node.rhs.v === "" || node.rhs.v == null) return "";
      right = numStr(node.rhs.v);
    } else {
      const rpre = offsetWord(node.rhs.offset);
      right = (rpre ? rpre + " " : "") + fieldToken(node.rhs.field, node.rhs.params);
    }
    return left + " " + node.op + " " + right;
  }

  function combinations(items, k) {
    const out = [];
    const walk = (start, picked) => {
      if (picked.length === k) { out.push(picked.slice()); return; }
      for (let i = start; i < items.length; i++) {
        picked.push(items[i]);
        walk(i + 1, picked);
        picked.pop();
      }
    };
    walk(0, []);
    return out;
  }

  // Join semantics match Chartink: "all" is AND, "any 1" is OR and "any k"
  // means at least k of the group's filters must match (expanded to the
  // equivalent OR-of-ANDs so the server parser understands it).
  function joinCount(join, total) {
    if (join === "all" || !join) return total;
    const n = parseInt(String(join).replace(/\D+/g, ""), 10);
    return isNaN(n) ? 1 : n;
  }

  function groupClause(node) {
    const kids = (node.children || []).map(nodeClause).filter(Boolean);
    if (!kids.length) return "";
    if (kids.length === 1) return (node.negate ? "not " : "") + kids[0];
    const k = joinCount(node.join, kids.length);
    let body;
    if (k >= kids.length) body = "(" + kids.join(" and ") + ")";
    else if (k <= 1) body = "(" + kids.join(" or ") + ")";
    else {
      const combos = combinations(kids, k);
      body = combos.length > 256
        ? "(" + kids.join(" or ") + ")"
        : "(" + combos.map((c) => "(" + c.join(" and ") + ")").join(" or ") + ")";
    }
    return (node.negate ? "not " : "") + body;
  }

  function currentClause() {
    return state.tree ? nodeClause(state.tree) : "";
  }

  // Every unfinished filter in the tree (rows whose right-hand side is empty).
  function clauseIssues(node, out) {
    out = out || { missing: [] };
    if (!node) return out;
    if (node.type === "group") {
      (node.children || []).forEach((c) => clauseIssues(c, out));
    } else if (node.enabled !== false && node.rhs && node.rhs.t === "num" &&
               (node.rhs.v === "" || node.rhs.v == null)) {
      out.missing.push(node);
    }
    return out;
  }

  function walkTree(node, fn) {
    if (!node) return;
    fn(node);
    if (node.type === "group") (node.children || []).forEach((c) => walkTree(c, fn));
  }

  function defaultCond() {
    return {
      type: "cond", field: "rsi", params: [14], op: "<", rhs: { t: "num", v: 30 },
      offset: { state: DEFAULT_OFFSET.state, tf: DEFAULT_OFFSET.tf }, enabled: true,
    };
  }

  function defaultTree() {
    return { type: "group", join: "all", logic: "AND", negate: false, enabled: true, children: [defaultCond()] };
  }

  // A builder with no filters at all (Chartink's "Clear all filters").
  function emptyTree() {
    return { type: "group", join: "all", logic: "AND", negate: false, enabled: true, children: [] };
  }

  function normGroup(node) {
    if (!node || node.type !== "group") return node;
    if (!node.join) node.join = node.logic === "OR" ? "any 1" : "all";
    node.logic = node.join === "all" ? "AND" : "OR";
    if (node.enabled === undefined) node.enabled = true;
    return node;
  }

  function treeFromAst(ast) {
    if (!ast || !ast.t) return defaultTree();
    if (ast.t === "and" || ast.t === "or") {
      const kids = (ast.kids || []).map(treeFromAst).filter(Boolean);
      return normGroup({
        type: "group", logic: ast.t === "and" ? "AND" : "OR", negate: false,
        join: ast.t === "and" ? "all" : "any 1",
        children: kids.length ? kids : [defaultCond()],
      });
    }
    if (ast.t === "not") {
      const inner = treeFromAst(ast.kid);
      if (inner.type === "group") { inner.negate = !inner.negate; return normGroup(inner); }
      return normGroup({ type: "group", logic: "AND", join: "all", negate: true, children: [inner] });
    }
    if (ast.t === "cmp") {
      if (!ast.left || ast.left.t !== "field") return defaultCond();
      const rhs = ast.right && ast.right.t === "field"
        ? { t: "field", field: ast.right.field, params: ast.right.params || [], offset: ast.right.offset }
        : { t: "num", v: ast.right ? ast.right.v : 0 };
      const cond = {
        type: "cond", field: ast.left.field, params: ast.left.params || [],
        op: ast.op, rhs: rhs, enabled: true,
      };
      if (ast.left.offset) cond.offset = { state: ast.left.offset.state, tf: ast.left.offset.tf };
      else cond.offset = { state: LEGACY_OFFSET.state, tf: LEGACY_OFFSET.tf };
      return cond;
    }
    return defaultCond();
  }

  /* ============================================================== builder */
  /* --- Chartink-style chrome: icons, menus, toggles ---------------------- */
  const ICONS = {
    comment: '<path d="M4 5h16v11H9l-5 4z"/>',
    commentFilled: '<path d="M4 5h16v11H9l-5 4z" fill="currentColor"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h8"/>',
    duplicate: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M4 15V5h10"/>',
    on: '<circle cx="12" cy="12" r="7" fill="currentColor"/>',
    off: '<circle cx="12" cy="12" r="7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    paste: '<path d="M9 4h6v3H9z"/><path d="M7 6H5v14h14V6h-2"/>',
    funnel: '<path d="M4 5h16l-6 7v6l-4-2v-4z"/>',
    wand: '<path d="M5 19L19 5M15 4h5v5"/><path d="M9 4v3M4 9h3"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4-2v-4z"/>',
    group: '<rect x="4" y="5" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="10" height="5" rx="1.5"/>',
    columns: '<path d="M4 5h16v14H4z"/><path d="M10 5v14M15 5v14"/>',
    sort: '<path d="M7 5v14M7 19l-3-3M7 19l3-3M17 19V5M17 5l-3 3M17 5l3 3"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1"/>',
    chevron: '<path d="M7 10l5 5 5-5"/>',
    chevronUp: '<path d="M7 14l5-5 5 5"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
    eyeOff: '<path d="M4 4l16 16"/><path d="M9.5 5.6A9.7 9.7 0 0112 5.3c6.4 0 10 6.7 10 6.7a17 17 0 01-3.6 4.3M6.4 7.6A16.6 16.6 0 002 12s3.6 6.7 10 6.7c1.3 0 2.5-.2 3.5-.6"/>',
    grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/>',
    down: '<path d="M12 5v14M12 19l-5-5M12 19l5-5"/>',
    up: '<path d="M12 19V5M12 5l-5 5M12 5l5 5"/>',
    table: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10h16M10 10v9"/>',
    bar: '<path d="M5 19V10M10 19V5M15 19v-7M20 19v-4"/>',
    pie: '<circle cx="12" cy="12" r="8"/><path d="M12 4v8l6.5 4.6"/>',
    line: '<path d="M4 16l5-5 3 3 6-7"/><path d="M4 20h16"/>',
    area: '<path d="M4 16l5-5 3 3 6-7v12H4z" fill="currentColor" opacity=".35"/><path d="M4 16l5-5 3 3 6-7"/>',
    heat: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
    billboard: '<path d="M6 20V9M12 20V4M18 20v-8"/>',
    stacked: '<path d="M5 19v-6h4v6zM10 19V5h4v14zM15 19v-9h4v9z"/>',
    scatter: '<circle cx="7" cy="16" r="1.6" fill="currentColor"/><circle cx="12" cy="8" r="1.6" fill="currentColor"/><circle cx="17" cy="13" r="1.6" fill="currentColor"/><circle cx="10" cy="14" r="1.6" fill="currentColor"/>',
    csv: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16h6"/>',
    sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
    save: '<path d="M5 5h11l3 3v11H5z"/><path d="M8 5v5h7V5M8 19v-5h8v5"/>',
    share: '<circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8.4v.1"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
    heart: '<path d="M12 20s-7.2-4.5-7.2-9.4A4 4 0 0112 8.2 4 4 0 0119.2 10.6C19.2 15.5 12 20 12 20z"/>',
    heartFilled: '<path d="M12 20s-7.2-4.5-7.2-9.4A4 4 0 0112 8.2 4 4 0 0119.2 10.6C19.2 15.5 12 20 12 20z" fill="currentColor"/>',
    star: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>',
    starFilled: '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" fill="currentColor"/>',
    pen: '<path d="M4 20l4.5-1 10-10a2.1 2.1 0 00-3-3l-10 10z"/><path d="M14.5 6.5l3 3"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M9 20h6M12 16.5V20"/>',
    play: '<path d="M6.5 4.2l12 7.8-12 7.8z" fill="currentColor" stroke="none"/>',
    arrowRight: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  };

  function icon(name, cls) {
    return el("span", {
      class: "ck-icon" + (cls ? " " + cls : ""),
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>",
    });
  }

  function opt(value, text, selected) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    if (selected != null && String(value) === String(selected)) o.selected = true;
    return o;
  }

  const JOIN_OPTIONS = ["all", "any 1", "any 2", "any 3", "any 4", "any 5"];
  const SEGMENTS = [["all", "All exchanges"], ["binance", "Binance"], ["bybit", "Bybit"],
                    ["kucoin", "KuCoin"], ["bitget", "Bitget"], ["okx", "OKX"]];

  function segmentLabel(seg) {
    const want = seg || state.ui.segment;
    const hit = SEGMENTS.filter((x) => x[0] === want)[0];
    return hit ? hit[1] : "All exchanges";
  }

  // Option tables copied from Chartink (including its "Comparision" typo).
  const OP_GROUPS = [
    ["Comparision Operations", [
      ["==", "Equals"], ["!=", "Not equals"], [">", "Greater than"],
      [">=", "Greater than equal to"], ["<", "Less than"], ["<=", "Less than equal to"],
    ]],
    ["Cross Operations", [
      ["crossed above", "Crossed above"], ["crossed below", "Crossed below"],
    ]],
    ["Operations", [["__clear__", "Remove all on right"]]],
  ];
  const OP_LABEL = {};
  const OP_VALUE = {};
  OP_GROUPS.forEach((g) => g[1].forEach((pair) => { OP_VALUE[pair[1]] = pair[0]; OP_LABEL[pair[0]] = pair[1]; }));

  /* ------------------------------------------------ per-row offset prefix
     Chartink flattens its offset select into one list; ours is the same
     information in two dimensions - which candle (current running / latest
     closed / one further back / two further back) x which timeframe.
     "current" is the only state that reads a candle that has not closed yet;
     every other state counts closed candles backwards.                     */
  const OFFSET_STATES = [
    ["current", "CURRENT"], ["closed", "CLOSED"],
    ["2nd closed", "2nd CLOSED"], ["3rd closed", "3rd CLOSED"],
  ];
  const OFFSET_TFS = [
    ["5m", "5 mins"], ["15m", "15 mins"], ["30m", "30 mins"], ["45m", "45 mins"],
    ["1h", "1 hour"], ["2h", "2 hours"], ["3h", "3 hours"], ["4h", "4 hours"],
    ["1d", "Daily"], ["1w", "Weekly"], ["1M", "Monthly"], ["1y", "Yearly"],
  ];
  // Words the parser expects after the state word.
  const TF_WORD = {
    "5m": "5m", "15m": "15m", "30m": "30m", "45m": "45m",
    "1h": "1h", "2h": "2h", "3h": "3h", "4h": "4h",
    "1d": "daily", "1w": "weekly", "1M": "monthly", "1y": "yearly",
  };
  // A clause with no prefix at all means the latest closed daily candle.
  const LEGACY_OFFSET = { state: "closed", tf: "1d" };
  // New rows start on the candle still forming (Chartink's "Latest").
  const DEFAULT_OFFSET = { state: "current", tf: "1d" };

  function normOffset(off) {
    return {
      state: (off && off.state) || LEGACY_OFFSET.state,
      tf: (off && off.tf) || LEGACY_OFFSET.tf,
    };
  }

  function sameOffset(a, b) {
    return a.state === b.state && a.tf === b.tf;
  }

  // Clause text for a prefix - omitted when it is what an unprefixed clause
  // already means, so old presets keep round-tripping unchanged.
  function offsetWord(off) {
    const o = normOffset(off);
    if (sameOffset(o, LEGACY_OFFSET)) return "";
    return o.state + " " + (TF_WORD[o.tf] || "daily");
  }

  function offsetTitle(off) {
    const o = normOffset(off);
    const st = OFFSET_STATES.filter((s) => s[0] === o.state)[0];
    const tf = OFFSET_TFS.filter((t) => t[0] === o.tf)[0];
    return (st ? st[1] : o.state) + " " + (tf ? tf[1] : o.tf);
  }

  const VIEW_TABS = [
    ["table", "Table", "table"], ["bar", "Bar chart", "bar"], ["pie", "Pie chart", "pie"],
    ["line", "Line chart", "line"], ["area", "Area chart", "area"], ["heatmap", "Heatmap", "heat"],
    ["billboard", "Billboard", "billboard"], ["stacked", "Stacked bar", "stacked"],
    ["scatter", "Scatter", "scatter"],
  ];

  /* --- floating menus --------------------------------------------------- */
  let openMenuEl = null;

  function closeMenus() {
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
  }

  document.addEventListener("click", (e) => {
    if (!openMenuEl) return;
    try {
      if (openMenuEl.contains(e.target) || openMenuEl._anchor.contains(e.target)) return;
    } catch (err) { /* anchor gone */ }
    closeMenus();
  });
  window.addEventListener("resize", closeMenus);

  function popMenu(anchor, items, opts) {
    opts = opts || {};
    const wasOpen = openMenuEl && openMenuEl._anchor === anchor;
    closeMenus();
    if (wasOpen) return null;

    const menu = el("div", { class: "ck-menu" + (opts.class ? " " + opts.class : "") });
    items.forEach((it) => {
      if (!it) return;
      if (it.divider) { menu.appendChild(el("div", { class: "ck-menu-divider" })); return; }
      if (it.header) { menu.appendChild(el("div", { class: "ck-menu-header", text: it.header })); return; }
      if (it.custom) { menu.appendChild(it.custom); return; }
      if (it.toggle) {
        // Switch rows keep the menu open so the state change is visible; the
        // local flag keeps flipping correctly on every click.
        let on = !!it.on;
        const row = el("button", {
          class: "ck-toggle-row" + (on ? " on" : ""), title: it.hint || it.label,
          onclick: () => {
            on = !on;
            if (it.onChange) it.onChange(on);
            row.classList.toggle("on", on);
            const sw = row.querySelector(".ck-switch");
            if (sw) sw.classList.toggle("on", on);
          },
        }, [
          el("span", { class: "ck-toggle-label", text: it.label }),
          el("span", { class: "ck-switch" + (on ? " on" : "") }, [el("i")]),
        ]);
        menu.appendChild(row);
        return;
      }
      const row = el("button", {
        class: "ck-menu-item" + (it.active ? " active" : ""),
        title: it.title || "",
        onclick: () => { closeMenus(); if (it.onClick) it.onClick(); },
      }, [
        it.icon ? icon(it.icon) : null,
        el("span", { class: "ck-menu-label", text: it.label }),
        it.hint ? el("span", { class: "ck-menu-hint", text: it.hint }) : null,
      ]);
      if (it.disabled) row.disabled = true;
      if (it.active) row.appendChild(icon("check", "ck-icon--end"));
      menu.appendChild(row);
    });

    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const width = opts.width || 250;
    menu.style.width = width + "px";
    let left = opts.align === "left" ? r.left : r.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    if (left < 8) left = 8;
    menu.style.left = left + "px";
    menu.style.top = (r.bottom + window.scrollY + 6) + "px";
    menu._anchor = anchor;
    openMenuEl = menu;
    return menu;
  }

  function segmented(items, value, onchange, cls) {
    return el("div", { class: "segmented" + (cls ? " " + cls : "") },
      items.map((it) => el("button", {
        class: "segmented__item" + (it[0] === value ? " selected" : ""),
        title: it[3] || it[1],
        onclick: () => onchange(it[0]),
      }, [el("span", { text: it[1] })])));
  }

  function toggleRow(label, on, onchange, hint) {
    return el("button", {
      class: "ck-toggle-row" + (on ? " on" : ""), title: hint || label,
      onclick: () => onchange(!on),
    }, [
      el("span", { class: "ck-toggle-label", text: label }),
      el("span", { class: "ck-switch" + (on ? " on" : "") }, [el("i")]),
    ]);
  }

  /* --- clipboard -------------------------------------------------------- */
  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  }

  function writeClipboard(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(fallbackCopy(text)));
      return;
    }
    done(fallbackCopy(text));
  }

  async function readClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) return text;
      }
    } catch (e) { /* permission denied */ }
    return null;
  }

  function countFilters(node) {
    let n = 0;
    walkTree(node, (x) => { if (x.type === "cond" && x.enabled !== false && nodeClause(x)) n++; });
    return n;
  }

  function explainNode(node) {
    if (node.type === "group") {
      const kids = (node.children || [])
        .filter((c) => c.enabled !== false)
        .map(explainNode)
        .filter(Boolean);
      if (!kids.length) return "";
      const k = joinCount(node.join, kids.length);
      let text;
      if (k >= kids.length) text = kids.join(" AND ");
      else if (k <= 1) text = kids.join(" OR ");
      else text = "at least " + k + " of these must be true: " + kids.join("; ");
      if (node.negate) text = "NOT (" + text + ")";
      if (node.enabled === false) text += "  [disabled]";
      return text;
    }
    const left = (state.fieldMap[node.field] || { label: node.field }).label +
      (node.params && node.params.length ? "(" + node.params.join(", ") + ")" : "");
    let right;
    if (node.rhs.t === "field") {
      right = (state.fieldMap[node.rhs.field] || { label: node.rhs.field }).label +
        (node.rhs.params && node.rhs.params.length ? "(" + node.rhs.params.join(", ") + ")" : "");
    } else if (node.rhs.v === "" || node.rhs.v == null) {
      return left + " (value not set)";
    } else {
      right = String(node.rhs.v);
    }
    return left + " " + (OP_LABEL[node.op] || node.op).toLowerCase() + " " + right;
  }

  function actionBtn(name, title, onclick, cls) {
    return el("button", {
      class: "atlas-filter-action" + (cls ? " " + cls : ""),
      title: title, "aria-label": title,
      onclick: (e) => { e.stopPropagation(); onclick(e); },
    }, [icon(name)]);
  }

  function actionStrip(buttons, variant) {
    return el("span", { class: "atlas-filter-action-strip" + (variant ? " atlas-filter-action-strip--" + variant : "") },
      buttons.filter(Boolean));
  }

  function commentButton(node) {
    const has = !!(node.comment && String(node.comment).trim());
    return actionBtn(has ? "commentFilled" : "comment", has ? node.comment : "Comment", () => {
      node.showComment = !node.showComment;
      renderBuilder();
      if (node.showComment) {
        setTimeout(() => {
          const input = $(".atlas-comment-input");
          if (input) input.focus();
        }, 0);
      }
    });
  }

  function commentInput(node) {
    return el("input", {
      class: "atlas-comment-input", type: "text", value: node.comment || "",
      placeholder: "Add a comment for this filter",
      oninput: (e) => { node.comment = e.target.value; },
    });
  }

  function copyNodeButton(node, label) {
    return actionBtn("copy", label || "Copy to clipboard", () => {
      const text = nodeClause(node);
      if (!text) { toast("Nothing to copy", "This filter is not complete yet.", "err"); return; }
      writeClipboard(text, (ok) => toast(ok ? "Copied to clipboard" : "Could not copy", text, ok ? "ok" : "err", 2600));
    });
  }

  function enableButton(node, what) {
    const on = node.enabled !== false;
    return actionBtn(
      on ? "on" : "off",
      (on ? "Disable " : "Enable ") + what,
      () => { node.enabled = !on; renderBuilder(); },
      on ? "atlas-filter-action--enabled" : "atlas-filter-action--disabled"
    );
  }

  async function applyPasted(group, text) {
    text = String(text || "").trim();
    if (!text) return;
    try {
      const res = await api("/api/parse?clause=" + encodeURIComponent(text));
      let node = treeFromAst(res.ast);
      if (node.type !== "group") {
        node = { type: "group", join: "all", logic: "AND", negate: false, enabled: true, children: [node] };
      }
      group.children.push(node);
      renderBuilder();
      toast("Pasted filter", res.clause, "ok", 2600);
    } catch (e) {
      toast("Nothing pasted", e.message, "err");
    }
  }

  async function pasteInto(group) {
    const text = await readClipboard();
    if (text) { applyPasted(group, text); return; }
    const ta = el("textarea", { rows: 3, style: "width:100%" });
    modal({
      title: "Paste copied filters/groups",
      body: [
        el("div", { class: "hint", text: "Your browser did not allow reading the clipboard - paste the copied clause below." }),
        ta,
      ],
      actions: [
        { label: "Cancel" },
        { label: "Paste", kind: "primary", onClick: () => { applyPasted(group, ta.value); return true; } },
      ],
    });
  }

  function openSavedScanPicker() {
    const list = el("div", { class: "preset-list", style: "max-height:50vh;overflow:auto" });
    (state.presets || []).forEach((p) => {
      list.appendChild(el("button", {
        class: "ck-menu-item", style: "width:100%;text-align:left",
        onclick: () => { closeMenus(); applyTextClause(p.clause).catch(() => {}); },
      }, [
        el("span", { class: "ck-menu-label" }, [
          el("b", { text: p.name }),
          el("div", { class: "hint", text: p.clause }),
        ]),
      ]));
    });
    modal({
      title: "Load a saved scan",
      body: [el("div", { class: "hint", text: "Picks up the library scan into the current group." }), list],
      actions: [{ label: "Close" }],
    });
  }

  function openAddMenu(anchor, group) {
    popMenu(anchor, [
      { label: "Add filter", icon: "filter", onClick: () => { group.children.push(defaultCond()); renderBuilder(); } },
      {
        label: "Add group", icon: "group",
        onClick: () => {
          group.children.push({ type: "group", join: "any 1", logic: "OR", negate: false, enabled: true, children: [defaultCond()] });
          renderBuilder();
        },
      },
      { label: "Load a saved scan…", icon: "save", onClick: openSavedScanPicker },
    ], { width: 230 });
  }

  function fieldOptions(selected) {
    return (state.catalog || []).map((group) => {
      const og = document.createElement("optgroup");
      og.label = group.cat;
      (group.fields || []).forEach((f) => {
        const o = document.createElement("option");
        o.value = f.key;
        o.textContent = f.label;
        if (f.key === selected) o.selected = true;
        og.appendChild(o);
      });
      return og;
    });
  }

  // mode === "restore" keeps whatever was typed straight into the clause box
  // (used when the screener page is redrawn around an in-progress edit).
  function renderBuilder(mode) {
    const host = $("#builder");
    if (!host) return;
    // The builder always draws a root group, but a parsed single-condition
    // clause yields a bare condition node — wrap it before rendering.
    if (!state.tree || state.tree.type !== "group") {
      state.tree = {
        type: "group", join: "all", logic: "AND", negate: false, enabled: true,
        children: [state.tree || defaultCond()],
      };
    }
    normGroup(state.tree);
    host.innerHTML = "";
    host.appendChild(renderGroup(state.tree, [], null));

    const box = $("#clauseBox");
    if (box && mode === "restore" && state.ui.clauseDirty && state.ui.typedClause) {
      box.value = state.ui.typedClause;
    } else {
      if (box) box.value = currentClause();
      state.ui.clauseDirty = false;
      state.ui.typedClause = "";
    }
    const preview = $("#clausePreview");
    if (preview) preview.textContent = currentClause() || "—";
    const badge = $("#filterCount");
    if (badge) badge.textContent = String(countFilters(state.tree));
  }

  function findNode(path) {
    let node = state.tree;
    for (let i = 0; i < path.length; i++) node = node.children[path[i]];
    return node;
  }

  function removeNode(path) {
    if (!path.length) return;
    const parent = findNode(path.slice(0, -1));
    parent.children.splice(path[path.length - 1], 1);
    if (!parent.children.length) parent.children.push(defaultCond());
  }

  function moveChild(parent, from, to) {
    if (from === to) return;
    const node = parent.children.splice(from, 1)[0];
    parent.children.splice(to, 0, node);
  }

  // Chartink's far-right heading pill: hide the conditions from people you
  // share the scan with (the rows are masked - the sentence and the pill stay
  // so they can always be brought back).
  let hidePopOpen = false;

  function hideConditionsWrap() {
    const hidden = state.ui.hideFilters;
    return el("div", { class: "atlas-hidecond-wrap" }, [
      el("button", {
        class: "atlas-hidecond" + (hidden ? " is-hidden" : ""),
        "aria-pressed": hidden ? "true" : "false",
        "aria-haspopup": "dialog",
        title: hidden ? "Filters are hidden, click to unhide for others" : "Hide conditions",
        onclick: () => { hidePopOpen = !hidePopOpen; renderBuilder(); },
      }, [
        icon(hidden ? "eyeOff" : "eye"),
        el("span", { text: hidden ? "Filters are hidden, click to unhide for others" : "Hide conditions" }),
      ]),
      hidePopOpen ? hideConditionsPopover() : null,
    ]);
  }

  function hideConditionsPopover() {
    const hidden = state.ui.hideFilters;
    const close = () => { hidePopOpen = false; renderBuilder(); };
    return el("div", { class: "atlas-hidepop", role: "dialog", "aria-modal": "false" }, [
      el("p", {
        class: "atlas-hidepop-msg",
        text: hidden
          ? "Allow others to view these widget filter conditions again?"
          : "Allow others to run this widget but hide the filter conditions?",
      }),
      el("div", { class: "atlas-hidepop-actions" }, [
        el("button", { class: "ck-btn", text: "Cancel", onclick: close }),
        el("button", {
          class: "ck-btn ck-btn--ok", text: "OK",
          onclick: () => {
            state.ui.hideFilters = !hidden;
            saveUi();
            close();
            toast(
              hidden ? "Conditions are visible" : "Conditions are hidden",
              hidden ? "" : "Others can see your hidden conditions by clicking on unhide.",
              "ok", 4200
            );
          },
        }),
      ]),
    ]);
  }

  // Chartink's heading funnel: run the scan and report how far each filter got.
  function debugScan() {
    runScan({ debug: true });
  }

  function renderGroup(node, path, parent) {
    normGroup(node);
    const isRoot = path.length === 0;
    const disabled = node.enabled === false;

    const combinationSel = isRoot
      ? el("select", {
          class: "atlas-combination", title: "Scan direction",
          onchange: (e) => { node.negate = e.target.value === "fails"; renderBuilder(); },
        }, [
          opt("passes", "passes", node.negate ? "fails" : "passes"),
          opt("fails", "fails", node.negate ? "fails" : "passes"),
        ])
      : null;

    const joinSel = el("select", {
      class: "atlas-join", title: "How many of the below filters must match",
      onchange: (e) => { node.join = e.target.value; normGroup(node); renderBuilder(); },
    }, JOIN_OPTIONS.map((v) => opt(v, v, node.join)));

    const segmentSel = isRoot
      ? el("select", {
          class: "atlas-segment", title: "Exchange segment",
          onchange: (e) => {
            state.ui.segment = e.target.value;
            saveUi();
            const hint = $("#segmentHint");
            if (hint) hint.textContent = segmentLabel();
          },
        }, SEGMENTS.map((s) => opt(s[0], s[1], state.ui.segment)))
      : null;

    const collapseBtn = isRoot ? null : el("button", {
      class: "atlas-collapse", title: node.collapsed ? "Expand group" : "Collapse group",
      onclick: () => { node.collapsed = !node.collapsed; renderBuilder(); },
    }, [icon(node.collapsed ? "chevron" : "chevronUp")]);

    const strip = actionStrip([
      commentButton(node),
      copyNodeButton(node, isRoot ? "Copy scan to clipboard" : "Copy group to clipboard"),
      isRoot ? actionBtn("funnel", "Debug scan filters", () => debugScan()) : null,
      isRoot ? null : actionBtn("duplicate", "Duplicate group", () => {
        const clone = JSON.parse(JSON.stringify(node));
        clone.showComment = false;
        parent.children.splice(path[path.length - 1] + 1, 0, clone);
        renderBuilder();
      }),
      isRoot ? null : enableButton(node, "group"),
      isRoot ? null : actionBtn("close", "Delete group", () => { removeNode(path); renderBuilder(); }),
    ], "heading");

    const heading = el("div", { class: "atlas-heading" + (disabled ? " is-disabled" : "") }, [
      isRoot ? el("span", { class: "atlas-subject", text: "Coin" }) : null,
      combinationSel,
      isRoot ? null : collapseBtn,
      joinSel,
      el("span", { text: isRoot ? "of the below filters in" : "of the below filters:" }),
      isRoot ? segmentSel : null,
      isRoot ? el("span", { text: "segment:" }) : null,
      strip,
      isRoot ? hideConditionsWrap() : null,
    ]);

    const body = el("ul", { class: "atlas-filter-list" });
    if (!node.collapsed) {
      (node.children || []).forEach((child, i) => {
        const childPath = path.concat([i]);
        const item = child.type === "group"
          ? el("li", { class: "atlas-filter-grabbable atlas-group-li" }, [renderGroup(child, childPath, node)])
          : renderCond(child, childPath, node, i);
        bindDrag(item, node, i);
        body.appendChild(item);
      });
      body.appendChild(el("li", { class: "atlas-add-row" }, [
        el("button", {
          class: "atlas-add", title: "Add filter, group, or saved scan",
          "aria-label": "Add filter, group, or saved scan",
          onclick: (e) => openAddMenu(e.currentTarget, node),
        }, [icon("add")]),
        el("button", {
          class: "atlas-paste", title: "Paste copied filters/groups",
          "aria-label": "Paste copied filters or groups",
          onclick: () => pasteInto(node),
        }, [icon("paste")]),
      ]));
    }

    // Hiding conditions masks the rows only - the sentence and the pill stay
    // so you can always unhide them again.
    if (isRoot && state.ui.hideFilters) body.style.display = "none";

    return el("div", {
      class: "atlas-group" + (isRoot ? " is-root" : "") + (disabled ? " is-disabled" : ""),
    }, [
      heading,
      node.showComment ? commentInput(node) : null,
      body,
    ]);
  }

  // Rows can be reordered inside their own group by dragging them.
  function bindDrag(item, owner, index) {
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
      state.dragKey = owner;
      state.dragIndex = index;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(index)); } catch (err) { /* IE */ }
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      state.dragKey = null;
      state.dragIndex = null;
    });
    item.addEventListener("dragover", (e) => {
      if (state.dragKey !== owner || state.dragIndex == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      item.classList.add("drop-target");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("drop-target");
      if (state.dragKey !== owner || state.dragIndex == null) return;
      const from = state.dragIndex;
      state.dragKey = null;
      state.dragIndex = null;
      if (from === index) return;
      moveChild(owner, from, index);
      renderBuilder();
    });
  }

  function paramInputs(node, defs) {
    return (defs || []).map((p, i) => {
      const input = el("input", {
        type: "number", value: node.params[i] != null ? node.params[i] : p.default,
        min: p.min, max: p.max, step: "any", title: p.name, "aria-label": p.name,
        onchange: (e) => {
          let v = parseFloat(e.target.value);
          if (isNaN(v)) v = p.default;
          node.params[i] = Math.max(p.min, Math.min(p.max, v));
          e.target.value = node.params[i];
          renderBuilder();
        },
      });
      return el("span", { class: "param" }, ["(", input, ")"]);
    });
  }

  // The per-row candle offset prefix: which candle (running or closed) and of
  // which timeframe. Two inline selects so the state is always visible while
  // the dropdown stays a single short list per group.
  function offsetControls(cur, onChange) {
    const stateSel = el("select", {
      class: "atlas-offset atlas-offset--state", title: "Candle - CURRENT is the candle still forming, the others count closed candles back",
      onchange: (e) => onChange({ state: e.target.value, tf: cur.tf }),
    }, OFFSET_STATES.map((s) => opt(s[0], s[1], cur.state)));
    const tfSel = el("select", {
      class: "atlas-offset atlas-offset--tf", title: "Timeframe of the candle",
      onchange: (e) => onChange({ state: cur.state, tf: e.target.value }),
    }, OFFSET_TFS.map((t) => opt(t[0], t[1], cur.tf)));
    return [stateSel, tfSel];
  }

  function renderCond(node, path, parent, index) {
    const info = (state.fieldMap || {})[node.field];
    const disabled = node.enabled === false;

    const offControls = offsetControls(normOffset(node.offset), (next) => {
      node.offset = next;
      renderBuilder();
    });

    const fieldSel = el("select", {
      class: "atlas-field", title: info ? (info.desc || info.label) : "",
      onchange: (e) => {
        node.field = e.target.value;
        const def = (state.fieldMap || {})[node.field];
        node.params = (def ? def.params : []).map((p) => p.default);
        renderBuilder();
      },
    }, fieldOptions(node.field));

    const opSel = el("select", {
      class: "atlas-op", title: "Comparison operator",
      onchange: (e) => {
        const value = e.target.value;
        if (value === "__clear__") {
          // Chartink's "Remove all on right" empties the right-hand side.
          node.rhs = { t: "num", v: "" };
          node.op = node.op || "<";
          renderBuilder();
          return;
        }
        node.op = value;
        if (CROSS_OPS.indexOf(node.op) !== -1 && node.rhs.t !== "field") {
          node.rhs = {
            t: "field", field: "sma", params: [50],
            offset: { state: DEFAULT_OFFSET.state, tf: DEFAULT_OFFSET.tf },
          };
        }
        renderBuilder();
      },
    }, OP_GROUPS.map((group) => {
      const og = document.createElement("optgroup");
      og.label = group[0];
      group[1].forEach((pair) => og.appendChild(opt(pair[0], pair[1], node.op)));
      return og;
    }));

    // Right hand side: one select that starts with "Number" and then lists the
    // fields - pick Number for a constant, a field for series-to-series.
    const rhsSel = el("select", {
      class: "atlas-value atlas-rhs-type", title: "Right hand side",
      onchange: (e) => {
        const want = e.target.value;
        if (want === "__num__") {
          if (CROSS_OPS.indexOf(node.op) !== -1) node.op = ">";
          node.rhs = { t: "num", v: "" };
        } else {
          const def = (state.fieldMap || {})[want] || {};
          node.rhs = {
            t: "field", field: want,
            params: (def.params || []).map((p) => p.default),
            offset: { state: DEFAULT_OFFSET.state, tf: DEFAULT_OFFSET.tf },
          };
        }
        renderBuilder();
      },
    }, [opt("__num__", "Number", node.rhs.t !== "field")]
      .concat(fieldOptions(node.rhs.t === "field" ? node.rhs.field : null)));

    let value;
    if (node.rhs.t === "field") {
      const rInfo = (state.fieldMap || {})[node.rhs.field];
      const rhsOff = offsetControls(normOffset(node.rhs.offset), (next) => {
        node.rhs.offset = next;
        renderBuilder();
      });
      value = rhsOff.concat([rhsSel],
        paramInputs(node.rhs, rInfo ? rInfo.params : []));
    } else {
      value = [rhsSel, el("input", {
        class: "atlas-value num" + (node.rhs.v === "" || node.rhs.v == null ? " is-empty" : ""),
        type: "text", value: node.rhs.v == null ? "" : node.rhs.v,
        placeholder: "value", title: "value", "aria-label": "value",
        onchange: (e) => { node.rhs.v = e.target.value.trim(); renderBuilder(); },
      })];
    }

    const strip = actionStrip([
      el("span", { class: "atlas-grip", title: "Drag to reorder" }, [icon("grip")]),
      commentButton(node),
      copyNodeButton(node, "Copy filter to clipboard"),
      actionBtn("duplicate", "Duplicate filter", () => {
        const clone = JSON.parse(JSON.stringify(node));
        clone.showComment = false;
        parent.children.splice(index + 1, 0, clone);
        renderBuilder();
      }),
      enableButton(node, "filter"),
      actionBtn("funnel", "Debug scan filters",
        () => toast("Explain", explainNode(node), "ok", 6000)),
      actionBtn("close", "Remove filter", () => { removeNode(path); renderBuilder(); }),
    ]);

    return el("li", {
      class: "atlas-filter-grabbable" + (disabled ? " is-disabled" : "") + (node.__flash ? " is-flash" : ""),
      title: explainNode(node),
    }, [
      el("div", { class: "atlas-filter-row" }, [
        el("div", { class: "c-offset" }, offControls),
        el("div", { class: "c-field" }, [fieldSel].concat(paramInputs(node, info ? info.params : []))),
        el("div", { class: "c-op" }, [opSel]),
        el("div", { class: "c-rhs" }, value),
        strip,
      ]),
      node.showComment ? commentInput(node) : null,
    ]);
  }

  function flashIssues(missing) {
    walkTree(state.tree, (n) => { delete n.__flash; });
    missing.forEach((n) => { n.__flash = true; });
    renderBuilder();
    if (missing.length) {
      setTimeout(() => { walkTree(state.tree, (n) => { delete n.__flash; }); renderBuilder(); }, 2500);
    }
  }

  /* =============================================================== running */
  let screenerView = null;

  function paintScreener() {
    if (screenerView) pageScreener(screenerView);
  }

  function setRunning(on) {
    state.running = on;
    $$(".run-btn").forEach((btn) => {
      btn.disabled = on;
      const label = btn.querySelector(".run-label");
      if (label) label.textContent = on ? "Running.." : "Run Scan";
      else btn.textContent = on ? "Scanning…" : "Run scan";
      btn.classList.toggle("is-running", on);
    });
    const bar = $("#progressBar");
    if (bar && !on) bar.style.width = "0%";
    const ptxt = $("#progressText");
    if (ptxt && !on) ptxt.textContent = "";
  }

  function paintResultsBox(html) {
    const box = $("#resultsBody");
    if (box) box.innerHTML = html;
  }

  async function runScan(opts) {
    opts = (opts && typeof opts === "object" && !opts.type) ? opts : {};
    let clause = currentClause();
    const issues = clauseIssues(state.tree);

    // Text typed straight into the clause box wins over the builder: parse it
    // and sync the two, so "Run scan" always scans what you are looking at.
    // (state.ui.typedClause keeps the text alive across tab switches.)
    const clauseEl = $("#clauseBox");
    let typed = state.ui.typedClause || "";
    if (clauseEl && clauseEl.value.trim()) typed = clauseEl.value.trim();
    typed = typed.trim();
    if (typed && state.ui.clauseDirty) {
      let res;
      try { res = await api("/api/parse?clause=" + encodeURIComponent(typed)); }
      catch (e) { toast("Please fix the errors to continue", e.message, "err"); return; }
      state.tree = treeFromAst(res.ast);
      clause = res.clause;
      renderBuilder();
    }

    if (issues.missing.length) {
      toast(
        'Every filter should have one "Comparison operator", eg: Greater than/less than/equals/crossover etc.',
        "Please select one comparision from the dropdown to filter your stocks.",
        "err", 7000
      );
      flashIssues(issues.missing);
      return;
    }

    if (!clause) {
      toast(
        "No filters applied",
        "You have not added any filters to perform a scan! Click on the plus icon to add them.",
        "err", 7000
      );
      return;
    }

    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }

    // Results sit under the builder - bring them into view so progress is seen.
    const res = document.getElementById("resultsSection");
    if (res && res.scrollIntoView) res.scrollIntoView({ behavior: "smooth", block: "start" });

    setRunning(true);
    paintResultsBox('<div class="ck-loading"><span class="ck-spinner"></span><span>Running...</span></div>');

    try {
      const posted = await api("/api/scan", {
        method: "POST",
        body: {
          clause: clause,
          interval: state.interval,
          universe: state.universe,
          sort_by: state.sort,
          venue: state.ui.segment,
          halal_only: state.ui.halalOnly,
          columns: state.ui.extraCols || [],
          debug: opts.debug ? true : undefined,
        },
      });
      state.ui.page = 1;
      saveUi();
      pollScan(posted.job_id, opts);
    } catch (e) {
      setRunning(false);
      toast("Scan failed", e.message, "err");
      paintResultsBox('<div class="error-box">' + esc(e.message) + "</div>");
    }
  }

  function pollScan(jobId, opts) {
    state.pollTimer = setInterval(async () => {
      let job;
      try { job = await api("/api/scan/" + jobId); }
      catch (e) {
        clearInterval(state.pollTimer); state.pollTimer = null; setRunning(false);
        toast("Cannot load results, please try again", e.message, "err");
        return;
      }
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
      const bar = $("#progressBar");
      if (bar) bar.style.width = pct + "%";
      const ptxt = $("#progressText");
      if (ptxt) ptxt.textContent = `${job.done}/${job.total} · ${job.elapsed}s`;

      if (job.status === "done") {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        setRunning(false);
        state.results = job;
        renderResults(job);
        if (opts && opts.debug) {
          renderDebugStrip(job);
        } else {
          const strip = $("#debugStrip");
          if (strip) { strip.style.display = "none"; strip.innerHTML = ""; }
        }
        if (state.ui.autoRefresh) {
          state.autoTimer = setInterval(() => { runScan(); }, 60000);
        }
      } else if (job.status === "error") {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        setRunning(false);
        toast("Cannot load results, please try again", job.error || "unknown error", "err");
        paintResultsBox('<div class="error-box">' + esc(job.error || "") + "</div>");
      }
    }, 400);
  }

  /* -------------------------------------------------------- debug funnel */
  function renderDebugStrip(job) {
    const host = $("#debugStrip");
    if (!host) return;
    const rows = (job && job.debug) || [];
    if (!rows.length) {
      host.style.display = "none";
      host.innerHTML = "";
      toast("Debug scan filters", "This scan did not report per-filter match rates.", "err", 4200);
      return;
    }
    host.style.display = "";
    host.innerHTML = "";
    host.appendChild(el("em", { class: "ck-debug-title", text: "Debug scan filters" }));
    rows.forEach((d, i) => {
      const total = d.evaluated || job.scanned || 1;
      const pct = Math.round(((d.matched || 0) / total) * 100);
      host.appendChild(el("span", {
        class: "ck-debug-pill",
        title: (d.text || "") + "\n" +
          (d.matched || 0) + " of " + total + " coins get past this filter" +
          (d.solo != null ? " · " + d.solo + " pass this filter on its own" : ""),
      }, [
        el("i", { text: (i + 1) + "." }),
        el("em", { text: d.text || "" }),
        el("b", { text: pct + "%" }),
      ]));
    });
  }

  /* =============================================================== results */
  function orderedCols(job) {
    const cols = ((job && job.columns) || []).slice();
    const order = state.ui.colOrder || [];
    if (order.length) {
      const pos = (c) => { const i = order.indexOf(c); return i === -1 ? 100000 + cols.indexOf(c) : i; };
      cols.sort((a, b) => pos(a) - pos(b));
    }
    return cols;
  }

  function dynamicCols(job) {
    const hidden = state.ui.hiddenCols || [];
    return orderedCols(job).filter((c) => hidden.indexOf(c) === -1);
  }

  function fieldDef(job, id) {
    const list = (job && job.fields) || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function colLabel(job, id) {
    const def = fieldDef(job, id);
    return def ? def.label : id;
  }

  // Header text for a dynamic column: "rsi(14)" -> "RSI (14)".
  function colTitle(job, id) {
    const def = fieldDef(job, id);
    if (!def) return id;
    const base = def.label || id;
    const m = /\(([^()]*)\)\s*$/.exec(id);
    if (m && !/\(/.test(base)) return base + " (" + m[1] + ")";
    return base;
  }

  const FIXED_VALUES = {
    __sr__: (r) => r.rank || 0,
    __name__: (r) => (r.name || r.base || "").toLowerCase(),
    __symbol__: (r) => r.symbol,
    __price__: (r) => (r.price == null ? -Infinity : r.price),
    __change__: (r) => (r.change_pct == null ? -Infinity : r.change_pct),
    __volume__: (r) => r.quote_volume || 0,
    __mcap__: (r) => r.market_cap || 0,
    __halal__: (r) => r.halal_votes || 0,
  };

  function resultValue(row, colId) {
    if (FIXED_VALUES[colId]) return FIXED_VALUES[colId](row);
    const v = (row.values || {})[colId];
    if (typeof v === "number") return v;
    if (v == null) return -Infinity;
    return String(v).toLowerCase();
  }

  function searchedRows(job) {
    let rows = (job && job.results) || [];
    const q = (state.ui.search || "").trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        r.symbol.toLowerCase().indexOf(q) !== -1 ||
        (r.base || "").toLowerCase().indexOf(q) !== -1 ||
        (r.name || "").toLowerCase().indexOf(q) !== -1);
    }
    const col = state.ui.sortCol;
    if (col) {
      const dir = state.ui.sortDir || 1;
      rows = rows.slice().sort((a, b) => {
        const x = resultValue(a, col);
        const y = resultValue(b, col);
        if (typeof x === "string" || typeof y === "string") {
          return String(x).localeCompare(String(y)) * dir;
        }
        return (x - y) * dir;
      });
    }
    return rows;
  }

  function pagedRows(job) {
    const rows = searchedRows(job);
    const per = state.ui.perPage || 20;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    if (state.ui.page > pages) state.ui.page = pages;
    if (state.ui.page < 1) state.ui.page = 1;
    const start = (state.ui.page - 1) * per;
    return { rows, page: rows.slice(start, start + per), start, per, pages };
  }

  function sortTh(job, label, opts) {
    opts = opts || {};
    const cell = el("th", { class: opts.cls || "", title: opts.title || "" });
    if (opts.width) cell.style.width = opts.width;
    if (!opts.sortId) { cell.textContent = label; return cell; }
    cell.classList.add("sortable");
    const active = state.ui.sortCol === opts.sortId;
    cell.appendChild(el("span", { text: label }));
    if (active) {
      cell.appendChild(el("i", {
        class: "sort-ind " + (state.ui.sortDir > 0 ? "asc" : "desc"),
        text: state.ui.sortDir > 0 ? "▲" : "▼",
      }));
    }
    cell.addEventListener("click", () => {
      if (state.ui.sortCol === opts.sortId) state.ui.sortDir = -(state.ui.sortDir || 1);
      else { state.ui.sortCol = opts.sortId; state.ui.sortDir = 1; }
      saveUi();
      renderResults(job);
    });
    return cell;
  }

  function venueCell(r) {
    return el("td", { class: "cell-venue" }, (r.exchanges || []).map((v) => el("span", {
      class: "venue-chip v-" + v,
      text: v === "kucoin" ? "KuCoin" : v.charAt(0).toUpperCase() + v.slice(1),
      title: "Listed on " + (v === "kucoin" ? "KuCoin" : v),
    })));
  }

  function halalCell(r) {
    const votes = r.halal_votes || 0;
    const auto = r.halal_source === "auto";
    const node = auto
      ? el("span", {
          class: "halal-badge auto" + (r.halal ? " yes" : " no"),
          title: r.halal
            ? "None of the 5 screening platforms has assessed this coin yet, so it "
              + "passed the structural auto-screen. Not a platform verdict."
            : "None of the 5 platforms has assessed this coin, and the auto-screen "
              + "excluded it.",
        }, [
          el("i", { text: r.halal ? "✓" : "·" }),
          el("b", { text: "auto" }),
        ])
      : el("span", {
          class: "halal-badge " + (r.halal ? "yes" : "no"),
          title: r.halal
            ? votes + " of the 5 screening platforms call this halal"
            : "Only " + votes + " of 5 platforms call this halal (3 needed)",
        }, [
          el("i", { text: r.halal ? "✓" : "·" }),
          el("b", { text: votes + "/5" }),
        ]);
    return el("td", { class: "cell-halal" }, [node]);
  }

  function renderResultTable(job, host) {
    const cols = dynamicCols(job);
    const { rows, page, start, per } = pagedRows(job);

    const table = el("table", { class: "data atlas-results" });
    const thead = el("thead");
    thead.appendChild(el("tr", {}, [
      sortTh(job, "Sr.", { sortId: "__sr__", width: "56px", cls: "dim" }),
      sortTh(job, "Stock Name", { sortId: "__name__", cls: "l", width: "230px" }),
      sortTh(job, "Symbol", { sortId: "__symbol__", width: "140px" }),
      el("th", { text: "Exchange", width: "170px" }),
      sortTh(job, "Halal", { sortId: "__halal__", width: "84px" }),
      sortTh(job, "Price", { sortId: "__price__", width: "110px" }),
      sortTh(job, "24h %", { sortId: "__change__", width: "88px" }),
    ].concat(cols.map((c) => sortTh(job, colTitle(job, c), {
      sortId: c, width: "150px", title: colLabel(job, c),
    })), [
      sortTh(job, "24h Volume", { sortId: "__volume__", width: "110px" }),
      sortTh(job, "Mkt Cap", { sortId: "__mcap__", width: "110px" }),
      el("th", { text: "Trend", width: "110px" }),
      el("th", { text: "★", width: "44px" }),
      el("th", { text: "⌁", width: "44px" }),
      el("th", { class: "add-col", title: "Add Column" }, [
        el("button", {
          class: "add-col-btn", text: "+", "aria-label": "Add Column",
          onclick: (e) => { e.stopPropagation(); openAddColumnMenu(e.currentTarget); },
        }),
      ]),
    ])));
    table.appendChild(thead);

    const tbody = el("tbody");
    page.forEach((r, i) => {
      const chg = r.change_pct;
      const cls = chg == null ? "dim" : chg >= 0 ? "pos" : "neg";
      const sparkCanvas = el("canvas", { style: "height:24px;width:96px;display:block;margin-left:auto" });

      const star = el("span", {
        class: "star" + (isWatched(r.symbol) ? " on" : ""),
        text: isWatched(r.symbol) ? "★" : "☆",
        title: "Toggle watchlist",
        onclick: (e) => {
          e.stopPropagation();
          const on = toggleWatch(r.symbol);
          star.textContent = on ? "★" : "☆";
          star.classList.toggle("on", on);
          toast(on ? "Added to watchlist" : "Removed from watchlist", r.symbol, on ? "ok" : "");
        },
      });

      const bell = el("button", {
        class: "bell", text: "🔔", title: "Create an alert for a scan like this",
        onclick: (e) => { e.stopPropagation(); openAlertModal(r); },
      });

      const trendCell = el("td", {}, state.ui.showTrend ? [sparkCanvas] : [el("span", { class: "dim", text: "–" })]);

      const row = el("tr", {
        onclick: () => { location.hash = "#/chart/" + r.symbol; },
      }, [
        el("td", { class: "dim", text: String(start + i + 1) }),
        el("td", { class: "l" }, [
          el("span", { class: "stock-name", text: r.name || r.base }),
          el("span", { class: "dim", text: " " + (r.base || "") }),
        ]),
        el("td", {}, [
          el("span", { class: "sym", html: esc(r.base) + ' <span class="quote">/USDT</span>' }),
        ]),
        venueCell(r),
        halalCell(r),
        el("td", { text: fmtPrice(r.price) }),
        el("td", { class: cls, text: fmtPct(chg) }),
      ].concat(cols.map((c) => el("td", {
        text: fmtCell((r.values || {})[c], fieldDef(job, c) ? fieldDef(job, c).fmt : "num2"),
      })), [
        el("td", { text: "$" + fmtCompact(r.quote_volume) }),
        el("td", { text: r.market_cap ? "$" + fmtCompact(r.market_cap) : "–" }),
        trendCell,
        el("td", {}, [star]),
        el("td", {}, [bell]),
        el("td"),
      ]));

      if (state.ui.chartPreview !== false) {
        row.addEventListener("mouseenter", (e) => showChartPreview(r, e));
        row.addEventListener("mouseleave", hideChartPreview);
      }

      tbody.appendChild(row);
      if (state.ui.showTrend && r.spark && r.spark.length > 1) {
        requestAnimationFrame(() => {
          try { ChartKit.spark(sparkCanvas, r.spark); } catch (e) { /* noop */ }
        });
      }
    });
    table.appendChild(tbody);

    host.innerHTML = "";
    host.appendChild(el("div", { class: "table-wrap" }, [table]));

    const hint = $("#resultCount");
    if (hint) {
      hint.textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}` +
        (rows.length !== (job.results || []).length ? ` (filtered from ${job.results.length})` : "");
    }
  }

  // Page buttons with "…" gaps: 1 … 4 5 6 … 20
  function pageList(current, pages) {
    const want = [1, pages, current - 1, current, current + 1]
      .filter((p) => p >= 1 && p <= pages);
    const uniq = Array.from(new Set(want)).sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    uniq.forEach((p) => {
      if (prev && p - prev > 1) out.push({ gap: true, key: "g" + p });
      out.push({ p: p, key: "p" + p });
      prev = p;
    });
    return out;
  }

  function renderResultPager(job) {
    const host = $("#resultsPager");
    if (!host) return;
    const { rows, start, per, pages } = pagedRows(job);
    if (!rows.length) { host.innerHTML = ""; host.style.display = "none"; return; }
    host.style.display = "";
    host.innerHTML = "";

    const pageSel = el("select", {
      class: "ck-select", title: "Page",
      onchange: (e) => { state.ui.page = parseInt(e.target.value, 10) || 1; saveUi(); renderResults(job); },
    }, Array.from({ length: pages }, (_, i) => opt(String(i + 1), String(i + 1), String(state.ui.page))));

    const perSel = el("select", {
      class: "ck-select", title: "Rows per page",
      onchange: (e) => { state.ui.perPage = parseInt(e.target.value, 10) || 20; state.ui.page = 1; saveUi(); renderResults(job); },
    }, [10, 20, 30, 40, 50].map((v) => opt(v, String(v), String(per))));

    const go = (p) => { state.ui.page = Math.min(pages, Math.max(1, p)); saveUi(); renderResults(job); };
    const page = state.ui.page;

    const nums = pageList(page, pages).map((item) => item.gap
      ? el("span", { class: "ck-page-gap", text: "…" })
      : el("button", {
          class: "ck-page" + (item.p === page ? " active" : ""), text: String(item.p),
          onclick: () => go(item.p),
        }));

    host.appendChild(el("div", { class: "ck-pager-left" }, [
      el("span", { class: "ck-pager-label", text: "Page #" }),
      pageSel,
      el("span", {
        class: "ck-pager-count",
        text: `${rows.length} ${rows.length === 1 ? "coin" : "coins"} (${start + 1} to ${Math.min(start + per, rows.length)})`,
      }),
      el("span", { class: "ck-pager-label", text: "Per Page" }),
      perSel,
    ]));
    host.appendChild(el("div", { class: "ck-pager-right" }, [
      el("button", {
        class: "ck-page ck-page--nav", text: "« Previous", title: "Previous page",
        onclick: () => go(page - 1), disabled: page <= 1,
      }),
    ].concat(nums, [
      el("button", {
        class: "ck-page ck-page--nav", text: "Next »", title: "Next page",
        onclick: () => go(page + 1), disabled: page >= pages,
      }),
    ])));
  }

  // Chartink shows a single results view - the old view tabs are gone.
  function renderViewTabs() {
    const host = $("#viewTabs");
    if (host) host.innerHTML = "";
  }

  function chartOptions(job) {
    const base = [
      ["__price__", "Price"], ["__change__", "24h %"],
      ["__volume__", "24h Volume"], ["__mcap__", "Market cap"],
    ];
    return base.concat(dynamicCols(job).map((c) => [c, colTitle(job, c)]));
  }

  function chartColId(job) {
    const opts = chartOptions(job);
    const want = state.ui.chartCol;
    for (let i = 0; i < opts.length; i++) if (opts[i][0] === want) return want;
    const dyn = dynamicCols(job);
    return dyn.length ? dyn[0] : "__price__";
  }

  function chartValue(row, colId) {
    const v = resultValue(row, colId);
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  function renderResultChartView(job, host) {
    const opts = chartOptions(job);
    const sel = el("select", {
      class: "ck-select", title: "Column to plot",
      onchange: (e) => { state.ui.chartCol = e.target.value; saveUi(); drawResultChart(); },
    }, opts.map((o) => opt(o[0], o[1], chartColId(job))));

    const rows = searchedRows(job).length;
    host.innerHTML = "";
    host.appendChild(el("div", { class: "ck-chart-head" }, [
      el("label", { class: "field-label", text: "Column" }),
      sel,
      el("span", { class: "hint", text: rows + " coins plotted" }),
    ]));
    host.appendChild(el("canvas", { id: "resultChart", class: "result-chart" }));
    requestAnimationFrame(drawResultChart);
  }

  function drawResultChart() {
    const canvas = $("#resultChart");
    if (!canvas || !state.results) return;
    const job = state.results;
    const kind = state.ui.viewTab;
    const colId = chartColId(job);
    const rows = searchedRows(job);

    let data = rows.map((r) => ({
      label: r.base, row: r, v: chartValue(r, colId),
    })).filter((d) => d.v != null);

    const cssW = Math.max(320, canvas.clientWidth || (canvas.parentNode && canvas.parentNode.clientWidth) || 760);
    const cssH = 340;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!data.length) {
      ctx.fillStyle = "#7f8fa3";
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText("No numeric values to plot", 24, 32);
      return;
    }

    const GREEN = "#22c55e";
    const RED = "#ef4444";
    const BLUE = "#4197F7";
    const GRID = "#1e2a38";
    const MUTED = "#7f8fa3";
    const pad = { t: 20, r: 18, b: 52, l: 62 };
    const W = cssW - pad.l - pad.r;
    const H = cssH - pad.t - pad.b;
    ctx.font = "11px system-ui, sans-serif";

    const frame = (minV, maxV) => {
      ctx.strokeStyle = GRID;
      ctx.fillStyle = MUTED;
      ctx.lineWidth = 1;
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const y = pad.t + (H * i) / ticks;
        ctx.beginPath();
        ctx.moveTo(pad.l, Math.round(y) + 0.5);
        ctx.lineTo(pad.l + W, Math.round(y) + 0.5);
        ctx.stroke();
        const val = maxV - ((maxV - minV) * i) / ticks;
        ctx.textAlign = "right";
        ctx.fillText(fmtCompact(val), pad.l - 8, y + 4);
      }
      ctx.textAlign = "left";
      ctx.strokeStyle = "#2a394b";
      ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, W, H);
    };

    const xLabels = (labels, step) => {
      ctx.fillStyle = MUTED;
      ctx.textAlign = "center";
      for (let i = 0; i < labels.length; i += step) {
        const x = pad.l + (W * (i + 0.5)) / labels.length;
        ctx.fillText(String(labels[i]).slice(0, 8), x, cssH - pad.b + 16);
      }
      ctx.textAlign = "left";
    };

    if (kind === "pie") {
      const sorted = data.slice().sort((a, b) => b.v - a.v);
      const top = sorted.slice(0, 7);
      const restV = sorted.slice(7).reduce((s, d) => s + Math.abs(d.v), 0);
      const slices = top.map((d) => ({ label: d.label, v: Math.abs(d.v) }));
      if (restV > 0) slices.push({ label: "Other", v: restV });
      const total = slices.reduce((s, d) => s + d.v, 0) || 1;
      const cx = cssW * 0.34;
      const cy = cssH / 2;
      const rad = Math.min(cssH, cssW) * 0.32;
      let angle = -Math.PI / 2;
      const palette = [BLUE, GREEN, "#a78bfa", "#f59e0b", "#50B8F1", "#ef4444", "#64749D", "#495567"];
      slices.forEach((s, i) => {
        const sweep = (s.v / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, rad, angle, angle + sweep);
        ctx.closePath();
        ctx.fillStyle = palette[i % palette.length];
        ctx.fill();
        angle += sweep;
      });
      ctx.beginPath();
      ctx.arc(cx, cy, rad * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = "#0a0e13";
      ctx.fill();
      slices.forEach((s, i) => {
        const y = pad.t + 8 + i * 20;
        ctx.fillStyle = palette[i % palette.length];
        ctx.fillRect(cssW * 0.62, y, 10, 10);
        ctx.fillStyle = "#d8e1ec";
        ctx.textAlign = "left";
        ctx.fillText(s.label + "  " + Math.round((s.v / total) * 100) + "%", cssW * 0.62 + 16, y + 9);
      });
      return;
    }

    if (kind === "heatmap") {
      const cells = data.slice(0, 96);
      const vals = cells.map((d) => d.v);
      const minV = Math.min.apply(null, vals);
      const maxV = Math.max.apply(null, vals);
      const span = (maxV - minV) || 1;
      const colsN = Math.max(4, Math.round(Math.sqrt(cells.length * (W / H)) + 1));
      const rowsN = Math.ceil(cells.length / colsN);
      const cw = W / colsN;
      const ch = H / rowsN;
      cells.forEach((d, i) => {
        const cx0 = pad.l + (i % colsN) * cw;
        const cy0 = pad.t + Math.floor(i / colsN) * ch;
        const t = (d.v - minV) / span;
        ctx.fillStyle = t >= 0.5
          ? "rgba(34,197,94," + (0.18 + t * 0.72) + ")"
          : "rgba(239,68,68," + (0.18 + (1 - t) * 0.72) + ")";
        ctx.fillRect(cx0 + 1, cy0 + 1, cw - 2, ch - 2);
        if (cw > 42 && ch > 18) {
          ctx.fillStyle = "#0a0e13";
          ctx.textAlign = "center";
          ctx.fillText(String(d.label).slice(0, 6), cx0 + cw / 2, cy0 + ch / 2 + 3);
          ctx.textAlign = "left";
        }
      });
      ctx.fillStyle = MUTED;
      ctx.fillText("high " + fmtCompact(maxV) + "  ·  low " + fmtCompact(minV), pad.l, cssH - 14);
      return;
    }

    if (kind === "scatter") {
      const pts = data.map((d) => ({
        x: d.row.market_cap ? Math.log10(d.row.market_cap) : (d.row.price || 1),
        y: d.v, label: d.label,
      })).filter((p) => isFinite(p.x));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const x0 = Math.min.apply(null, xs);
      const x1 = Math.max.apply(null, xs);
      let y0 = Math.min.apply(null, ys);
      let y1 = Math.max.apply(null, ys);
      if (y0 === y1) { y0 -= 1; y1 += 1; }
      frame(y0, y1);
      pts.forEach((p) => {
        const px = pad.l + ((p.x - x0) / ((x1 - x0) || 1)) * W;
        const py = pad.t + H - ((p.y - y0) / (y1 - y0)) * H;
        ctx.beginPath();
        ctx.arc(px, py, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = BLUE;
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
      });
      ctx.fillStyle = MUTED;
      ctx.textAlign = "center";
      ctx.fillText("market cap (log₁₀) →", pad.l + W / 2, cssH - 14);
      ctx.textAlign = "left";
      return;
    }

    if (kind === "bar" || kind === "billboard") {
      const limit = 40;
      let set = data.slice(0, limit);
      if (kind === "billboard") set = data.slice().sort((a, b) => b.v - a.v).slice(0, limit);
      const vals = set.map((d) => d.v);
      const minV = Math.min(0, Math.min.apply(null, vals));
      const maxV = Math.max(0, Math.max.apply(null, vals));
      const span = (maxV - minV) || 1;
      const y0 = (v) => pad.t + H - ((v - minV) / span) * H;
      frame(minV, maxV);
      const bw = W / set.length;
      set.forEach((d, i) => {
        const x = pad.l + i * bw + bw * 0.16;
        const top = y0(Math.max(0, d.v));
        const bot = y0(Math.min(0, d.v));
        ctx.fillStyle = d.v < 0 ? RED : GREEN;
        ctx.fillRect(x, top, bw * 0.68, Math.max(1, bot - top));
      });
      xLabels(set.map((d) => d.label), Math.max(1, Math.ceil(set.length / 12)));
      return;
    }

    if (kind === "stacked") {
      const limit = 40;
      const set = data.slice(0, limit);
      const secondId = dynamicCols(job).filter((c) => c !== colId)[0] || "__change__";
      const set2 = set.map((d) => ({ v: chartValue(d.row, secondId) || 0 }));
      const tops = set.map((d, i) => d.v + set2[i].v);
      const minV = Math.min(0, Math.min.apply(null, tops), Math.min.apply(null, set.map((d) => d.v)));
      const maxV = Math.max(0, Math.max.apply(null, tops));
      const span = (maxV - minV) || 1;
      const y0 = (v) => pad.t + H - ((v - minV) / span) * H;
      frame(minV, maxV);
      const bw = W / set.length;
      set.forEach((d, i) => {
        const x = pad.l + i * bw + bw * 0.16;
        const w = bw * 0.68;
        ctx.fillStyle = BLUE;
        ctx.fillRect(x, y0(d.v), w, Math.max(1, y0(0) - y0(d.v)));
        ctx.fillStyle = "#a78bfa";
        ctx.fillRect(x, y0(d.v + set2[i].v), w, Math.max(1, y0(d.v) - y0(d.v + set2[i].v)));
      });
      xLabels(set.map((d) => d.label), Math.max(1, Math.ceil(set.length / 12)));
      ctx.fillStyle = BLUE;
      ctx.fillRect(pad.l, cssH - 20, 10, 10);
      ctx.fillStyle = MUTED;
      ctx.fillText(colTitle(job, colId), pad.l + 14, cssH - 11);
      ctx.fillStyle = "#a78bfa";
      ctx.fillRect(pad.l + 150, cssH - 20, 10, 10);
      ctx.fillStyle = MUTED;
      ctx.fillText(colTitle(job, secondId), pad.l + 164, cssH - 11);
      return;
    }

    // line / area
    const set = data.slice(0, 400);
    const vals = set.map((d) => d.v);
    let minV = Math.min.apply(null, vals);
    let maxV = Math.max.apply(null, vals);
    if (minV === maxV) { minV -= Math.abs(minV) * 0.05 || 1; maxV += Math.abs(maxV) * 0.05 || 1; }
    const span = (maxV - minV) || 1;
    const step = W / Math.max(1, set.length - 1);
    const px = (i) => pad.l + i * step;
    const py = (v) => pad.t + H - ((v - minV) / span) * H;
    frame(minV, maxV);

    if (kind === "area") {
      const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + H);
      grad.addColorStop(0, "rgba(65,151,247,0.45)");
      grad.addColorStop(1, "rgba(65,151,247,0.02)");
      ctx.beginPath();
      ctx.moveTo(px(0), py(set[0].v));
      set.forEach((d, i) => ctx.lineTo(px(i), py(d.v)));
      ctx.lineTo(px(set.length - 1), pad.t + H);
      ctx.lineTo(px(0), pad.t + H);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    set.forEach((d, i) => { if (i === 0) ctx.moveTo(px(i), py(d.v)); else ctx.lineTo(px(i), py(d.v)); });
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    xLabels(set.map((d) => d.label), Math.max(1, Math.ceil(set.length / 10)));
  }

  function renderResults(job) {
    const host = $("#resultsBody");
    if (!host) return;

    const rows = (job.results || []).length;
    const hint = $("#resultCount");
    if (hint) {
      hint.textContent = rows ? `${rows} results` : "0 results";
      hint.title = `${job.matched} of ${job.scanned} coins matched` +
        (job.skipped ? ` · ${job.skipped} too new to scan` : "") +
        (job.error_count ? ` · ${job.error_count} errors` : "") +
        ` · ${job.clause}`;
    }

    if (!rows) {
      host.innerHTML = '<div class="ck-empty">No stocks present</div>' +
        (job.error_count
          ? `<div class="ck-empty-note">${job.error_count} coin(s) could not be read</div>` : "");
      const pager = $("#resultsPager");
      if (pager) { pager.innerHTML = ""; pager.style.display = "none"; }
      return;
    }

    renderResultTable(job, host);
    renderResultPager(job);
  }

  /* --------------------------------------------- Chartink results settings */
  function openNewCharts(job) {
    const rows = searchedRows(job);
    if (!rows.length) {
      toast("Open New Charts", "Run a scan first - there is nothing to open.", "err", 4200);
      return;
    }
    let opened = 0;
    rows.slice(0, 5).forEach((r) => {
      try {
        const w = window.open("#/chart/" + r.symbol, "_blank");
        if (w) opened++;
      } catch (e) { /* popup blocked */ }
    });
    toast("Open New Charts",
      opened ? `${opened} chart tab${opened === 1 ? "" : "s"} opened`
             : "Your browser blocked the new tabs",
      opened ? "ok" : "err", 4200);
  }

  // Floating chart card shown while hovering a result row.
  let previewEl = null;

  function hideChartPreview() {
    if (previewEl && previewEl.parentNode) previewEl.parentNode.removeChild(previewEl);
    previewEl = null;
  }

  function showChartPreview(row, ev) {
    hideChartPreview();
    const spark = (row.spark || []).filter((v) => typeof v === "number" && isFinite(v));
    const price = row.price == null ? "-" : fmtPrice(row.price);
    const chg = row.change_pct == null ? 0 : row.change_pct;
    previewEl = el("div", { class: "ck-preview" }, [
      el("div", { class: "ck-preview-head" }, [
        el("b", { text: row.symbol }),
        el("span", { class: chg >= 0 ? "pos" : "neg", text: (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" }),
      ]),
      el("div", { class: "ck-preview-price", text: price }),
      el("canvas", { class: "ck-preview-canvas", width: "260", height: "76" }),
      el("div", { class: "ck-preview-name dim", text: row.name || row.base || "" }),
    ]);
    document.body.appendChild(previewEl);

    const cv = previewEl.querySelector("canvas");
    if (cv && spark.length > 1) {
      const ctx = cv.getContext("2d");
      const min = Math.min.apply(null, spark);
      const max = Math.max.apply(null, spark);
      const span = max - min || 1;
      const w = cv.width, h = cv.height;
      const up = spark[spark.length - 1] >= spark[0];
      ctx.lineWidth = 2;
      ctx.strokeStyle = up ? "#22c55e" : "#ef4444";
      ctx.beginPath();
      spark.forEach((v, i) => {
        const x = (i / (spark.length - 1)) * (w - 4) + 2;
        const y = h - 6 - ((v - min) / span) * (h - 12);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    const x = Math.min(ev.clientX + 18, window.innerWidth - 292);
    const y = Math.min(ev.clientY + 18, window.innerHeight - 170);
    previewEl.style.left = Math.max(8, x) + "px";
    previewEl.style.top = Math.max(8, y) + "px";
  }

  /* --------------------------------------------------------- result extras */
  function resultMatrix(job) {
    const cols = dynamicCols(job);
    const rows = searchedRows(job);
    const head = ["Sr.", "Stock Name", "Symbol", "Exchange", "Halal", "Price", "24h %"]
      .concat(cols, ["24h Volume", "Market cap"]);
    const body = rows.map((r, i) => [
      i + 1, r.name || r.base, r.symbol, (r.exchanges || []).join(" "),
      (r.halal_votes || 0) + "/5", r.price, r.change_pct,
    ].concat(cols.map((c) => (r.values || {})[c]), [r.quote_volume, r.market_cap || ""]));
    return { head, body, rows };
  }

  function downloadBlob(filename, mime, text) {
    try {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch (e) { return false; }
  }

  function csvCell(v) {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv(job) {
    const { head, body } = resultMatrix(job);
    const csv = [head.map(csvCell).join(",")]
      .concat(body.map((r) => r.map(csvCell).join(","))).join("\r\n");
    const ok = downloadBlob("screener-results.csv", "text/csv;charset=utf-8", csv);
    toast(ok ? "CSV downloaded" : "Could not download", "screener-results.csv", ok ? "ok" : "err");
  }

  function exportExcel(job) {
    const { head, body } = resultMatrix(job);
    const esc2 = (v) => String(v == null ? "" : v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const html = "<html><head><meta charset='utf-8'></head><body><table border='1'>" +
      "<tr>" + head.map((h) => "<th>" + esc2(h) + "</th>").join("") + "</tr>" +
      body.map((r) => "<tr>" + r.map((c) => "<td>" + esc2(c) + "</td>").join("") + "</tr>").join("") +
      "</table></body></html>";
    const ok = downloadBlob("screener-results.xls", "application/vnd.ms-excel", html);
    toast(ok ? "Excel file downloaded" : "Could not download", "screener-results.xls", ok ? "ok" : "err");
  }

  function copyResults(job, what) {
    let text;
    if (what === "table") {
      const { head, body } = resultMatrix(job);
      text = [head.join("\t")].concat(body.map((r) => r.join("\t"))).join("\n");
    } else if (what === "page") {
      text = pagedRows(job).page.map((r) => r.symbol).join("\n");
    } else {
      text = searchedRows(job).map((r) => r.symbol).join("\n");
    }
    writeClipboard(text, (ok) => toast(ok ? "Copied to clipboard" : "Could not copy",
      what === "table" ? "table" : text.split("\n").length + " symbols", ok ? "ok" : "err"));
  }

  function openAddColumnMenu(anchor) {
    const job = state.results;
    const have = (job && job.columns) || [];
    const items = [{ header: "Add Column" }];
    (state.catalog || []).forEach((group) => {
      items.push({ divider: true });
      items.push({ header: group.cat });
      (group.fields || []).forEach((f) => {
        const id = f.params.length ? f.key + "(" + f.params.map((p) => p.default).join(",") + ")" : f.key;
        items.push({
          label: f.label + (f.params.length ? " (" + f.params.map((p) => p.name).join(", ") + ")" : ""),
          active: have.indexOf(id) !== -1,
          onClick: () => addExtraColumn(id, f.label),
        });
      });
    });
    popMenu(anchor, items, { width: 280 });
  }

  async function addExtraColumn(id, label) {
    const ui = state.ui;
    ui.extraCols = ui.extraCols || [];
    if (ui.extraCols.indexOf(id) !== -1) { toast("Column already added", id, "ok"); return; }
    ui.hiddenCols = (ui.hiddenCols || []).filter((c) => c !== id);
    ui.extraCols.push(id);
    if (state.results) {
      // Materialise the visible order first so the new column lands last.
      const order = orderedCols(state.results);
      if (order.indexOf(id) === -1) order.push(id);
      ui.colOrder = order;
    }
    saveUi();
    toast("Adding column", label || id, "ok", 2000);

    const job = state.results;
    if (!job || !job.results || !job.results.length) return;
    if ((job.columns || []).indexOf(id) !== -1) { renderResults(job); return; }

    try {
      const res = await api("/api/columns", {
        method: "POST",
        body: {
          symbols: job.results.map((r) => r.symbol),
          columns: [id],
          interval: state.interval,
        },
      });
      (res.fields || []).forEach((f) => {
        if (!(job.fields || []).some((x) => x.id === f.id)) (job.fields = job.fields || []).push(f);
      });
      job.results.forEach((r) => {
        const v = (res.values || {})[r.symbol];
        if (v) { r.values = r.values || {}; Object.assign(r.values, v); }
      });
      job.columns = (job.columns || []).concat([id]);
      renderResults(job);
    } catch (e) {
      ui.extraCols = ui.extraCols.filter((c) => c !== id);
      saveUi();
      toast("Could not add column", e.message, "err");
    }
  }

  function removeExtraColumn(id) {
    const ui = state.ui;
    ui.extraCols = (ui.extraCols || []).filter((c) => c !== id);
    ui.colOrder = (ui.colOrder || []).filter((c) => c !== id);
    saveUi();
    if (state.results && state.results.columns) {
      state.results.columns = state.results.columns.filter((c) => c !== id);
      renderResults(state.results);
    }
  }

  /* -------------------------------------------------------- settings menus */
  function autoRefreshToggle(job) {
    return {
      toggle: true, label: "Auto Refresh", hint: "every 60s", on: state.ui.autoRefresh,
      onChange: (v) => {
        state.ui.autoRefresh = v;
        saveUi();
        if (!v && state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
        toast(v ? "Auto refresh on" : "Auto refresh off",
          v ? "the scan reruns every 60 seconds" : "", "ok", 2400);
      },
    };
  }

  function halalToggle() {
    return {
      toggle: true, label: "Halal coins only", hint: "3 of 5 platforms", on: state.ui.halalOnly,
      onChange: (v) => {
        state.ui.halalOnly = v;
        saveUi();
        const hint = $("#noticeHalal");
        if (hint) hint.textContent = v
          ? "Halal screen ON — only coins marked compliant by 3 of the 5 platforms are shown."
          : "Halal screen OFF — every spot USDT pair is shown.";
        toast(v ? "Halal coins only" : "Showing every spot coin",
          v ? "majority of the 5 platforms" : "halal filter lifted", "ok", 2600);
      },
    };
  }

  function settingsMenu(anchor, kind, job) {
    const items = [];
    if (kind === "results") {
      // Chartink's results settings, verbatim: Copy symbols [All|Page],
      // Open New Charts, Show chart preview, Auto Refresh, scope toggles.
      items.push({
        custom: el("div", { class: "ck-menu-row" }, [
          el("span", { class: "ck-menu-label", text: "Copy symbols" }),
          el("span", { class: "ck-menu-chips" }, [
            el("button", {
              class: "ck-menu-chip", text: "All", title: "Copy every matched symbol",
              onclick: () => { closeMenus(); copyResults(job, "all"); },
            }),
            el("button", {
              class: "ck-menu-chip", text: "Page", title: "Copy the symbols on this page",
              onclick: () => { closeMenus(); copyResults(job, "page"); },
            }),
          ]),
        ]),
      });
      items.push({ divider: true });
      items.push({
        label: "Open New Charts", icon: "monitor",
        onClick: () => { closeMenus(); openNewCharts(job); },
      });
      items.push({
        label: "Show chart preview", toggle: true, on: state.ui.chartPreview !== false,
        onChange: (v) => { state.ui.chartPreview = v; saveUi(); if (job) renderResults(job); },
      });
      items.push(autoRefreshToggle(job));
      items.push({ divider: true });
      items.push(halalToggle());
      items.push({ divider: true });
      items.push({ header: "Exchange segment" });
      items.push({
        custom: segmented(SEGMENTS, state.ui.segment, (v) => {
          closeMenus();
          state.ui.segment = v;
          saveUi();
          const hint = $("#segmentHint");
          if (hint) hint.textContent = segmentLabel();
        }, "ck-menu-seg"),
      });
    } else {
      items.push({ header: "Scan scope" });
      items.push(halalToggle());
      items.push({ label: "How halal is decided", icon: "info", onClick: () => { closeMenus(); openHalalInfo(); } });
      items.push({ divider: true });
      items.push({ header: "Halal screen" });
      items.push({ divider: true });
      items.push({ header: "Exchange segment" });
      items.push({
        custom: segmented(SEGMENTS, state.ui.segment, (v) => {
          closeMenus();
          state.ui.segment = v;
          saveUi();
          const hint = $("#segmentHint");
          if (hint) hint.textContent = segmentLabel();
        }, "ck-menu-seg"),
      });
      items.push({ divider: true });
      items.push({ header: "Timeframe" });
      items.push({
        custom: segmented(["15m", "1h", "4h", "1d", "1w"].map((v) => [v, v]), state.interval, (v) => {
          closeMenus();
          state.interval = v;
          paintScreener();
        }, "ck-menu-seg"),
      });
      items.push({ divider: true });
      items.push({ header: "Universe (top pairs by 24h volume)" });
      items.push({
        custom: segmented(["50", "100", "200", "400", "600"].map((v) => [v, v]),
          String(state.universe), (v) => {
            closeMenus();
            state.universe = parseInt(v, 10);
            paintScreener();
          }, "ck-menu-seg"),
      });
      items.push({ divider: true });
      items.push(autoRefreshToggle(job));
      items.push({
        label: "Spot only — no futures, no leverage", icon: "check",
        onClick: () => toast("Spot only", "Futures, shorting and leveraged tokens are never part of this universe.", "ok", 4000),
      });
    }
    popMenu(anchor, items, { width: 268 });
  }

  function openHalalInfo() {
    const body = [el("div", {
      class: "hint",
      text: "A coin is halal when 3 or more of the 5 screening platforms below mark it compliant. Grey, mashbooh and un-assessed coins do not count as a vote.",
    })];
    const list = el("div", { class: "halal-platforms" });
    list.appendChild(el("div", { class: "hint", text: "Loading platform list…" }));
    body.push(list);
    modal({ title: "How halal is decided", body, actions: [{ label: "Ok" }] });

    api("/api/halal").then((data) => {
      list.innerHTML = "";
      (data.platforms || []).forEach((p) => {
        const count = (data.summary && data.summary.by_platform && data.summary.by_platform[p.id])
          ? data.summary.by_platform[p.id].halal : null;
        list.appendChild(el("div", { class: "halal-platform" }, [
          el("b", { text: p.name || p.id }),
          el("span", { class: "hint", text: p.note || p.url || "" }),
          count != null ? el("span", { class: "halal-badge yes" }, [el("b", { text: count + " halal" })]) : null,
        ]));
      });
      list.appendChild(el("div", {
        class: "hint",
        text: `${(data.summary || {}).assessed || 0} coins assessed · ${(data.summary || {}).halal || 0} halal · updated ${(data.summary || {}).updated || ""}`,
      }));
    }).catch(() => { list.innerHTML = '<div class="hint">Could not load the halal data.</div>'; });
  }

  /* --------------------------------------------------------- saved scans */
  function loadMyScans() {
    try {
      const rows = JSON.parse(localStorage.getItem("cx_my_scans") || "[]");
      return Array.isArray(rows) ? rows : [];
    } catch (e) { return []; }
  }

  function persistMyScans(rows) {
    try { localStorage.setItem("cx_my_scans", JSON.stringify(rows)); return true; }
    catch (e) { return false; }
  }

  /* ------------------------------------------------------------ scan loves */
  function loadLikes() {
    try { return JSON.parse(localStorage.getItem("cx_likes") || "{}"); }
    catch (e) { return {}; }
  }

  function likeKey() {
    return (state.loadedScan && state.loadedScan.id) || "adhoc";
  }

  function likeCount() {
    const map = loadLikes();
    return map[likeKey()] || 0;
  }

  function toggleLike() {
    const map = loadLikes();
    const key = likeKey();
    map[key] = map[key] ? 0 : 1;
    try { localStorage.setItem("cx_likes", JSON.stringify(map)); } catch (e) { /* private mode */ }
    paintScreener();
    toast(map[key] ? "Loved this scan" : "Un-loved", "", map[key] ? "ok" : "", 2400);
  }

  // Chartink's "Monitor on dashboard" - keep an eye on today's matches.
  function monitorOnDashboard() {
    const rows = searchedRows(state.results);
    if (!rows.length) {
      toast("Monitor on dashboard", "Run a scan first - there is nothing to monitor.", "err", 4200);
      return;
    }
    let added = 0;
    rows.forEach((r) => {
      if (r.symbol && !isWatched(r.symbol)) { if (toggleWatch(r.symbol)) added++; }
    });
    toast("Monitor on dashboard",
      added ? `${added} coin(s) added to your watchlist` : "every match is already on your watchlist",
      "ok", 4200);
  }

  function shareScan() {
    const url = location.origin + location.pathname +
      "#/screener?c=" + encodeURIComponent(currentClause());
    writeClipboard(url, (ok) => toast(ok ? "Link copied" : "Could not copy", url, ok ? "ok" : "err"));
  }

  function saveScan(saveAs) {
    const nameInput = el("input", {
      type: "text", id: "scan_name", style: "width:100%",
      placeholder: "What does the Screener scan?",
      value: saveAs ? "" : "",
    });
    const descInput = el("textarea", { rows: "3", style: "width:100%", placeholder: "Description for your scan" });
    const error = el("p", { id: "scan_name_error", class: "err-line", role: "alert" });

    modal({
      title: saveAs ? "Save as" : "Save Scan",
      name: "save-scan-modal",
      body: [
        el("div", {}, [
          el("label", { class: "field-label", text: "Name:" }),
          nameInput, error,
        ]),
        el("div", {}, [
          el("label", { class: "field-label", text: "Description:" }),
          descInput,
        ]),
        el("div", { class: "hint", text: "Saved scans appear at the top of your Scan Library." }),
      ],
      actions: [
        { label: "Cancel" },
        {
          label: "Save", kind: "primary",
          onClick: () => {
            const name = nameInput.value.trim();
            if (!name) {
              error.textContent = "Please enter a name for this scan.";
              nameInput.focus();
              return false;
            }
            const rows = loadMyScans();
            const entry = {
              id: "my-" + Date.now().toString(36),
              name,
              cat: "My scans",
              clause: currentClause(),
              desc: descInput.value.trim(),
              mine: true,
            };
            rows.unshift(entry);
            if (!persistMyScans(rows)) {
              toast("Could not save", "browser storage is unavailable", "err");
              return false;
            }
            state.presets = (state.presets || []).filter((p) => !p.mine).concat(rows);
            state.loadedScan = { id: entry.id, name: entry.name };
            toast("Scan saved", name, "ok");
            setTimeout(() => paintScreener(), 0);
            return true;
          },
        },
      ],
    });
    setTimeout(() => { const n = $("#scan_name"); if (n) n.focus(); }, 0);
  }

  /* -------------------------------------------------------- magic filters */
  // Chartink's four example prompts, shown as chips under the prompt box.
  const MAGIC_CHIPS = [
    "latest close between 100 and 2000",
    "supertrend and macd positive",
    "Three black soldiers",
    "Bullish engulfing",
  ];

  function nlToClause(text) {
    const out = [];
    const t = " " + String(text || "").toLowerCase().replace(/[;,+/]/g, " and ") + " ";
    const num = (m) => parseFloat(String(m).replace(/,/g, ""));
    let m;

    const dma = (n) => "[close] > [sma(" + n + ")]";
    const comparators = {
      "above": ">", "over": ">", "greater than": ">", "more than": ">", "higher than": ">",
      "below": "<", "under": "<", "less than": "<", "fewer than": "<", "lower than": "<",
      "at least": ">=", ">= ": ">=",
    };

    // --- the four magic-filter examples (candle offsets and all) -----------
    const between = /close\s+between\s+([\d.,]+)\s+and\s+([\d.,]+)/.exec(t);
    if (between) {
      out.push("[close] > " + num(between[1]));
      out.push("[close] < " + num(between[2]));
    }

    if (/supertrend/.test(t)) out.push("[supertrend_dir(10,3)] > 0");

    // Three black soldiers - three closed candles in a row closing lower.
    if (/(three|3)\s+black\s+(soldier|candle|candles|soldiers)/.test(t)) {
      out.push("closed [close] < closed [open]");
      out.push("2nd closed [close] < 2nd closed [open]");
      out.push("3rd closed [close] < 3rd closed [open]");
    }

    // Bullish engulfing - a green candle swallowing the red one before it.
    if (/bullish\s+engulfing/.test(t)) {
      out.push("closed [close] > closed [open]");
      out.push("2nd closed [close] < 2nd closed [open]");
      out.push("closed [close] > 2nd closed [open]");
      out.push("closed [open] < 2nd closed [close]");
    }

    if (/\boversold\b/.test(t)) out.push("[rsi(14)] < 30");
    if (/\boverbought\b/.test(t)) out.push("[rsi(14)] > 70");

    const reRsi = /\brsi\b[^0-9<>a-z]{0,12}(above|over|below|under|greater than|less than|<|>|>=|<=|=)?\s*(\d+(?:\.\d+)?)?/g;
    while ((m = reRsi.exec(t)) !== null) {
      if (m[2] == null) continue;
      const op = comparators[m[1]] || "<";
      out.push("[rsi(14)] " + op + " " + num(m[2]));
    }

    const reDma = /(\d{1,4})\s*(?:day|dma|dema|sma)?\s*(?:moving average|dma|ema)?\s*(above|below|crossed above|crossed below)?/.exec(t);
    if (reDma && /(dma|moving average|ema|sma)/.test(t) && /(above|below)/.test(t)) {
      const n = num(reDma[1]);
      if (n >= 5 && n <= 1000) {
        out.push(reDma[2] === "below" ? "[close] < [sma(" + n + ")]" : dma(n));
      }
    }

    const reUp = /\b(up|up by|higher|rising|gaining|rising by|up more than)\s*(?:by|than)?\s*(\d+(?:\.\d+)?)\s*%/;
    const mu = reUp.exec(t);
    if (mu) out.push("[change_pct] > " + num(mu[2]));

    const reDown = /\b(down|down by|lower|falling|dropping|losing)\s*(?:by|than)?\s*(\d+(?:\.\d+)?)\s*%/;
    const md = reDown.exec(t);
    if (md) out.push("[change_pct] < -" + num(md[2]));

    const rePriceAbove = /\b(?:price|close)\s+(above|over|greater than|below|under|less than)\s+(\d+(?:\.\d+)?)/;
    const mp = rePriceAbove.exec(t);
    if (mp) out.push("[close] " + comparators[mp[1]] + " " + num(mp[2]));

    if (/(rising volume|volume (up|increasing|higher)|higher volume|high volume)/.test(t)) {
      out.push("[volume_ratio(20)] > 1.5");
    }
    if (/(falling volume|volume (down|decreasing|lower))/.test(t)) out.push("[volume_ratio(20)] < 1");

    const reMcap = /\b(?:market cap|mcap)\s+(above|over|below|under|greater than|less than)\s+(\d+(?:\.\d+)?)\s*([bmt])?/;
    const mm = reMcap.exec(t);
    if (mm) {
      const scale = mm[3] === "b" ? 1e9 : mm[3] === "m" ? 1e6 : mm[3] === "t" ? 1e12 : 1;
      out.push("[market_cap] " + comparators[mm[1]] + " " + (num(mm[2]) * scale));
    }

    if (/\bmacd\b/.test(t) && /(above|over|positive)/.test(t)) out.push("[macd_histogram(12,26,9)] > 0");
    if (/\bmacd\b/.test(t) && /(below|under|negative)/.test(t)) out.push("[macd_histogram(12,26,9)] < 0");

    const reVol = /\bvolume\s+(above|over|greater than|below|under|less than)\s+(\d+(?:\.\d+)?)\s*([bmk])?/;
    const mv = reVol.exec(t);
    if (mv) {
      const scale = mv[3] === "b" ? 1e9 : mv[3] === "m" ? 1e6 : mv[3] === "k" ? 1e3 : 1;
      out.push("[quote_volume_24h] " + comparators[mv[1]] + " " + (num(mv[2]) * scale));
    }

    const unique = out.filter((c, i) => out.indexOf(c) === i);
    if (!unique.length) {
      throw new Error(
        "Try things like: rsi below 30, price above 200 dma, up 4% and rising volume, market cap above 1b"
      );
    }
    return unique.join(" and ");
  }

  async function magicGenerate() {
    const box = $("#magicPrompt");
    if (!box) return;
    const text = box.value.trim();
    if (!text) {
      toast("Magic Filters", "Describe the filter you want, e.g. 'coins up by 4% and rising volume'.", "err", 4500);
      box.focus();
      return;
    }
    const btn = $("#magicGenerate");
    if (btn) { btn.disabled = true; btn.textContent = "Generating."; btn.setAttribute("aria-busy", "true"); }

    let clause;
    try { clause = nlToClause(text); }
    catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "Generate"; }
      toast("Magic Filters", e.message, "err", 6000);
      return;
    }

    try {
      if (state.ui.magicMode === "replace") {
        await applyTextClause(clause);
      } else {
        const group = state.tree;
        const res = await api("/api/parse?clause=" + encodeURIComponent(clause));
        let node = treeFromAst(res.ast);
        if (node.type !== "group") {
          node = { type: "group", join: "all", logic: "AND", negate: false, enabled: true, children: [node] };
        }
        node.children.forEach((c) => group.children.push(c));
        renderBuilder();
        toast("Filters appended", res.clause, "ok", 3000);
      }
      box.value = "";
    } catch (e) {
      toast("Magic Filters failed", e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Generate"; btn.removeAttribute("aria-busy"); }
    }
  }

  /* ------------------------------------------------------- draw a pattern */
  // Chartink's magic "Draw" button: sketch a path and it becomes a clause of
  // candle-to-candle comparisons, oldest candle on the left.
  function openDrawPattern() {
    const W = 520, H = 210;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    cv.className = "ck-draw-canvas";
    const ctx = cv.getContext("2d");
    let pts = [];

    const redraw = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0b111b";
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(255,255,255,.06)";
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= W; gx += W / 8) {
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
      }
      for (let gy = 0; gy <= H; gy += H / 4) {
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
      }
      if (pts.length > 1) {
        ctx.strokeStyle = "#50B8F1";
        ctx.lineWidth = 2.5;
        ctx.lineJoin = "round";
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
      }
      if (!pts.length) {
        ctx.fillStyle = "rgba(255,255,255,.35)";
        ctx.font = "13px system-ui, sans-serif";
        ctx.fillText("Draw a shape from left (oldest candle) to right (candle now forming)", 24, H / 2);
      }
    };
    redraw();

    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (W / r.width),
        y: (e.clientY - r.top) * (H / r.height),
      };
    };
    cv.addEventListener("mousedown", (e) => { pts.push(local(e)); redraw(); });
    cv.addEventListener("mousemove", (e) => {
      if (e.buttons !== 1) return;
      pts.push(local(e));
      redraw();
    });

    // Sample the sketch at four evenly spaced x positions = four candles.
    const samplePath = () => {
      if (pts.length < 2) return null;
      const xs = pts.map((p) => p.x);
      const minX = Math.min.apply(null, xs);
      const maxX = Math.max.apply(null, xs);
      if (maxX - minX < 10) return null;
      const out = [];
      for (let i = 0; i < 4; i++) {
        const target = minX + ((maxX - minX) * i) / 3;
        let best = pts[0];
        let bestD = Infinity;
        pts.forEach((p) => {
          const d = Math.abs(p.x - target);
          if (d < bestD) { bestD = d; best = p; }
        });
        out.push(best.y);
      }
      return out;
    };

    const preview = el("p", { class: "hint", text: "The shape becomes three candle-to-candle comparisons." });

    const apply = () => {
      const ys = samplePath();
      if (!ys) {
        toast("Draw pattern", "Draw a path first - click and drag across the box.", "err", 4200);
        return false;
      }
      const bars = ["3rd closed", "2nd closed", "closed", "current"];
      const parts = [];
      for (let i = 0; i < 3; i++) {
        const rising = ys[i + 1] < ys[i];
        parts.push(bars[i + 1] + " [close] " + (rising ? ">" : "<") + " " + bars[i] + " [close]");
      }
      const clause = parts.join(" and ");
      applyTextClause(clause).then(() => {
        toast("Pattern applied", clause, "ok", 5000);
      }).catch((e) => toast("Could not apply pattern", e.message, "err"));
      return true;
    };

    modal({
      title: "Draw pattern",
      body: [
        el("p", {
          class: "hint",
          text: "Sketch the shape you want the last four candles to follow. The left edge is the oldest candle, the right edge is the candle still forming.",
        }),
        cv,
        preview,
      ],
      actions: [
        { label: "Cancel" },
        {
          label: "Clear", close: false,
          onClick: () => { pts = []; redraw(); return false; },
        },
        { label: "Apply to builder", kind: "ck-btn ck-btn--run", onClick: apply },
      ],
    });
  }

  function openAlertModal(row) {
    const nameInput = el("input", { type: "text", value: "Alert: " + currentClause().slice(0, 60), style: "width:100%" });
    const clauseInput = el("textarea", { rows: "4", style: "width:100%" });
    clauseInput.value = row && row.symbol
      ? currentClause() + " and [close] > 0"
      : currentClause();
    const meta = el("div", { class: "hint" },
      [`${state.interval} timeframe · top ${state.universe} · ${segmentLabel()} segment · ${state.ui.halalOnly ? "halal coins only" : "every spot coin"}`]);
    modal({
      title: "Create alert",
      body: [
        el("div", {}, [el("label", { class: "field-label", text: "Name" }), nameInput]),
        el("div", {}, [el("label", { class: "field-label", text: "Scan clause" }), clauseInput]),
        meta,
        el("div", { class: "hint", text: "The alert engine reruns this scan every few minutes and notifies you when a coin newly matches." }),
      ],
      actions: [
        { label: "Cancel" },
        {
          label: "Create alert", kind: "primary",
          onClick: async () => {
            try {
              await api("/api/alerts", {
                method: "POST",
                body: {
                  name: nameInput.value,
                  clause: clauseInput.value,
                  interval: state.interval,
                  universe: state.universe,
                  venue: state.ui.segment,
                },
              });
              toast("Alert created", nameInput.value, "ok");
              return true;
            } catch (e) { toast("Could not create alert", e.message, "err"); return false; }
          },
        },
      ],
    });
  }

  /* ========================================================= screener page */
  let pendingClause = null;
  let pendingClauseDone = null;

  // Parse a clause and load it into the builder. `onDone(ok)` fires once the
  // builder is actually in sync, so callers can sequence work behind it.
  async function applyTextClause(text, onDone) {
    try {
      const res = await api("/api/parse?clause=" + encodeURIComponent(text));
      let tree = treeFromAst(res.ast);
      if (!tree || tree.type !== "group") {
        tree = normGroup({
          type: "group", logic: "AND", join: "all", negate: false, enabled: true,
          children: [tree || defaultCond()],
        });
      }
      state.tree = tree;
      renderBuilder();
      toast("Clause applied", res.clause, "ok", 2600);
      if (onDone) onDone(true);
      return res.clause;
    } catch (e) {
      toast("Invalid clause", e.message, "err");
      if (onDone) onDone(false);
      throw e;
    }
  }

  function columnsPanel() {
    const job = state.results;
    const cols = orderedCols(job);
    const list = el("div", { class: "ck-col-list" });

    if (!cols.length) {
      list.appendChild(el("div", {
        class: "ck-empty",
        text: "No columns yet. Run a scan, or use the + in the table header to add one.",
      }));
    }

    cols.forEach((c, i) => {
      const hidden = (state.ui.hiddenCols || []).indexOf(c) !== -1;
      const extra = (state.ui.extraCols || []).indexOf(c) !== -1;
      const move = (delta) => {
        const order = orderedCols(job);
        const from = order.indexOf(c);
        const to = from + delta;
        if (to < 0 || to >= order.length) return;
        order.splice(to, 0, order.splice(from, 1)[0]);
        state.ui.colOrder = order;
        saveUi();
        paintScreener();
        if (state.results) renderResults(state.results);
      };

      list.appendChild(el("div", { class: "ck-col" + (hidden ? " is-hidden" : "") }, [
        el("span", { class: "ck-col-grip" }, [icon("grip")]),
        el("span", { class: "ck-col-name" }, [
          el("b", { text: colTitle(job, c) }),
          el("span", { class: "hint", text: extra ? "added column" : "from filters" }),
        ]),
        el("span", { class: "ck-col-actions" }, [
          el("button", { class: "ck-col-btn", title: "Move up", text: "↑", disabled: i === 0, onclick: () => move(-1) }),
          el("button", { class: "ck-col-btn", title: "Move down", text: "↓", disabled: i === cols.length - 1, onclick: () => move(1) }),
          el("button", {
            class: "ck-col-btn" + (hidden ? " off" : ""), title: hidden ? "Show column" : "Hide column",
            onclick: () => {
              const set = state.ui.hiddenCols = state.ui.hiddenCols || [];
              state.ui.hiddenCols = hidden ? set.filter((x) => x !== c) : set.concat([c]);
              saveUi();
              paintScreener();
              if (state.results) renderResults(state.results);
            },
          }, [icon(hidden ? "eyeOff" : "eye")]),
          extra
            ? el("button", { class: "ck-col-btn danger", title: "Remove column", text: "✕", onclick: () => { removeExtraColumn(c); paintScreener(); } })
            : null,
        ]),
      ]));
    });

    return el("div", { class: "ck-panel-section" }, [
      el("div", { class: "ck-panel-title", text: "Result Columns" }),
      el("div", { class: "hint", text: "Customise the result columns and write your own formula-driven columns." }),
      list,
      el("div", { class: "row", style: "margin-top:10px" }, [
        el("button", {
          class: "ck-btn", onclick: (e) => openAddColumnMenu(e.currentTarget),
        }, [icon("add"), el("span", { text: "Add Column" })]),
        el("button", {
          class: "ck-btn",
          onclick: () => {
            state.ui.colOrder = [];
            state.ui.hiddenCols = [];
            saveUi();
            paintScreener();
            if (state.results) renderResults(state.results);
          },
        }, [el("span", { text: "Reset layout" })]),
      ]),
    ]);
  }

  function groupSortPanel() {
    const sorts = [
      ["volume", "24h volume"], ["change", "change %"], ["price", "price"],
      ["mcap", "market cap"], ["symbol", "symbol"],
    ];
    return el("div", { class: "ck-panel-section" }, [
      el("div", { class: "ck-panel-title", text: "Group / Sort Options" }),
      el("div", { class: "hint", text: "Order the coins before the scan is drawn. Click any table header to re-sort after the run." }),
      el("div", { class: "ck-field" }, [
        el("label", { class: "field-label", text: "Sort by" }),
        el("select", {
          class: "ck-select",
          onchange: (e) => { state.sort = e.target.value; },
        }, sorts.map((s) => opt(s[0], "Sort: " + s[1], state.sort))),
      ]),
      el("div", { class: "ck-field" }, [
        el("label", { class: "field-label", text: "Rows per page" }),
        el("select", {
          class: "ck-select",
          onchange: (e) => { state.ui.perPage = parseInt(e.target.value, 10) || 20; state.ui.page = 1; saveUi(); },
        }, [10, 20, 30, 40, 50].map((v) => opt(v, String(v), String(state.ui.perPage)))),
      ]),
      el("div", { class: "ck-field" }, [
        el("label", { class: "field-label", text: "Halal screen" }),
        segmented([["on", "Halal only"], ["off", "All spot coins"]], state.ui.halalOnly ? "on" : "off",
          (v) => { state.ui.halalOnly = v === "on"; saveUi(); paintScreener(); }),
      ]),
    ]);
  }

  /* ============================================================== backtest */
  const BT_PERIODS = [
    [22, "1 month"], [66, "3 months"], [132, "6 months"], [252, "1 year"],
  ];

  function backtestBody() {
    const period = String(state.ui.btPeriod || 66);
    const periodSel = el("select", {
      class: "ck-select", id: "btPeriod", title: "Select period",
      onchange: (e) => {
        state.ui.btPeriod = parseInt(e.target.value, 10) || 66;
        saveUi();
        runBacktest();
      },
    }, BT_PERIODS.map((p) => opt(String(p[0]), p[1], period)));

    const mode = state.ui.btMode === "timeline" ? "timeline" : "bars";
    const modeToggle = el("div", { class: "ck-bt-toggle" }, [
      el("button", {
        class: "ck-bt-mode" + (mode === "bars" ? " active" : ""),
        text: "Bars", "aria-pressed": mode === "bars" ? "true" : "false",
        onclick: () => { state.ui.btMode = "bars"; saveUi(); paintScreener(); if (state.backtest) renderBacktest(state.backtest); },
      }),
      el("button", {
        class: "ck-bt-mode" + (mode === "timeline" ? " active" : ""),
        text: "Timeline", "aria-pressed": mode === "timeline" ? "true" : "false",
        onclick: () => { state.ui.btMode = "timeline"; saveUi(); paintScreener(); if (state.backtest) renderBacktest(state.backtest); },
      }),
    ]);

    return el("div", { class: "ck-bt" }, [
      el("div", { class: "ck-bt-head" }, [
        el("h3", { text: "Backtest History" }),
        el("div", { class: "ck-bt-controls" }, [
          el("span", { class: "ck-bt-label", text: "Select period" }),
          periodSel,
          el("button", { class: "ck-btn ck-btn--run", text: "Run backtest", onclick: runBacktest }),
          modeToggle,
        ]),
      ]),
      el("p", {
        class: "ck-bt-caution",
        text: "Backtesting can provide interesting insights, but should not be considered as a reliable indicator of future performance",
      }),
      el("div", { class: "ck-bt-hint", text: "Click on each bar to view the stocks that matched on that date" }),
      el("div", { class: "ck-bt-chart", id: "btChart" }, [
        el("div", { class: "ck-empty", text: "No backtest yet" }),
      ]),
      el("div", { class: "ck-bt-detail", id: "btDetail" }),
    ]);
  }

  function backtestPayload(extra) {
    return Object.assign({
      clause: currentClause(),
      interval: state.interval,
      universe: state.universe,
      venue: state.ui.segment,
      halal_only: state.ui.halalOnly,
      bars: state.ui.btPeriod || 66,
    }, extra || {});
  }

  // "Backtest Results" scrolls to the section and runs it.
  function startBacktest() {
    const box = document.getElementById("backtest-container");
    if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "start" });
    runBacktest();
  }

  async function runBacktest() {
    const host = $("#btChart");
    if (!host) return;
    const det = $("#btDetail");
    if (det) det.innerHTML = "";
    host.innerHTML = '<div class="ck-loading"><span class="ck-spinner"></span><span>Backtesting…</span></div>';
    try {
      const res = await api("/api/backtest", { method: "POST", body: backtestPayload() });
      state.backtest = res;
      renderBacktest(res);
    } catch (e) {
      host.innerHTML = '<div class="error-box">' + esc(e.message) + "</div>";
    }
  }

  function renderBacktest(res) {
    const host = $("#btChart");
    if (!host) return;
    const dates = res.dates || [];
    const counts = res.counts || [];
    if (!dates.length) {
      host.innerHTML = '<div class="ck-empty">No backtest yet</div>';
      return;
    }
    const max = Math.max.apply(null, counts.concat([1]));

    if ((state.ui.btMode || "bars") === "timeline") {
      const table = el("table", { class: "data bt-table" }, [
        el("thead", {}, [el("tr", {}, [
          el("th", { text: "Date" }), el("th", { text: "Matches" }), el("th", { text: "" }),
        ])]),
        el("tbody", {}, dates.map((d, i) => el("tr", {
          class: counts[i] ? "" : "dim",
          onclick: () => loadBtDate(d),
        }, [
          el("td", { text: d }),
          el("td", { text: String(counts[i]) }),
          el("td", {}, [el("button", { class: "ck-link", text: "View coins" })]),
        ]))),
      ]);
      host.innerHTML = "";
      host.appendChild(el("div", { class: "table-wrap" }, [table]));
      return;
    }

    const bars = el("div", { class: "bt-bars" });
    dates.forEach((d, i) => {
      const n = counts[i] || 0;
      bars.appendChild(el("button", {
        class: "bt-bar" + (n ? "" : " is-zero"),
        style: `height:${Math.max(n ? 6 : 2, Math.round((n / max) * 100))}%`,
        title: `${d} · ${n} match${n === 1 ? "" : "es"}`,
        onclick: () => loadBtDate(d),
      }, [el("i", { text: n ? String(n) : "" })]));
    });
    host.innerHTML = "";
    host.appendChild(bars);
    host.appendChild(el("div", { class: "bt-axis" }, [
      el("span", { text: dates[0] }),
      el("span", { text: dates[dates.length - 1] }),
    ]));
  }

  async function loadBtDate(date) {
    const det = $("#btDetail");
    if (!det) return;
    det.innerHTML = '<div class="ck-loading"><span class="ck-spinner"></span><span>Loading ' + esc(date) + "…</span></div>";
    try {
      const res = await api("/api/backtest", { method: "POST", body: backtestPayload({ date: date }) });
      renderBtRows(date, res.rows || []);
    } catch (e) {
      det.innerHTML = '<div class="error-box">' + esc(e.message) + "</div>";
    }
  }

  function renderBtRows(date, rows) {
    const det = $("#btDetail");
    if (!det) return;
    det.innerHTML = "";
    det.appendChild(el("div", { class: "ck-bt-detail-head" }, [
      el("h4", { text: "Coins that matched on " + date }),
      el("span", { class: "hint", text: `${rows.length} result${rows.length === 1 ? "" : "s"}` }),
      el("button", { class: "ck-link", text: "Close", onclick: () => { det.innerHTML = ""; } }),
    ]));
    if (!rows.length) {
      det.appendChild(el("div", { class: "ck-empty", text: "No stocks present" }));
      return;
    }
    const table = el("table", { class: "data bt-table" }, [
      el("thead", {}, [el("tr", {}, [
        el("th", { text: "Sr." }), el("th", { text: "Stock Name" }), el("th", { text: "Symbol" }),
        el("th", { text: "Close" }), el("th", { text: "Change" }), el("th", { text: "24h Volume" }),
      ])]),
      el("tbody", {}, rows.map((r, i) => el("tr", {
        onclick: () => { location.hash = "#/chart/" + r.symbol; },
      }, [
        el("td", { class: "dim", text: String(i + 1) }),
        el("td", { class: "l", text: r.name || r.base || "" }),
        el("td", {}, [el("span", { class: "sym", text: r.symbol })]),
        el("td", { text: fmtPrice(r.price) }),
        el("td", { class: r.change_pct >= 0 ? "pos" : "neg", text: fmtPct(r.change_pct) }),
        el("td", { text: "$" + fmtCompact(r.quote_volume || 0) }),
      ]))),
    ]);
    det.appendChild(el("div", { class: "table-wrap" }, [table]));
  }

  function pageScreener(view) {
    screenerView = view;
    view.innerHTML = "";
    const ui = state.ui;

    /* ------------------------------------------------ scan heading strip */
    const scan = state.loadedScan || null;

    const favBtn = scan ? el("button", {
      class: "ck-scanstar on", title: "Favourite this scan",
      onclick: (e) => {
        e.currentTarget.classList.toggle("on");
        toast(e.currentTarget.classList.contains("on") ? "Added to favourites" : "Removed from favourites",
          scan.name, "ok", 2400);
      },
    }, [icon("starFilled")]) : null;

    const scanHead = el("div", { class: "ck-scanhead" }, [
      scan
        ? el("div", { class: "ck-scanname" }, [
            favBtn,
            el("span", { class: "ck-scanname-text", text: scan.name }),
          ])
        : el("h1", { class: "ck-screener-title", text: "Coin Screener" }),
    ]);

    /* ------------------------------------------------ action-button row */
    const runBtn = el("button", {
      class: "ck-btn ck-btn--run run-btn", id: "runBtn", type: "button",
      title: "Click to run scan", onclick: () => runScan(),
    }, [
      el("span", { class: "ck-run-icon", html: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1.4l8 4.6-8 4.6z"/></svg>' }),
      el("span", { class: "run-label", text: "Run Scan" }),
    ]);

    const saveBtn = el("button", {
      class: "ck-btn ck-btn--save", title: "Save Scan", onclick: () => saveScan(false),
    }, [icon("save"), el("span", { text: "Save Scan" })]);

    const backtestBtn = el("button", {
      class: "ck-btn ck-btn--backtest", title: "Go to backtest results",
      onclick: () => { startBacktest(); },
    }, [icon("clock"), el("span", { text: "Backtest Results" })]);

    const alertBtn = el("button", {
      class: "ck-btn ck-btn--alert", title: "Create Alert", onclick: () => openAlertModal(null),
    }, [icon("alert"), el("span", { text: "Create Alert" })]);

    const copyScanItem = {
      label: "Copy Scan", icon: "copy",
      onClick: () => {
        const text = currentClause();
        writeClipboard(text, (ok) => toast(ok ? "Copied to clipboard" : "Could not copy", text, ok ? "ok" : "err"));
      },
    };

    const likes = likeCount();
    const moreBtn = el("button", {
      class: "ck-btn ck-btn--more", title: "Click to display all buttons",
      "aria-label": "More scan actions", "aria-haspopup": "true",
      onclick: (e) => popMenu(e.currentTarget, [
        { label: "Save As", icon: "save", onClick: () => saveScan(true) },
        copyScanItem,
        { label: likes ? "Loved" : "Love scan", icon: likes ? "heartFilled" : "heart", onClick: toggleLike },
        { label: "Monitor on dashboard", icon: "monitor", onClick: monitorOnDashboard },
        { label: "Share", icon: "share", onClick: shareScan },
      ], { width: 240 }),
    }, [el("span", { class: "ck-more-label", text: "More" }), icon("chevron")]);

    const copyInline = el("button", {
      class: "ck-btn ck-btn--icon", title: "Copy Scan", "aria-label": "Copy Scan",
      onclick: () => {
        const text = currentClause();
        writeClipboard(text, (ok) => toast(ok ? "Copied to clipboard" : "Could not copy", text, ok ? "ok" : "err"));
      },
    }, [icon("copy")]);

    const monitorInline = el("button", {
      class: "ck-btn ck-btn--icon ck-btn--violet", title: "Monitor on dashboard",
      "aria-label": "Monitor on dashboard", onclick: monitorOnDashboard,
    }, [icon("monitor")]);

    const moreGroup = el("div", { class: "ck-more-group" }, [moreBtn, copyInline, monitorInline]);

    const likesReadout = scan
      ? el("span", { class: "ck-likes" }, [
          icon(likes ? "heartFilled" : "heart"),
          el("span", { text: `${likes} people love this` }),
        ])
      : null;

    const actionRow = el("div", { class: "ck-actions" },
      [runBtn, saveBtn, backtestBtn, alertBtn, moreGroup, likesReadout]);

    /* ------------------------------------------------------ notice strip */
    const notice = el("div", { class: "ck-notice", role: "alert" }, [
      icon("moon"),
      el("span", {
        id: "noticeHalal",
        text: ui.halalOnly
          ? "Halal screen ON — only coins marked compliant by 3 of the 5 platforms are shown."
          : "Halal screen OFF — every spot USDT pair is shown.",
      }),
      el("button", { class: "ck-link", text: "How halal is decided", onclick: openHalalInfo }),
      el("span", { class: "ck-notice-sep", text: "·" }),
      el("span", { text: "Segment: " }),
      el("b", { id: "segmentHint", text: segmentLabel() }),
      el("span", { class: "ck-notice-sep", text: "·" }),
      el("span", { text: "Spot only — no futures, no shorting" }),
      el("button", {
        class: "ck-link",
        text: ui.halalOnly ? "Show all spot coins" : "Show halal coins only",
        onclick: () => { ui.halalOnly = !ui.halalOnly; saveUi(); paintScreener(); },
      }),
    ]);

    /* -------------------------------------------------------- magic panel */
    // Chartink's magic-filter panel: header, Append|Replace + Draw + prompt +
    // Generate, four example chips, then "+ Add tag" underneath the panel.
    const magicMode = ui.magicMode === "replace" ? "replace" : "append";

    const drawBtn = el("button", {
      class: "ck-btn ck-btn--draw", title: "Draw pattern",
      onclick: openDrawPattern,
    }, [icon("pen"), el("span", { text: "Draw" })]);

    const magicPrompt = el("textarea", {
      id: "magicPrompt", class: "magic-filter-prompt", rows: "1",
      placeholder: "Scan coins using simple language like 'coins up by 4% and rising volume'",
      "aria-label": "Magic filter prompt",
      onkeydown: (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); magicGenerate(); }
      },
    });

    const magic = el("div", { class: "magic-filter-section" }, [
      el("div", { class: "magic-filter-panel" }, [
        el("div", { class: "magic-head" }, [
          el("span", {
            class: "magic-icon",
            html: '<svg viewBox="0 0 24 24" width="18" height="19" fill="#50B8F1" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/></svg>',
          }),
          el("span", { class: "magic-title", text: "Magic Filters" }),
        ]),
        el("div", { class: "magic-filter-input-row" }, [
          segmented([["append", "Append"], ["replace", "Replace"]], magicMode, (v) => {
            ui.magicMode = v;
            saveUi();
          }, "segmented--small"),
          drawBtn,
          magicPrompt,
          el("button", {
            class: "ck-btn ck-btn--magic", id: "magicGenerate", text: "Generate",
            onclick: magicGenerate,
          }),
        ]),
        el("div", { class: "magic-filter-chips" }, MAGIC_CHIPS.map((chip) =>
          el("button", {
            class: "magic-chip", type: "button", title: "Run this example",
            onclick: () => {
              const box = $("#magicPrompt");
              if (box) box.value = chip;
              magicGenerate();
            },
          }, [el("span", { text: chip }), el("i", { text: "⇝" })]))),
      ]),
      el("button", {
        class: "magic-addtag", type: "button",
        onclick: () => toast("Add tag", "Tags group your saved scans in the Scan Library.", "ok", 3200),
      }, [icon("add"), el("span", { text: "Add tag" })]),
    ]);

    /* ------------------------------------------------------------ bodies */
    const builder = el("div", { class: "atlas-filters", id: "builder" });

    const builderWrap = el("div", { class: "atlas-builder-wrap" }, [
      el("hr", { class: "atlas-divider" }),
      builder,
    ]);

    function resultBody() {
      const job = state.results;

      const customize = el("button", {
        class: "ck-tool",
        onclick: () => { ui.colEditor = !ui.colEditor; saveUi(); paintScreener(); },
      }, [
        el("span", { text: ui.colEditor ? "Hide column editor" : "Customize columns" }),
        icon(ui.colEditor ? "close" : "columns"),
      ]);

      const hasRows = !!(job && job.results && job.results.length);
      const copyBtn = el("button", {
        class: "ck-tool" + (hasRows ? "" : " disabled"), disabled: !hasRows,
        onclick: (e) => popMenu(e.currentTarget, [
          { label: "Symbols (all results)", icon: "copy", onClick: () => copyResults(job, "all") },
          { label: "Symbols (this page)", icon: "copy", onClick: () => copyResults(job, "page") },
          { label: "Table (tab separated)", icon: "table", onClick: () => copyResults(job, "table") },
        ], { width: 230 }),
      }, [el("span", { text: "Copy" }), icon("chevron")]);

      const csvBtn = el("button", {
        class: "ck-tool" + (hasRows ? "" : " disabled"), disabled: !hasRows,
        title: "Download CSV", onclick: () => exportCsv(job),
      }, [icon("csv"), el("span", { text: "CSV" })]);

      const xlsBtn = el("button", {
        class: "ck-tool" + (hasRows ? "" : " disabled"), disabled: !hasRows,
        title: "Download Excel", onclick: () => exportExcel(job),
      }, [icon("table"), el("span", { text: "Excel" })]);

      const search = el("input", {
        class: "ck-search", type: "search",
        placeholder: "Search coins", "aria-label": "Search coins",
        value: ui.search || "",
        oninput: (e) => {
          const v = e.target.value;
          clearTimeout(state.searchTimer);
          state.searchTimer = setTimeout(() => {
            ui.search = v;
            ui.page = 1;
            saveUi();
            if (state.results) renderResults(state.results);
          }, 180);
        },
      });

      const resultSettings = el("button", {
        class: "ck-settings", title: "Settings Dropdown", "aria-haspopup": "true",
        onclick: (e) => settingsMenu(e.currentTarget, "results", job),
      }, [
        el("span", { text: "Settings" }),
        icon("chevron"),
        ui.halalOnly ? el("i", { class: "ck-dot" }) : null,
      ]);

      return el("div", { class: "ck-results-body" }, [
        el("div", { class: "ck-result-head" }, [
          el("h3", { text: "Coins" }),
          el("span", { id: "resultCount", class: "hint", text: job ? "" : "0 results" }),
        ]),
        el("div", { class: "ck-debug", id: "debugStrip", style: "display:none" }),
        el("div", { class: "ck-toolbar" }, [
          el("div", { class: "ck-toolbar-left" }, [customize, copyBtn, csvBtn, xlsBtn]),
          el("div", { class: "ck-toolbar-right" }, [search, resultSettings]),
        ]),
        ui.colEditor ? el("div", { class: "ck-col-editor" }, [columnsPanel()]) : null,
        el("div", { id: "resultsBody" }),
        el("div", { class: "ck-pager", id: "resultsPager" }),
      ]);
    }

    /* -------------------------------------------------------------- assembly */
    const card = el("div", { class: "ck-card" }, [magic, builderWrap, actionRow, notice]);
    const results = el("div", { class: "ck-results", id: "resultsSection" }, [resultBody()]);
    const backtest = el("div", { class: "ck-backtest", id: "backtest-container" }, [backtestBody()]);

    view.appendChild(scanHead);
    view.appendChild(card);
    view.appendChild(results);
    view.appendChild(backtest);

    renderBuilder("restore");

    if (state.results) {
      renderResults(state.results);
    } else {
      paintResultsBox('<div class="ck-empty">No stocks present</div>');
    }
    if (state.running) setRunning(true);

    // A shared link carries the clause in the hash (#/screener?c=...).
    const shared = /[?&]c=([^&]+)/.exec(location.hash);
    if (shared && !pendingClause) {
      try { pendingClause = decodeURIComponent(shared[1]); } catch (e) { /* leave it */ }
      try { history.replaceState(null, "", location.pathname + "#/screener"); } catch (e) { /* noop */ }
    }

    if (pendingClause) {
      const clause = pendingClause;
      const done = pendingClauseDone;
      pendingClause = null;
      pendingClauseDone = null;
      const box = $("#clauseBox");
      if (box) box.value = clause;
      applyTextClause(clause, done).catch(() => { /* handled */ });
    } else if (pendingClauseDone) {
      const done = pendingClauseDone;
      pendingClauseDone = null;
      done(true);
    }
  }

/* ================================================================ router */
  const pages = {};
  pages.screener = pageScreener;

  function setActiveNav(route) {
    $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
  }

  function router() {
    const raw = location.hash.replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean);
    const route = parts[0] || "screener";
    const view = $("#view");
    if (view._cleanup) { try { view._cleanup(); } catch (e) { /* noop */ } view._cleanup = null; }
    setActiveNav(route);
    const fn = pages[route] || pages.screener;
    try {
      fn(view, parts.slice(1));
    } catch (e) {
      view.innerHTML = '<div class="error-box">' + esc(e.message) + "</div>";
      console.error(e);
    }
    window.scrollTo(0, 0);
  }

  /* ================================================================= boot */
  async function boot() {
    try {
      const [fields, presets, health] = await Promise.all([
        api("/api/fields"),
        api("/api/presets"),
        api("/api/health").catch(() => null),
      ]);
      state.catalog = fields.fields;
      // Saved scans live in this browser; the library shows both.
      state.presets = loadMyScans().concat(presets.presets || []);
      state.fieldMap = {};
      state.catalog.forEach((g) => g.fields.forEach((f) => { f.cat = g.cat; state.fieldMap[f.key] = f; }));

      api("/api/watchlist").then((w) => {
        // Merge server and local copies so a fresh browser keeps its stars.
        const merged = (w.symbols || []).slice();
        state.watchlist.forEach((s) => { if (merged.indexOf(s) === -1) merged.push(s); });
        state.watchlist = merged;
        // Keep the server copy in step with the merge, otherwise a device that
        // started with an empty server list never pushes its stars back.
        if (JSON.stringify(w.symbols || []) !== JSON.stringify(merged)) saveWatchlist();
        try { localStorage.setItem("cx_watchlist", JSON.stringify(merged)); } catch (e) { /* noop */ }
        if (location.hash.indexOf("#/watchlist") === 0) router();
      }).catch(() => {});
      api("/api/settings").then((s) => { state.settings = s; }).catch(() => {});

      if (health) $("#topMeta").innerHTML = "<b>ready</b>";
    } catch (e) {
      $("#topMeta").innerHTML = "<b class='neg'>API offline</b>";
      toast("Backend unreachable", e.message, "err");
    }

    state.tree = defaultTree();
    window.addEventListener("hashchange", router);
    router();
    startAlertPolling();
  }

  /* ------------------------------------------------------- alert polling */
  let lastSeenAlert = 0;
  function startAlertPolling() {
    setInterval(async () => {
      try {
        const res = await api("/api/alerts/pending");
        const fresh = (res.items || []).filter((i) => i.time * 1000 > lastSeenAlert);
        if (fresh.length) {
          lastSeenAlert = Math.max.apply(null, fresh.map((i) => i.time * 1000));
          fresh.slice(0, 4).forEach((i) => {
            toast(i.alert, `${i.symbol} now matches · ${fmtPrice(i.price)}`, "ok", 7000);
          });
          if (window.Notification && Notification.permission === "granted") {
            try {
              new Notification(fresh[0].alert, {
                body: fresh.map((i) => i.symbol).slice(0, 8).join(", "),
              });
            } catch (e) { /* noop */ }
          }
          api("/api/alerts/pending/clear", { method: "POST" }).catch(() => {});
        }
      } catch (e) { /* backend offline; ignore */ }
    }, 15000);
  }

  /* ================================================================ export */
  window.App = {
    $, $$, el, esc, api, toast, modal, state,
    fmtPrice, fmtPct, fmtCompact, fmtCell, relTime,
    pages, router, runScan, renderBuilder, treeFromAst, currentClause,
    isWatched, toggleWatch, watchSynced, fieldToken, defaultTree, openAlertModal,
    setRunning, renderResults, pollScan,
    venueCell, halalCell, colTitle,
    setPendingClause: (c, onDone) => { pendingClause = c; pendingClauseDone = onDone || null; },
    clearWatchlist: () => {
      state.watchlist = [];
      saveWatchlist();
      if (location.hash.indexOf("#/watchlist") === 0) router();
    },
  };

  document.addEventListener("DOMContentLoaded", boot);
})();
