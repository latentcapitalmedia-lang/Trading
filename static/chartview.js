/* =====================================================================
   chartview.js — TradingView-style chart engine for chartink-crypto.

   Loaded before app.js / pages.js, so it must not touch window.App at
   parse time. Everything the page needs comes from:

       var stop = window.ChartView.mount(view, opts);
       ... later ...
       stop();

   opts = {
     symbol, interval, limit,
     timeframes: [...], barCounts: [...],
     api(path), toast(title, sub, kind),
     fmtPrice(v), fmtPct(v), fmtCompact(v),
     onState({symbol, interval, limit}),   // keep the router's chartState in step
     onNavigate({symbol, interval, limit}),// change symbol (router re-mounts)
   }
   ===================================================================== */
(function () {
  "use strict";

  var LW = window.LightweightCharts;

  /* ================================================= TradingView palette
     Read straight off tradingview.com's dark theme so the canvas is
     pixel-equivalent: chart #0f0f0f, grid rgba(242,242,242,.2), scale text
     #b8b8b8, candles #089981 / #f23645. */
  var TV = {
    bg: "#0f0f0f",
    fg: "#b8b8b8",
    grid: "rgba(242,242,242,0.2)",
    scale: "rgba(242,242,242,0)",
    cross: "#9c9c9c",
    crossLabel: "#363a45",
    watermark: "rgba(80,83,94,0.3)",
    /* LWC ships a light-grey pane divider (#E0E3EB). TradingView does not draw
       a bright rule between panes at all: sampling the live chart's canvas
       turns up no white pixel anywhere — its ruling, and by implication any
       pane boundary, is rgb(60,60,60). A 3px white row was the loudest thing
       on the canvas; #3c3c3c is the same value the grid composites to, so the
       boundary now reads as another ruled line rather than a slash. */
    sep: "#3c3c3c",
    sepHover: "#8f8f8f",
    up: "#089981",
    down: "#f23645",
    zero: "rgba(120,123,134,0.5)",
    font: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif'
  };

  /* ======================================================= small helpers */
  var seq = 0;
  function uid(p) { return (p || "i") + Date.now().toString(36) + "-" + (seq++); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "text") node.textContent = v;
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
        else if (k === "style") node.setAttribute("style", v);
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid == null) return;
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* quota */ } }
  function recall(key, dflt) {
    try { var v = localStorage.getItem(key); return v == null ? dflt : JSON.parse(v); }
    catch (e) { return dflt; }
  }

  /* --- anchored popup menu ---------------------------------------------
     Every TradingView header control drops the same kind of small list:
     a 34px row, a 16-18px glyph, a label and an optional right-hand hint.
     One helper serves the chart type, interval, layout and range menus so
     they all share TV's geometry and dismiss behaviour (outside click /
     Escape / resize). */
  var openMenuEl = null;
  var openMenuAnchor = null;
  function closeMenu() {
    if (!openMenuEl) return;
    if (openMenuEl.parentNode) openMenuEl.parentNode.removeChild(openMenuEl);
    openMenuEl = null;
    openMenuAnchor = null;
    document.removeEventListener("mousedown", menuOutside, true);
    document.removeEventListener("keydown", menuKeydown, true);
    window.removeEventListener("resize", closeMenu);
  }
  function menuOutside(e) {
    if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
  }
  function menuKeydown(e) { if (e && e.key === "Escape") closeMenu(); }
  /* Show a *pre-built* box under `anchor`. Used for the interval list, the
     bar-count list and the go-to-date field, which live in the DOM rather
     than being rebuilt on every click. */
  function showMenuBox(anchor, box) {
    closeMenu();
    document.body.appendChild(box);
    var r = anchor.getBoundingClientRect();
    var left = Math.max(6, Math.min(r.left, window.innerWidth - box.offsetWidth - 6));
    var top = r.bottom + 4;
    if (top + box.offsetHeight > window.innerHeight - 6) {
      top = Math.max(6, r.top - box.offsetHeight - 4);
    }
    box.style.left = left + "px";
    box.style.top = top + "px";
    box.style.bottom = "auto";
    box.style.zIndex = "200";
    openMenuEl = box;
    openMenuAnchor = anchor;
    setTimeout(function () {
      document.addEventListener("mousedown", menuOutside, true);
      document.addEventListener("keydown", menuKeydown, true);
    }, 0);
    window.addEventListener("resize", closeMenu);
    return box;
  }
  function togglePopup(anchor, box) {
    if (openMenuAnchor === anchor) { closeMenu(); return null; }
    return showMenuBox(anchor, box);
  }
  function buildMenu(items) {
    var box = el("div", { class: "cv-menu" });
    (items || []).forEach(function (it) {
      if (!it) return;
      if (it.sep) { box.appendChild(el("div", { class: "cv-menu-sep" })); return; }
      if (it.header) { box.appendChild(el("div", { class: "cv-menu-head", text: it.header })); return; }
      var row = el("button", { class: "cv-menu-row" + (it.on ? " on" : "") }, [
        el("span", { class: "mi", html: it.icon || "" }),
        el("span", { class: "ml", text: it.label }),
        it.hint ? el("span", { class: "mh", text: it.hint }) : null,
        it.on ? el("span", { class: "ck", text: "✓" }) : null
      ]);
      row.onclick = function () { closeMenu(); if (it.onclick) it.onclick(); };
      box.appendChild(row);
    });
    return box;
  }
  function openMenu(anchor, items) {
    if (openMenuAnchor === anchor) { closeMenu(); return null; }
    return showMenuBox(anchor, buildMenu(items));
  }

  /* --- TradingView's own drawing-tool glyphs ------------------------------
     Every path below is lifted verbatim from the live TradingView rail and
     its flyout menus (a 28px grid), so the toolbar reads exactly like the
     chart everyone already knows. */
  var ICON = {
    cursor: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M18 15h8v-1h-8z"/><path d="M14 18v8h1v-8zM14 3v8h1v-8zM3 15h8v-1h-8z"/></svg>',
    delete: '<svg viewBox="0 0 29 31" fill="currentColor"><path fill-rule="nonzero" d="M15.3 22l8.187-8.187c.394-.394.395-1.028.004-1.418l-4.243-4.243c-.394-.394-1.019-.395-1.407-.006l-11.325 11.325c-.383.383-.383 1.018.007 1.407l1.121 1.121h7.656zm-9.484-.414c-.781-.781-.779-2.049-.007-2.821l11.325-11.325c.777-.777 2.035-.78 2.821.006l4.243 4.243c.781.781.78 2.048-.004 2.832l-8.48 8.48h-8.484l-1.414-1.414z"/><path d="M13.011 22.999h7.999v-1h-7.999zM13.501 11.294l6.717 6.717.707-.707-6.717-6.717z"/></svg>',
    trend: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M7.354 21.354l14-14-.707-.707-14 14z"/><path d="M22.5 7c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM5.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    ray: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M8.354 20.354l5-5-.707-.707-5 5z"/><path fill-rule="nonzero" d="M16.354 12.354l8-8-.707-.707-8 8z"/><path d="M14.5 15c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM6.5 23c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    extline: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M4.354 25.354l5-5-.707-.707-5 5z"/><path fill-rule="nonzero" d="M12.354 17.354l5-5-.707-.707-5 5z"/><path fill-rule="nonzero" d="M20.354 9.354l5-5-.707-.707-5 5z"/><path d="M18.5 12c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM10.5 20c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    hline: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M4 15h8.5v-1h-8.5zM16.5 15h8.5v-1h-8.5z"/><path d="M14.5 16c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    hray: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M8.5 15h16.5v-1h-16.5z"/><path d="M6.5 16c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    vline: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M15 12.5v-8.5h-1v8.5zM14 16.5v8.5h1v-8.5z"/><path d="M14.5 16c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    channel: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M8.354 18.354l10-10-.707-.707-10 10zM12.354 25.354l5-5-.707-.707-5 5z"/><path fill-rule="nonzero" d="M20.354 17.354l5-5-.707-.707-5 5z"/><path d="M19.5 8c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM6.5 21c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM18.5 20c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    fib: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M3 5h22v-1h-22z"/><path fill-rule="nonzero" d="M3 17h22v-1h-22z"/><path fill-rule="nonzero" d="M3 11h19.5v-1h-19.5z"/><path fill-rule="nonzero" d="M5.5 23h19.5v-1h-19.5z"/><path d="M3.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM24.5 12c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    text: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M8 6.5c0-.28.22-.5.5-.5H14v16h-2v1h5v-1h-2V6h5.5c.28 0 .5.22.5.5V9h1V6.5c0-.83-.67-1.5-1.5-1.5h-12C7.67 5 7 5.67 7 6.5V9h1V6.5Z"/></svg>',
    brush: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M1.789 23l.859-.854.221-.228c.18-.19.38-.409.597-.655.619-.704 1.238-1.478 1.815-2.298.982-1.396 1.738-2.776 2.177-4.081 1.234-3.667 5.957-4.716 8.923-1.263 3.251 3.785-.037 9.38-5.379 9.38h-9.211zm9.211-1c4.544 0 7.272-4.642 4.621-7.728-2.45-2.853-6.225-2.015-7.216.931-.474 1.408-1.273 2.869-2.307 4.337-.599.852-1.241 1.653-1.882 2.383l-.068.078h6.853z"/><path fill-rule="nonzero" d="M18.182 6.002l-1.419 1.286c-1.031.935-1.075 2.501-.096 3.48l1.877 1.877c.976.976 2.553.954 3.513-.045l5.65-5.874-.721-.693-5.65 5.874c-.574.596-1.507.609-2.086.031l-1.877-1.877c-.574-.574-.548-1.48.061-2.032l1.419-1.286-.672-.741z"/></svg>',
    magnet: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M14 10a2 2 0 0 0-2 2v11H6V12c0-4.416 3.584-8 8-8s8 3.584 8 8v11h-6V12a2 2 0 0 0-2-2zm-3 2a3 3 0 0 1 6 0v10h4V12c0-3.864-3.136-7-7-7s-7 3.136-7 7v10h4V12z"/><path d="M6.5 18h5v1h-5zm10 0h5v1h-5z"/></svg>',
    trash: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M18 7h5v1h-2.01l-1.33 14.64a1.5 1.5 0 0 1-1.5 1.36H9.84a1.5 1.5 0 0 1-1.49-1.36L7.01 8H5V7h5V6c0-1.1.9-2 2-2h4a2 2 0 0 1 2 2v1Zm-6-2a1 1 0 0 0-1 1v1h6V6a1 1 0 0 0-1-1h-4ZM8.02 8l1.32 14.54a.5.5 0 0 0 .5.46h8.33a.5.5 0 0 0 .5-.46L19.99 8H8.02Z"/></svg>',
    trashAll: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M18 7h5v1h-2.01l-1.33 14.64a1.5 1.5 0 0 1-1.5 1.36H9.84a1.5 1.5 0 0 1-1.49-1.36L7.01 8H5V7h5V6c0-1.1.9-2 2-2h4a2 2 0 0 1 2 2v1Zm-6-2a1 1 0 0 0-1 1v1h6V6a1 1 0 0 0-1-1h-4ZM8.02 8l1.32 14.54a.5.5 0 0 0 .5.46h8.33a.5.5 0 0 0 .5-.46L19.99 8H8.02Z"/></svg>',
    lock: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M9.877 3.607a3.997 3.997 0 0 1 5.508 1.27l.026.043-.848.53-.01-.017-.005.004a2.998 2.998 0 0 0-5.474 2.226 3 3 0 0 0 .302.79l.08.133L10.964 11H19.5l.256.012A2.5 2.5 0 0 1 22 13.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 6 20.5v-7a2.5 2.5 0 0 1 2.244-2.488L8.5 11h1.27L8.612 9.15a4 4 0 0 1-.58-1.645 4 4 0 0 1 1.845-3.898M8.5 12A1.5 1.5 0 0 0 7 13.5v7A1.5 1.5 0 0 0 8.5 22h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5zm5.5 3a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1"/></svg>',
    unlock: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M9.877 3.607a3.997 3.997 0 0 1 5.508 1.27l.026.043-.848.53-.01-.017-.005.004a2.998 2.998 0 0 0-5.474 2.226 3 3 0 0 0 .302.79l.08.133L10.964 11H19.5l.256.012A2.5 2.5 0 0 1 22 13.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 6 20.5v-7a2.5 2.5 0 0 1 2.244-2.488L8.5 11h1.27L8.612 9.15a4 4 0 0 1-.58-1.645 4 4 0 0 1 1.845-3.898M8.5 12A1.5 1.5 0 0 0 7 13.5v7A1.5 1.5 0 0 0 8.5 22h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5zm5.5 3a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1"/></svg>',
    zin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M10.5 8v5M8 10.5h5"/><path d="M15 15l4.5 4.5"/></svg>',
    zout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M8 10.5h5"/><path d="M15 15l4.5 4.5"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>',
    fx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 18c3.5 0 3.6-12 7.5-12S15 18 20 18"/><path d="M4 12h4"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l4.5 4.5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.1"/><path d="M12 3.2v2.4M12 18.4v2.4M3.2 12h2.4M18.4 12h2.4M5.7 5.7l1.7 1.7M16.6 16.6l1.7 1.7M18.3 5.7l-1.7 1.7M7.4 16.6l-1.7 1.7"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="6" width="16" height="12" rx="1.5"/><path d="M8 12h8"/></svg>',
    /* --- TradingView's left-rail controls --- */
    measure: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M2 9.75a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h24a1.5 1.5 0 0 0 1.5-1.5v-5.5a1.5 1.5 0 0 0-1.5-1.5zm0 1h3v2.5h1v-2.5h3.25v3.9h1v-3.9h3.25v2.5h1v-2.5h3.25v3.9h1v-3.9H22v2.5h1v-2.5h3a.5.5 0 0 1 .5.5v5.5a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5v-5.5a.5.5 0 0 1 .5-.5z" transform="rotate(-45 14 14)"/></svg>',
    zoomregion: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M17.646 18.354l4 4 .708-.708-4-4z"/><path d="M12.5 21a8.5 8.5 0 1 1 0-17 8.5 8.5 0 0 1 0 17zm0-1a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z"/><path d="M9 13h7v-1H9z"/><path d="M13 16V9h-1v7z"/></svg>',
    keepdraw: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M17.27 4.56a2.5 2.5 0 0 0-3.54 0l-.58.59-9 9-1 1-.15.14V20h4.7l.15-.15 1-1 9-9 .59-.58a2.5 2.5 0 0 0 0-3.54l-1.17-1.17Zm-2.83.7a1.5 1.5 0 0 1 2.12 0l1.17 1.18a1.5 1.5 0 0 1 0 2.12l-.23.23-3.3-3.29.24-.23Zm-.94.95 3.3 3.29-8.3 8.3-3.3-3.3 8.3-8.3Zm-9 9 3.3 3.29-.5.5H4v-3.3l.5-.5Zm16.5.29a1.5 1.5 0 0 0-3 0V18h4.5c.83 0 1.5.67 1.5 1.5v4c0 .83-.67 1.5-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-4c0-.83.67-1.5 1.5-1.5h.5v-2.5a2.5 2.5 0 0 1 5 0v.5h-1v-.5ZM16.5 19a.5.5 0 0 0-.5.5v4c0 .28.22.5.5.5h6a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 0-.5-.5h-6Zm2.5 4v-2h1v2h-1Z"/></svg>',
    eyeOff: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M5 10.76l-.41-.72-.03-.04.03-.04a15 15 0 012.09-2.9c1.47-1.6 3.6-3.12 6.32-3.12 2.73 0 4.85 1.53 6.33 3.12a15.01 15.01 0 012.08 2.9l.03.04-.03.04a15 15 0 01-2.09 2.9c-1.47 1.6-3.6 3.12-6.32 3.12-2.73 0-4.85-1.53-6.33-3.12a15 15 0 01-1.66-2.18zm17.45-.98L22 10l.45.22-.01.02a5.04 5.04 0 01-.15.28 16.01 16.01 0 01-2.23 3.1c-1.56 1.69-3.94 3.44-7.06 3.44-3.12 0-5.5-1.75-7.06-3.44a16 16 0 01-2.38-3.38v-.02h-.01L4 10l-.45-.22.01-.02a5.4 5.4 0 01.15-.28 16 16 0 012.23-3.1C7.5 4.69 9.88 2.94 13 2.94c3.12 0 5.5 1.75 7.06 3.44a16.01 16.01 0 012.38 3.38v.02h.01zM22 10l.45-.22.1.22-.1.22L22 10zM3.55 9.78L4 10l-.45.22-.1-.22.1-.22zm6.8.22A2.6 2.6 0 0113 7.44 2.6 2.6 0 0115.65 10 2.6 2.6 0 0113 12.56 2.6 2.6 0 0110.35 10zM13 6.44A3.6 3.6 0 009.35 10 3.6 3.6 0 0013 13.56c2 0 3.65-1.58 3.65-3.56A3.6 3.6 0 0013 6.44zm7.85 12l.8-.8.7.71-.79.8a.5.5 0 000 .7l.59.59c.2.2.5.2.7 0l1.8-1.8.7.71-1.79 1.8a1.5 1.5 0 01-2.12 0l-.59-.59a1.5 1.5 0 010-2.12zM16.5 21.5l-.35-.35a.5.5 0 00-.07.07l-1 1.5-1 1.5a.5.5 0 00.42.78h4a2.5 2.5 0 001.73-.77A2.5 2.5 0 0021 22.5a2.5 2.5 0 00-.77-1.73A2.5 2.5 0 0018.5 20a3.1 3.1 0 00-1.65.58 5.28 5.28 0 00-.69.55v.01h-.01l.35.36zm.39.32l-.97 1.46-.49.72h3.07c.34 0 .72-.17 1.02-.48.3-.3.48-.68.48-1.02 0-.34-.17-.72-.48-1.02-.3-.3-.68-.48-1.02-.48-.35 0-.75.18-1.1.42a4.27 4.27 0 00-.51.4z"/></svg>',
    eye: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M5 10.76l-.41-.72-.03-.04.03-.04a15 15 0 012.09-2.9c1.47-1.6 3.6-3.12 6.32-3.12 2.73 0 4.85 1.53 6.33 3.12a15.01 15.01 0 012.08 2.9l.03.04-.03.04a15 15 0 01-2.09 2.9c-1.47 1.6-3.6 3.12-6.32 3.12-2.73 0-4.85-1.53-6.33-3.12a15 15 0 01-1.66-2.18zm17.45-.98L22 10l.45.22-.01.02a5.04 5.04 0 01-.15.28 16.01 16.01 0 01-2.23 3.1c-1.56 1.69-3.94 3.44-7.06 3.44-3.12 0-5.5-1.75-7.06-3.44a16 16 0 01-2.38-3.38v-.02h-.01L4 10l-.45-.22.01-.02a5.4 5.4 0 01.15-.28 16 16 0 012.23-3.1C7.5 4.69 9.88 2.94 13 2.94c3.12 0 5.5 1.75 7.06 3.44a16.01 16.01 0 012.38 3.38v.02h.01zM22 10l.45-.22.1.22-.1.22L22 10zM3.55 9.78L4 10l-.45.22-.1-.22.1-.22zm6.8.22A2.6 2.6 0 0113 7.44 2.6 2.6 0 0115.65 10 2.6 2.6 0 0113 12.56 2.6 2.6 0 0110.35 10zM13 6.44A3.6 3.6 0 009.35 10 3.6 3.6 0 0013 13.56c2 0 3.65-1.58 3.65-3.56A3.6 3.6 0 0013 6.44zm7.85 12l.8-.8.7.71-.79.8a.5.5 0 000 .7l.59.59c.2.2.5.2.7 0l1.8-1.8.7.71-1.79 1.8a1.5 1.5 0 01-2.12 0l-.59-.59a1.5 1.5 0 010-2.12zM16.5 21.5l-.35-.35a.5.5 0 00-.07.07l-1 1.5-1 1.5a.5.5 0 00.42.78h4a2.5 2.5 0 001.73-.77A2.5 2.5 0 0021 22.5a2.5 2.5 0 00-.77-1.73A2.5 2.5 0 0018.5 20a3.1 3.1 0 00-1.65.58 5.28 5.28 0 00-.69.55v.01h-.01l.35.36zm.39.32l-.97 1.46-.49.72h3.07c.34 0 .72-.17 1.02-.48.3-.3.48-.68.48-1.02 0-.34-.17-.72-.48-1.02-.3-.3-.68-.48-1.02-.48-.35 0-.75.18-1.1.42a4.27 4.27 0 00-.51.4z"/></svg>',
    /* --- TradingView favourites (star on a flyout row, rail toggle) --- */
    star: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 2.13l1.903 3.855.116.236.26.038 4.255.618-3.079 3.001-.188.184.044.259.727 4.237-3.805-2L9 12.434l-.233.122-3.805 2.001.727-4.237.044-.26-.188-.183-3.079-3.001 4.255-.618.26-.038.116-.236L9 2.13z"/></svg>',
    favStar: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="m17.13 9.74 7.37.9-5.44 5.06L20.4 23 14 19.38 7.6 23l1.34-7.3-5.44-5.06 7.37-.9L14 3l3.13 6.74Zm5.11 1.63-4.26 3.97 1.04 5.74L14 18.24l-5.02 2.84 1.04-5.74-4.26-3.97 5.79-.7L14 5.37l2.45 5.3 5.8.7Z"/></svg>',
    /* --- refresh: re-fit the view the way TradingView resets a chart --- */
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    chev: '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M1.6 3.2L5 6.6l3.4-3.4z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="8.5" y="3.5" width="12" height="14" rx="2"/><path d="M15.5 20.5h-9a2 2 0 01-2-2v-11"/></svg>',
    paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="5" y="4.5" width="14" height="16" rx="2"/><rect x="9" y="2.8" width="6" height="3.6" rx="1.3"/><path d="M8.5 11h7M8.5 15h5"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.1"/><path d="M12 3.2v2.4M12 18.4v2.4M3.2 12h2.4M18.4 12h2.4M5.7 5.7l1.7 1.7M16.6 16.6l1.7 1.7M18.3 5.7l-1.7 1.7M7.4 16.6l-1.7 1.7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>',
    /* --- TradingView's expanded tool set --- */
    arrow: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M7.354 21.354l14-14-.707-.707-14 14z"/><path d="M21 7l-8 3 5 5z"/><path fill-rule="nonzero" d="M22.5 7c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM5.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    rect: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M7.5 6h13v-1h-13z"/><path fill-rule="nonzero" d="M7.5 23h13v-1h-13z"/><path fill-rule="nonzero" d="M5 7.5v13h1v-13z"/><path fill-rule="nonzero" d="M22 7.5v13h1v-13z"/><path d="M5.5 7c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM22.5 7c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM22.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM5.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    fibext: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M4 25h22v-1h-22z"/><path fill-rule="nonzero" d="M4 21h22v-1h-22z"/><path fill-rule="nonzero" d="M6.5 17h19.5v-1h-19.5z"/><path fill-rule="nonzero" d="M5 14.5v-3h-1v3zM6.617 9.275l10.158-3.628-.336-.942-10.158 3.628z"/><path d="M18.5 6c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM4.5 11c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM4.5 18c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    xabcd: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M20.449 8.505l2.103 9.112.974-.225-2.103-9.112zM13.943 14.011l7.631 4.856.537-.844-7.631-4.856zM14.379 11.716l4.812-3.609-.6-.8-4.812 3.609zM10.96 13.828l-4.721 6.744.819.573 4.721-6.744zM6.331 20.67l2.31-13.088-.985-.174-2.31 13.088zM9.041 7.454l1.995 3.492.868-.496-1.995-3.492z"/><path fill-rule="nonzero" d="M8.5 7c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM5.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM12.5 14c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM20.5 8c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM23.5 21c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    headshoulders: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M4.436 21.667l2.083-9.027-.974-.225-2.083 9.027zM10.046 16.474l-2.231-4.463-.894.447 2.231 4.463zM13.461 6.318l-2.88 10.079.962.275 2.88-10.079zM18.434 16.451l-2.921-10.224-.962.275 2.921 10.224zM21.147 12.089l-2.203 4.405.894.447 2.203-4.405zM25.524 21.383l-2.09-9.055-.974.225 2.09 9.055z"/><path fill-rule="nonzero" d="M1 19h7.5v-1h-7.5z"/><path fill-rule="nonzero" d="M12.5 19h4v-1h-4z"/><path fill-rule="nonzero" d="M20.5 19h6.5v-1h-6.5z"/><path fill-rule="nonzero" d="M6.5 12c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM3.5 25c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM10.5 20c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM18.5 20c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM22.5 12c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM25.5 25c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM14.5 6c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    longpos: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M5.5 20c1.2 0 2.22.86 2.45 2H25v1H7.95a2.5 2.5 0 1 1-2.45-3m0 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M25 18H5v-1h20zm-11-4h3v1h-4V9h1zM5.5 4c1.2 0 2.22.86 2.45 2H25v1H7.95A2.5 2.5 0 1 1 5.5 4m0 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3"/></svg>',
    shortpos: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M5.5 20c1.2 0 2.22.86 2.45 2H25v1H7.95a2.5 2.5 0 1 1-2.45-3m0 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3m9.52-7q.53 0 .93.2l.2.1q.27.17.46.43l.06.1q.2.3.25.73v.02h-.82v-.01a1 1 0 0 0-.36-.55 1.2 1.2 0 0 0-.73-.2q-.22 0-.4.06l-.12.04a1 1 0 0 0-.36.3 1 1 0 0 0-.13.43v.01q0 .2.09.34t.26.25q.19.1.48.2l.76.21q.71.2 1.06.57l.08.1q.27.36.27.9v.02q0 .45-.2.81l-.07.1a2 2 0 0 1-.72.62q-.45.22-1.02.22-.42 0-.77-.1l-.22-.1a2 2 0 0 1-.7-.55 2 2 0 0 1-.3-.84v-.02h.86v.01q.1.36.39.57t.76.22q.34 0 .59-.11a1 1 0 0 0 .4-.31l.06-.1q.09-.17.08-.36a1 1 0 0 0-.1-.38l-.1-.1a1.5 1.5 0 0 0-.65-.34l-.78-.21q-.46-.13-.77-.34-.3-.21-.45-.51-.14-.3-.14-.73 0-.5.24-.88l.06-.09q.24-.32.61-.5.43-.23.96-.23M25 12H5v-1h20zM5.5 4c1.2 0 2.22.86 2.45 2H25v1H7.95A2.5 2.5 0 1 1 5.5 4m0 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3"/></svg>',
    pricerange: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M4 5h16.5v-1h-16.5zM25 24h-16.5v1h16.5z"/><path fill-rule="nonzero" d="M6.5 26c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM22.5 6c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/><path fill-rule="nonzero" d="M14 9v14h1v-14z"/><path d="M14.5 6l2.5 3h-5z"/></svg>',
    daterange: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M20 14h-14v1h14z"/><path d="M20 17v-5l3 2.5z"/><path fill-rule="nonzero" d="M24 8.5v16.5h1v-16.5zM4 4v16.5h1v-16.5z"/><path fill-rule="nonzero" d="M4.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM24.5 8c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    highlighter: '<svg viewBox="0 0 25 23" fill="currentColor"><path fill-rule="evenodd" d="M13.402 0L6.78144 6.71532C6.67313 6.82518 6.5917 6.95862 6.54354 7.10518L5.13578 11.3889C4.89843 12.1111 5.08375 12.9074 5.61449 13.4458L5.68264 13.5149L0 19.2789L8.12695 22.4056L11.2874 19.1999L11.3556 19.269C11.8863 19.8073 12.6713 19.9953 13.3834 19.7546L17.6013 18.3285C17.7493 18.2784 17.8835 18.1945 17.9931 18.0832L24.6912 11.2892L23.9857 10.5837L17.515 17.147L7.70658 7.19818L14.1076 0.705575L13.402 0ZM6.07573 11.7067L7.24437 8.15061L16.576 17.6158L13.0701 18.8012C12.7141 18.9215 12.3215 18.8275 12.0562 18.5584L6.31509 12.7351C6.04972 12.466 5.95706 12.0678 6.07573 11.7067ZM6.30539 14.3045L10.509 18.5682L7.87935 21.2355L1.78414 18.8904L6.30539 14.3045Z"/></svg>',
    marker: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M22.38 4.04h.04a1.3 1.3 0 0 1 1.21.33c.37.36.42.84.33 1.2v.04l-2.45 8.32c-.14.55-.57.91-1 1.04-.45.14-1.2.07-1.55-.63l-.34-.64-12.6 10.03c-.3.25-.67.31-1 .25a1.3 1.3 0 0 1-1.01-1.06c-.05-.31.02-.69.29-.99l.02-.02a35.13 35.13 0 0 0 .47-.57 1749.6 1749.6 0 0 0 5-6.15l3.7-4.57.91-1.13-.63-.33c-.7-.36-.77-1.1-.64-1.55.13-.44.5-.86 1.03-1l8.22-2.57zm-7.95 3.53c-.35.08-.5.56-.2.7l1.71.91-.64.8a17294.8 17294.8 0 0 1-10.24 12.6l-.01.02c-.17.19.15.52.33.35l13.55-10.78.92 1.7c.14.3.62.16.7-.2l2.44-8.31c.05-.24-.1-.4-.35-.35l-8.2 2.56zM5.8 23.27z"/></svg>',
    ellipse: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M12.435 6.136c-4.411.589-7.983 3.039-9.085 6.27l.946.323c.967-2.836 4.209-5.059 8.271-5.602l-.132-.991zM3.347 16.584c1.101 3.243 4.689 5.701 9.117 6.283l.13-.991c-4.079-.537-7.335-2.767-8.301-5.613l-.947.321zM16.554 22.865c4.381-.582 7.94-3 9.071-6.2l-.943-.333c-.994 2.811-4.224 5.006-8.26 5.542l.132.991zM25.646 12.394c-1.107-3.225-4.675-5.668-9.078-6.257l-.133.991c4.056.542 7.293 2.76 8.265 5.591l.946-.325z"/><path fill-rule="nonzero" d="M14.5 8c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM14.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM3.5 16c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5zM25.5 16c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    note: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M5 3h17v13H5V3Zm8 14H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h17a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-8v4.05a2.5 2.5 0 1 1-1 0V17Zm.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM14 5h3a1 1 0 0 1 1 1v2h-1V6h-3v7h2v1h-5v-1h2V6h-3v2H9V6a1 1 0 0 1 1-1h4Z"/></svg>',
    pricelabel: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="nonzero" d="M6.995 5c.008 0 .005 15.5.005 15.5h-1v-15.493c0-.556.451-1.007.995-1.007h17.01c.549 0 .995.45.995 1.007v11.986c0 .556-.45 1.007-1.007 1.007h-12.993l-3.104 3.104-.707-.707 3.397-3.397h13.407c.004 0 .007-11.993.007-11.993 0-.007-17.005-.007-17.005-.007z"/><path fill-rule="nonzero" d="M6.5 24c.828 0 1.5-.672 1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5 1.5.672 1.5 1.5 1.5zm0 1c-1.381 0-2.5-1.119-2.5-2.5s1.119-2.5 2.5-2.5 2.5 1.119 2.5 2.5-1.119 2.5-2.5 2.5z"/></svg>',
    sticker: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M4.05 14a9.95 9.95 0 1 1 19.9 0 9.95 9.95 0 0 1-19.9 0ZM14 3a11 11 0 1 0 0 22 11 11 0 0 0 0-22Zm-3 13.03a.5.5 0 0 1 .64.3 2.5 2.5 0 0 0 4.72 0 .5.5 0 0 1 .94.34 3.5 3.5 0 0 1-6.6 0 .5.5 0 0 1 .3-.64Zm.5-4.53a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/></svg>',

    /* --- top-bar glyphs lifted from TradingView's own header --- */
    /* "Indicator templates" */
    templates: '<svg viewBox="0 0 28 28"><path fill="currentColor" fill-rule="evenodd" d="M8 7h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM6 8c0-1.1.9-2 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8zm11-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm-2 1c0-1.1.9-2 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V8zm-4 8H8a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1zm-3-1a2 2 0 0 0-2 2v3c0 1.1.9 2 2 2h3a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H8zm9 1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zm-2 1c0-1.1.9-2 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3z"/></svg>',
    /* "Bar replay" */
    replay: '<svg viewBox="0 0 28 28" fill="none"><path stroke="currentColor" d="M13.5 20V9l-6 5.5 6 5.5zM21.5 20V9l-6 5.5 6 5.5z"/></svg>',
    /* replay transport */
    play: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M10 7.2v13.6L21 14z"/></svg>',
    pause: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M9 6.6h3.6v14.8H9zM15.4 6.6H19v14.8h-3.6z"/></svg>',
    step: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M7 6.6v14.8L16 14zM17.5 6.6h3v14.8h-3z"/></svg>',
    restart: '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.8 14a7.2 7.2 0 1 0 2.6-5.56"/><path d="M6.4 5.4v4.6h4.6"/></svg>',

    /* --- header / footer chrome (verbatim from TV's own toolbars) --- */
    /* Switch data type — sits in the right edge of the symbol button */
    datatype: '<svg viewBox="0 0 18 18" fill="currentColor"><path d="M17 8.2 9 16 1 8.2 3.667 3h10.666zM2.226 8 9 14.602 15.773 8l-2.05-4H4.277zM9.5 7H11v3H9.5v2h-1v-2H7V7h1.5V5h1z"/></svg>',
    compare: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M13.5 5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM4 13.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"/><path d="M9 14h4v-4h1v4h4v1h-4v4h-1v-4H9v-1z"/></svg>',
    /* Chart type — the Candles glyph */
    charttype: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M7.5 6.5h4v13h-4v-13Zm1-12h2v4h-2v-4Zm0 18h2v4h-2v-4Zm10-4.5h4v8h-4v-8Zm1-11.5h2v4h-2V6.5Zm0 18h2v4h-2v-4Z"/></svg>',
    /* Indicators, metrics, and strategies */
    indicators: '<svg viewBox="0 0 28 28" fill="none"><path stroke="currentColor" d="M6 12l4.8-4.8a1 1 0 0 1 1.4 0l2.7 2.7a1 1 0 0 0 1.3.1L23 5"/><path fill="currentColor" fill-rule="evenodd" d="M19 12a1 1 0 0 0-1 1v4h-3v-1a1 1 0 0 0-1-1h-3a1 1 0 0 0-1 1v2H7a1 1 0 0 0-1 1v4h17V13a1 1 0 0 0-1-1h-3zm0 10h3v-9h-3v9zm-1 0v-4h-3v4h3zm-4-4.5V22h-3v-6h3v1.5zM10 22v-3H7v3h3z"/></svg>',
    /* Create alert */
    alert: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="m19.54 4.5 3.96 4.32-.74.68-3.96-4.32zM7.46 4.5 3.5 8.82l.74.68L8.2 5.18zM19.74 10.33A7.5 7.5 0 0 1 21 14.5v.5h1v-.5a8.5 8.5 0 1 0-8.5 8.5h.5v-1h-.5a7.5 7.5 0 1 1 6.24-11.67z"/><path d="M13 9v5h-3v1h4V9zM19 20v-4h1v4h4v1h-4v4h-1v-4h-4v-1h4z"/></svg>',
    undo: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M8.707 13l2.647 2.646-.707.708L6.792 12.5l3.853-3.854.708.708L8.707 12H14.5a5.5 5.5 0 0 1 5.5 5.5V19h-1v-1.5a4.5 4.5 0 0 0-4.5-4.5H8.707z"/></svg>',
    redo: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M18.293 13l-2.647 2.646.707.708 3.854-3.854-3.854-3.854-.707.708L18.293 12H12.5A5.5 5.5 0 0 0 7 17.5V19h1v-1.5a4.5 4.5 0 0 1 4.5-4.5h5.793z"/></svg>',
    /* Layout setup */
    layout: '<svg viewBox="-1 -1 21 19" fill="currentColor"><path fill-rule="evenodd" d="M2.5 1A1.5 1.5 0 0 0 1 2.5v12A1.5 1.5 0 0 0 2.5 16h14a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 16.5 1h-14ZM0 2.5A2.5 2.5 0 0 1 2.5 0h14A2.5 2.5 0 0 1 19 2.5v12a2.5 2.5 0 0 1-2.5 2.5h-14A2.5 2.5 0 0 1 0 14.5v-12Z"/></svg>',
    /* the small "manage layouts" dropdown chevron */
    caret16: '<svg viewBox="0 0 16 8" fill="currentColor"><path d="M0 1.475l7.396 6.04.596.485.593-.49L16 1.39 14.807 0 7.393 6.122 8.58 6.12 1.186.08z"/></svg>',
    quicksearch: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M17 4h1v3h-1zM17 15v3h1v-3zM18 8h-5a1 1 0 0 0-.83 1.55l4 6A1 1 0 0 0 17 16v-5h1z"/><path d="M5 13.5a7.5 7.5 0 0 1 6-7.35v1.02A6.5 6.5 0 1 0 18.98 13h1l.02.5a7.47 7.47 0 0 1-1.85 4.94L23 23.29l-.71.7-4.85-4.84A7.5 7.5 0 0 1 5 13.5"/></svg>',
    /* Settings — TV's hexagonal gear */
    gearTv: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M11.76 3h4.48l.46 2.36c.6.24 1.17.56 1.69.95l2.25-.79 2.24 3.88-1.8 1.46c.06.32.1.65.12 1l.01.34-.01.34c-.02.35-.06.68-.12 1l1.8 1.46-2.24 3.88-2.25-.79c-.52.39-1.09.71-1.69.95l-.46 2.36h-4.48l-.46-2.36a7.9 7.9 0 0 1-1.69-.95l-2.25.79-2.24-3.88 1.8-1.46a7.7 7.7 0 0 1-.12-1l-.01-.34.01-.34c.02-.35.06-.68.12-1l-1.8-1.46 2.24-3.88 2.25.79c.52-.39 1.09-.71 1.69-.95L11.76 3ZM14 9.5A4.5 4.5 0 1 0 14 18.5 4.5 4.5 0 0 0 14 9.5Zm0 1A3.5 3.5 0 1 1 14 17.5 3.5 3.5 0 0 1 14 10.5Z"/></svg>',
    fullscreen: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M7 18.5A2.5 2.5 0 0 0 9.5 21H12v1H9.5A3.5 3.5 0 0 1 6 18.5V16h1zm15 0a3.5 3.5 0 0 1-3.5 3.5H16v-1h2.5a2.5 2.5 0 0 0 2.5-2.5V16h1zM12 7H9.5A2.5 2.5 0 0 0 7 9.5V12H6V9.5A3.5 3.5 0 0 1 9.5 6H12zm6.5-1A3.5 3.5 0 0 1 22 9.5V12h-1V9.5A2.5 2.5 0 0 0 18.5 7H16V6z"/></svg>',
    /* Take a snapshot (camera) */
    snapshot: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.118 6a.5.5 0 0 0-.447.276L9.809 8H5.5A1.5 1.5 0 0 0 4 9.5v10A1.5 1.5 0 0 0 5.5 21h16a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 21.5 8h-4.309l-.862-1.724A.5.5 0 0 0 15.882 6h-4.764Zm-1.342-.17A1.5 1.5 0 0 1 11.118 5h4.764a1.5 1.5 0 0 1 1.342.83L17.809 7H21.5A2.5 2.5 0 0 1 24 9.5v10a2.5 2.5 0 0 1-2.5 2.5h-16A2.5 2.5 0 0 1 3 19.5v-10A2.5 2.5 0 0 1 5.5 7h3.691l.585-1.17Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M13.5 18a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0 1a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z"/></svg>',
    /* Share your idea */
    share: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M13 17v-4H9v-1h4V8h1v4h4v1h-4v4z"/><path fill-rule="evenodd" d="M6 12.3C6 8.28 9.35 5 13.5 5S21 8.28 21 12.3c0 2.32-.97 4.37-2.65 5.7H8.59A7.71 7.71 0 0 1 6 12.3Zm5 9.7h5v2h-5Zm-2-1v-2h9v2z"/></svg>',
    /* Go to date (bottom bar) */
    goto: '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M11 4h-1v2H7.5A2.5 2.5 0 0 0 5 8.5V13h1v-2h16v8.5c0 .83-.67 1.5-1.5 1.5H14v1h6.5a2.5 2.5 0 0 0 2.5-2.5v-11A2.5 2.5 0 0 0 20.5 6H18V4h-1v2h-6V4Zm6 4V7h-6v1h-1V7H7.5C6.67 7 6 7.67 6 8.5V10h16V8.5c0-.83-.67-1.5-1.5-1.5H18v1h-1Zm-5.15 10.15-3.5-3.5-.7.7L10.29 18H4v1h6.3l-2.65 2.65.7.7 3.5-3.5.36-.35-.36-.35Z"/></svg>',

    /* --- right-hand strip: TV's own 44x44 glyphs, verbatim --------------- */
    rtWatch: '<svg viewBox="0 0 44 44" fill="currentColor"><path d="M31 11a1 1 0 0 1 1 1v22l-10-4-10 4V12a1 1 0 0 1 1-1zM13 32.523l9-3.6 9 3.6V12H13zM28 23H16v-1h12zm0-6H16v-1h12z"/></svg>',
    rtAlerts: '<svg viewBox="0 0 44 44"><path fill="currentColor" d="M35 14.66 29.16 9l-.7.72 5.84 5.66.7-.72ZM9 14.66 14.84 9l.7.72-5.84 5.66-.7-.72ZM22 16v7h-5v1h6v-8h-1Z"></path><path fill="currentColor" fill-rule="evenodd" d="M22 33a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm0-1a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"></path></svg>',
    rtTree: '<svg viewBox="0 0 44 44"><path fill="currentColor" d="M21.34 12.13a1 1 0 0 1 .98 0l10.41 5.93a1 1 0 0 1 0 1.73l-10.4 5.93a1 1 0 0 1-.99 0L10.78 19.8a1 1 0 0 1 0-1.75l10.56-5.92Zm.49.87-10.56 5.93 10.56 5.93 10.4-5.93L21.84 13ZM33.5 24.86l-11.66 6.8L10 25l.5-.87 11.33 6.38L32.99 24l.5.87Z"></path></svg>',
    /* TV paints this one with an animated gradient; the outline is what
       carries the shape, so it stays a plain stroke here. */
    rtCopilot: '<svg viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m22 10.5-1.53 4.15a9.9 9.9 0 0 1-5.82 5.82L10.5 22l4.15 1.53c2.7 1 4.82 3.13 5.82 5.82L22 33.5l1.53-4.15c1-2.7 3.13-4.82 5.82-5.82L33.5 22l-4.15-1.53a9.9 9.9 0 0 1-5.82-5.82Z"/></svg>',
    rtScreeners: '<svg viewBox="0 0 44 44" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M22 8a14 14 0 1 0 0 28 14 14 0 0 0 0-28ZM9 22a13 13 0 0 1 22.03-9.35L27.5 16.2a8 8 0 1 0 .68.73l3.55-3.55A13 13 0 1 1 9 22Zm17.79-5.1a7 7 0 1 0 .68.74l-3.62 3.6A2 2 0 0 1 22 24a2 2 0 1 1 1.25-3.56l3.54-3.54Z"/></svg>',
    rtPine: '<svg viewBox="0 0 44 44"><path fill="currentColor" d="M22.38 10.18a.5.5 0 0 0-.78.02l-9.5 12.5a.5.5 0 0 0 .57.77l6.85-2.4 5.72 4.81c.17.14.4.16.59.04l5.93-3.75a.5.5 0 0 0 .12-.74zm-8.47 11.8L22 11.3l8.73 10.33-5.14 3.25-5.65-4.76a.5.5 0 0 0-.5-.1z"></path><path fill="currentColor" d="M13.64 26 9.1 32.2a.5.5 0 0 0 .4.8h25a.5.5 0 0 0 .4-.8L30.36 26l-.8.59 3.95 5.4H10.5l3.96-5.4z"></path></svg>',
    rtCalendar: '<svg viewBox="0 0 44 44"><path fill="currentColor" fill-rule="evenodd" d="M15 11h2v4h-2v-4Zm-1 0a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1h8v-1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1h1a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3h1v-1Zm4 2h8v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2h1a2 2 0 0 1 2 2v4H11v-4c0-1.1.9-2 2-2h1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2Zm-7 7v11c0 1.1.9 2 2 2h18a2 2 0 0 0 2-2V20H11Zm18-9h-2v4h2v-4Z"></path></svg>',
    rtCommunity: '<svg viewBox="0 0 44 44" fill="none"><path fill="currentColor" d="M12 10c-.335 0-.669.008-1 .023v1.002c.331-.017.665-.025 1-.025 11.046 0 20 8.954 20 20 0 .335-.008.669-.025 1h1.002c.015-.331.023-.665.023-1 0-11.598-9.402-21-21-21Z"></path><path fill="currentColor" d="M27 31c0 .336-.011.67-.033 1h-1.002c.023-.33.035-.664.035-1 0-7.732-6.268-14-14-14-.336 0-.67.012-1 .035v-1.002c.33-.022.664-.033 1-.033 8.284 0 15 6.716 15 15Z"></path><path fill="currentColor" d="M21 31c0 .338-.019.672-.055 1h-1.007A8 8 0 0 0 11 23.062v-1.007A9 9 0 0 1 21 31Z"></path><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M15 30a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm-1 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>',
    rtBell: '<svg viewBox="0 0 44 44" fill="none"><path fill="currentColor" d="M22 10a9 9 0 0 1 9 9v4c0 1.105.988 1.959 1.855 2.643A3 3 0 0 1 31 31h-5a4 4 0 0 1-8 0h-5a3 3 0 0 1-1.982-5.251l.127-.106C12.012 24.959 13 24.105 13 23v-4a9 9 0 0 1 9-9m-3 21a3 3 0 1 0 6 0zm3-20a8 8 0 0 0-8 8v4c0 .866-.39 1.573-.826 2.11-.432.53-.974.974-1.41 1.318A2 2 0 0 0 13 30h18a2 2 0 0 0 1.236-3.572c-.436-.344-.978-.788-1.41-1.319C30.39 24.573 30 23.866 30 23v-4a8 8 0 0 0-8-8"></path></svg>',
    rtChats: '<svg viewBox="0 0 44 44" fill="none"><path fill="currentColor" d="M26.5 12a2.5 2.5 0 0 1 2.5 2.5V18h1.5a2.5 2.5 0 0 1 2.5 2.5V34l-4.2-4h-8.3a2.5 2.5 0 0 1-2.5-2.5V26h-2.8L11 30V14.5a2.5 2.5 0 0 1 2.5-2.5zM29 23.5a2.5 2.5 0 0 1-2.5 2.5H19v1.5a1.5 1.5 0 0 0 1.5 1.5h8.7l.145.139L32 31.672V20.5a1.5 1.5 0 0 0-1.5-1.5H29zM13.5 13a1.5 1.5 0 0 0-1.5 1.5v13.172l2.655-2.533L14.8 25h11.7a1.5 1.5 0 0 0 1.5-1.5v-9a1.5 1.5 0 0 0-1.5-1.5z"></path></svg>',
    rtProducts: '<svg viewBox="0 0 44 44"><path fill="currentColor" d="M22 5a17 17 0 1 1 0 34 17 17 0 0 1 0-34m-8 22a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm7 0a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm7 0a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm-14-7a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm7 0a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm7 0a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm-14-7a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm7 0a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm7 0a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1z"></path></svg>',
    rtHelp: '<svg viewBox="0 0 44 44" fill="none"><path fill="currentColor" d="M22 8c7.732 0 14 6.268 14 14s-6.268 14-14 14S8 29.732 8 22 14.268 8 22 8m0 1C14.82 9 9 14.82 9 22s5.82 13 13 13 13-5.82 13-13S29.18 9 22 9m.201 18.01A2.016 2.016 0 0 1 24 29l-.01.204A2.017 2.017 0 0 1 22 31l-.201-.01a2.02 2.02 0 0 1-1.788-1.785L20 29c0-1.104.917-2 2-2zM22 28c-.537 0-1 .455-1 1s.462 1 1 1 1-.455 1-1-.462-1-1-1m.31-15C24.9 13 27 15.1 27 17.69a4.31 4.31 0 0 1-2.195 3.754l-.872.492a2.81 2.81 0 0 0-1.433 2.45V25h-1v-.614c0-1.377.743-2.647 1.942-3.322l.872-.49A3.31 3.31 0 0 0 26 17.688 3.69 3.69 0 0 0 22.31 14H22a4 4 0 0 0-4 4h-1a5 5 0 0 1 5-5z"></path></svg>'
  };

  /* tvicons.js carries the glyphs for every remaining TradingView tool,
     captured verbatim from the live flyouts. Anything hand-written above
     wins; these only fill the gaps. */
  (function () {
    var extra = window.TV_ICONS || {};
    Object.keys(extra).forEach(function (k) { if (!ICON[k]) ICON[k] = extra[k]; });
  })();

  /* TradingView's chart-type menu, in the order the live menu lists them.
     `sym` is the glyph drawn next to the label; `fmt` describes the series
     that gets swapped in. */
  var CHART_TYPES = {
    bars: { label: "Bars", hint: "Alt+1" },
    candles: { label: "Candles", hint: "Alt+2" },
    heikinashi: { label: "Heikin Ashi", hint: "Alt+3" },
    hollow: { label: "Hollow candles" },
    line: { label: "Line", hint: "Alt+4" },
    area: { label: "Area", hint: "Alt+5" },
    baseline: { label: "Baseline" }
  };
  var CHART_TYPE_ORDER = ["bars", "candles", "heikinashi", "hollow", "line", "area", "baseline"];
  /* one small 28-grid glyph per type so the menu reads like TV's */
  CHART_TYPES.bars.icon = '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M7.5 4h1.5v5H7.5zM7.5 19h1.5v5H7.5zM6 9h4.5v10H6zM18 7h1.5v4H18zM18 18h1.5v4H18zM16.5 11h4.5v7h-4.5z"/></svg>';
  CHART_TYPES.candles.icon = ICON.charttype;
  CHART_TYPES.heikinashi.icon = '<svg viewBox="0 0 28 28" fill="currentColor"><path fill-rule="evenodd" d="M6.5 7.5h4v11h-4v-11Zm1-3.5h2v3.5h-2V4Zm0 14.5h2v4h-2v-4Zm10-3h4v8h-4v-8Zm1-5.5h2v5h-2v-5Zm0 13h2v4h-2v-4Z"/></svg>';
  CHART_TYPES.hollow.icon = '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6.5 10h4v9h-4zM17.5 8h4v11h-4zM8.5 4v6M8.5 19v5M19.5 4v4M19.5 19v5"/></svg>';
  CHART_TYPES.line.icon = '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 19l5.5-6 4 3.5L23 7"/></svg>';
  CHART_TYPES.area.icon = '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M5 20l5.5-7 4 4L23 8v12H5z" opacity=".45"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M5 20l5.5-7 4 4L23 8"/></svg>';
  CHART_TYPES.baseline.icon = '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 14h20" opacity=".55"/><path d="M5 19l5-6 4 4 4-6 5 4"/></svg>';

  /* ==================================================== numeric routines */
  function srcArr(d, src) {
    switch (src) {
      case "open": return d.open;
      case "high": return d.high;
      case "low": return d.low;
      case "hl2": return d.high.map(function (h, i) { return (h + d.low[i]) / 2; });
      case "hlc3": return d.high.map(function (h, i) { return (h + d.low[i] + d.close[i]) / 3; });
      case "ohlc4": return d.open.map(function (o, i) { return (o + d.high[i] + d.low[i] + d.close[i]) / 4; });
      default: return d.close;
    }
  }

  /* NaN-aware rolling average: a window with holes averages what it has. */
  function smaArr(a, n) {
    n = Math.max(1, n | 0);
    var out = new Array(a.length), sum = 0, cnt = 0, i, v, old;
    for (i = 0; i < a.length; i++) {
      v = a[i];
      if (isNum(v)) { sum += v; cnt++; }
      if (i >= n) { old = a[i - n]; if (isNum(old)) { sum -= old; cnt--; } }
      out[i] = (i >= n - 1 && cnt > 0) ? sum / cnt : NaN;
    }
    return out;
  }

  function emaArr(a, n) {
    n = Math.max(1, n | 0);
    return emaK(a, n, 2 / (n + 1));
  }

  /* seeded with the SMA of the first n finite values, so no NaN poisoning */
  function emaK(a, n, k) {
    var out = new Array(a.length), i;
    for (i = 0; i < a.length; i++) out[i] = NaN;
    var sum = 0, cnt = 0, seed = -1;
    for (i = 0; i < a.length; i++) {
      if (!isNum(a[i])) continue;
      sum += a[i]; cnt++;
      if (cnt === n) { seed = i; break; }
    }
    if (seed < 0) return out;
    var prev = sum / n;
    out[seed] = prev;
    for (i = seed + 1; i < a.length; i++) {
      if (!isNum(a[i])) continue;
      prev = a[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function wmaArr(a, n) {
    n = Math.max(1, n | 0);
    var out = new Array(a.length), den = n * (n + 1) / 2, i, j;
    for (i = 0; i < a.length; i++) out[i] = NaN;
    for (i = n - 1; i < a.length; i++) {
      var s = 0, ok = true;
      for (j = 0; j < n; j++) {
        var v = a[i - j];
        if (!isNum(v)) { ok = false; break; }
        s += v * (n - j);
      }
      if (ok) out[i] = s / den;
    }
    return out;
  }

  function hmaArr(a, n) {
    n = Math.max(2, n | 0);
    var half = wmaArr(a, Math.max(1, Math.round(n / 2)));
    var full = wmaArr(a, n);
    var diff = new Array(a.length);
    for (var i = 0; i < a.length; i++) {
      diff[i] = (isNum(half[i]) && isNum(full[i])) ? 2 * half[i] - full[i] : NaN;
    }
    return wmaArr(diff, Math.max(1, Math.round(Math.sqrt(n))));
  }

  function sdArr(a, n) {
    n = Math.max(1, n | 0);
    var out = new Array(a.length), i, j;
    for (i = 0; i < a.length; i++) out[i] = NaN;
    for (i = n - 1; i < a.length; i++) {
      var m = 0, ok = true;
      for (j = i - n + 1; j <= i; j++) { if (!isNum(a[j])) { ok = false; break; } m += a[j]; }
      if (!ok) continue;
      m /= n;
      var v = 0;
      for (j = i - n + 1; j <= i; j++) { var dd = a[j] - m; v += dd * dd; }
      out[i] = Math.sqrt(v / n);
    }
    return out;
  }

  function wilderArr(a, n) {
    n = Math.max(1, n | 0);
    var out = new Array(a.length), i;
    for (i = 0; i < a.length; i++) out[i] = NaN;
    if (a.length < n) return out;
    var s = 0;
    for (i = 0; i < n; i++) s += a[i];
    var prev = s / n;
    out[n - 1] = prev;
    for (i = n; i < a.length; i++) { prev = (prev * (n - 1) + a[i]) / n; out[i] = prev; }
    return out;
  }

  function trueRange(d) {
    var out = new Array(d.n);
    for (var i = 0; i < d.n; i++) {
      var pc = i ? d.close[i - 1] : d.open[i];
      out[i] = Math.max(d.high[i] - d.low[i], Math.abs(d.high[i] - pc), Math.abs(d.low[i] - pc));
    }
    return out;
  }

  function atrArr(d, n) { return wilderArr(trueRange(d), n); }

  function rsiArr(c, n) {
    var out = new Array(c.length), i;
    for (i = 0; i < c.length; i++) out[i] = NaN;
    if (c.length <= n) return out;
    var gain = 0, loss = 0, ch;
    for (i = 1; i <= n; i++) {
      ch = c[i] - c[i - 1];
      if (ch > 0) gain += ch; else loss -= ch;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (i = n + 1; i < c.length; i++) {
      ch = c[i] - c[i - 1];
      gain = (gain * (n - 1) + (ch > 0 ? ch : 0)) / n;
      loss = (loss * (n - 1) + (ch < 0 ? -ch : 0)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function hhll(d, n) {
    var hh = new Array(d.n), ll = new Array(d.n), i, j;
    for (i = 0; i < d.n; i++) { hh[i] = NaN; ll[i] = NaN; }
    for (i = n - 1; i < d.n; i++) {
      var h = -Infinity, l = Infinity;
      for (j = i - n + 1; j <= i; j++) { if (d.high[j] > h) h = d.high[j]; if (d.low[j] < l) l = d.low[j]; }
      hh[i] = h; ll[i] = l;
    }
    return { hh: hh, ll: ll };
  }

  function stochRaw(d, n) {
    var w = hhll(d, n), out = new Array(d.n);
    for (var i = 0; i < d.n; i++) {
      out[i] = isNum(w.hh[i]) && w.hh[i] !== w.ll[i]
        ? 100 * (d.close[i] - w.ll[i]) / (w.hh[i] - w.ll[i])
        : NaN;
    }
    return out;
  }

  function macdArr(c, f, s) {
    var ef = emaArr(c, f), es = emaArr(c, s), out = new Array(c.length);
    for (var i = 0; i < c.length; i++) {
      out[i] = (isNum(ef[i]) && isNum(es[i])) ? ef[i] - es[i] : NaN;
    }
    return out;
  }

  function adxArr(d, n, diLen) {
    var tr = trueRange(d), pdm = new Array(d.n), ndm = new Array(d.n), i;
    for (i = 0; i < d.n; i++) {
      if (i === 0) { pdm[i] = 0; ndm[i] = 0; continue; }
      var up = d.high[i] - d.high[i - 1], dn = d.low[i - 1] - d.low[i];
      pdm[i] = (up > dn && up > 0) ? up : 0;
      ndm[i] = (dn > up && dn > 0) ? dn : 0;
    }
    var str = wilderArr(tr, n), sp = wilderArr(pdm, n), sn = wilderArr(ndm, n);
    var pdi = new Array(d.n), ndi = new Array(d.n), dx = new Array(d.n);
    for (i = 0; i < d.n; i++) {
      if (!isNum(str[i]) || !str[i]) { pdi[i] = NaN; ndi[i] = NaN; dx[i] = NaN; continue; }
      pdi[i] = 100 * sp[i] / str[i];
      ndi[i] = 100 * sn[i] / str[i];
      var denom = pdi[i] + ndi[i];
      dx[i] = denom ? 100 * Math.abs(pdi[i] - ndi[i]) / denom : 0;
    }
    var adx = new Array(d.n), s = 0, cnt = 0, prev = NaN;
    for (i = 0; i < d.n; i++) {
      if (!isNum(dx[i])) { adx[i] = NaN; continue; }
      if (!isNum(prev)) {
        s += dx[i]; cnt++;
        if (cnt >= n) { prev = s / n; adx[i] = prev; }
        continue;
      }
      prev = (prev * (n - 1) + dx[i]) / n;
      adx[i] = prev;
    }
    return { adx: adx, pdi: pdi, ndi: ndi };
  }

  function mfiArr(d, n) {
    var out = new Array(d.n), i;
    for (i = 0; i < d.n; i++) out[i] = NaN;
    var tp = new Array(d.n), rmf = new Array(d.n);
    for (i = 0; i < d.n; i++) { tp[i] = (d.high[i] + d.low[i] + d.close[i]) / 3; rmf[i] = tp[i] * d.volume[i]; }
    var pos = 0, neg = 0;
    for (i = 1; i < d.n; i++) {
      var diff = tp[i] - tp[i - 1];
      if (diff > 0) pos += rmf[i]; else if (diff < 0) neg += rmf[i];
      if (i >= n) {
        var j = i - n, dj = tp[j] - tp[j - 1];
        if (dj > 0) pos -= rmf[j]; else if (dj < 0) neg -= rmf[j];
      }
      if (i >= n - 1 && pos + neg > 0) out[i] = 100 - 100 / (1 + pos / neg);
    }
    return out;
  }

  function cciArr(d, n) {
    var tp = new Array(d.n), i, j;
    for (i = 0; i < d.n; i++) tp[i] = (d.high[i] + d.low[i] + d.close[i]) / 3;
    var base = smaArr(tp, n), out = new Array(d.n);
    for (i = 0; i < d.n; i++) out[i] = NaN;
    for (i = n - 1; i < d.n; i++) {
      var m = 0;
      for (j = i - n + 1; j <= i; j++) m += Math.abs(tp[j] - base[i]);
      m /= n;
      out[i] = m ? (tp[i] - base[i]) / (0.015 * m) : 0;
    }
    return out;
  }

  function willrArr(d, n) {
    var w = hhll(d, n), out = new Array(d.n);
    for (var i = 0; i < d.n; i++) {
      var span = w.hh[i] - w.ll[i];
      out[i] = isNum(w.hh[i]) && span ? -100 * (w.hh[i] - d.close[i]) / span : NaN;
    }
    return out;
  }

  function obvArr(d) {
    var out = new Array(d.n), acc = 0;
    for (var i = 0; i < d.n; i++) {
      if (i) acc += d.close[i] > d.close[i - 1] ? d.volume[i] : d.close[i] < d.close[i - 1] ? -d.volume[i] : 0;
      out[i] = acc;
    }
    return out;
  }

  function rocArr(c, n) {
    var out = new Array(c.length);
    for (var i = 0; i < c.length; i++) out[i] = i >= n && c[i - n] ? 100 * (c[i] / c[i - n] - 1) : NaN;
    return out;
  }

  function momArr(c, n) {
    var out = new Array(c.length);
    for (var i = 0; i < c.length; i++) out[i] = i >= n ? c[i] - c[i - n] : NaN;
    return out;
  }

  function vwapArr(d) {
    var out = new Array(d.n), pv = 0, vv = 0;
    for (var i = 0; i < d.n; i++) {
      var tp = (d.high[i] + d.low[i] + d.close[i]) / 3;
      pv += tp * d.volume[i]; vv += d.volume[i];
      out[i] = vv ? pv / vv : NaN;
    }
    return out;
  }

  function supertrendArr(d, n, mult) {
    var a = atrArr(d, n);
    var upper = new Array(d.n), lower = new Array(d.n), dir = new Array(d.n), line = new Array(d.n);
    for (var i = 0; i < d.n; i++) { upper[i] = NaN; lower[i] = NaN; dir[i] = 1; line[i] = NaN; }
    for (i = 1; i < d.n; i++) {
      if (!isNum(a[i])) continue;
      var mid = (d.high[i] + d.low[i]) / 2;
      var bu = mid + mult * a[i], bl = mid - mult * a[i];
      if (!isNum(upper[i - 1])) { upper[i] = bu; lower[i] = bl; dir[i] = 1; line[i] = NaN; continue; }
      upper[i] = (bu < upper[i - 1] || d.close[i - 1] > upper[i - 1]) ? bu : upper[i - 1];
      lower[i] = (bl > lower[i - 1] || d.close[i - 1] < lower[i - 1]) ? bl : lower[i - 1];
      if (dir[i - 1] === 1) dir[i] = d.close[i] < lower[i] ? -1 : 1;
      else dir[i] = d.close[i] > upper[i] ? 1 : -1;
      line[i] = dir[i] === 1 ? lower[i] : upper[i];
    }
    return { line: line, dir: dir };
  }

  function sarArr(d, step, max) {
    var out = new Array(d.n), i;
    for (i = 0; i < d.n; i++) out[i] = NaN;
    if (d.n < 3) return out;
    var long = d.close[1] >= d.close[0];
    var ep = long ? d.high[0] : d.low[0];
    var sar = long ? d.low[0] : d.high[0];
    var af = step;
    for (i = 1; i < d.n; i++) {
      sar = sar + af * (ep - sar);
      if (long) {
        var lo1 = d.low[i - 1];
        var lo2 = i > 1 ? d.low[i - 1] : lo1;
        sar = Math.min(sar, lo1, lo2);
        if (d.low[i] < sar) { long = false; sar = ep; if (sar < d.high[i - 1]) sar = d.high[i - 1]; ep = d.low[i]; af = step; }
        else if (d.high[i] > ep) { ep = d.high[i]; af = Math.min(max, af + step); }
      } else {
        var hi1 = d.high[i - 1];
        sar = Math.max(sar, hi1, hi1);
        if (d.high[i] > sar) { long = true; sar = ep; if (sar > d.low[i - 1]) sar = d.low[i - 1]; ep = d.high[i]; af = step; }
        else if (d.low[i] < ep) { ep = d.low[i]; af = Math.min(max, af + step); }
      }
      out[i] = sar;
    }
    return out;
  }

  function ichimokuArr(d) {
    var t9 = hhll(d, 9), t26 = hhll(d, 26), t52 = hhll(d, 52);
    var tenkan = new Array(d.n), kijun = new Array(d.n), rawA = new Array(d.n), rawB = new Array(d.n);
    var spanA = new Array(d.n), spanB = new Array(d.n), chikou = new Array(d.n), i;
    for (i = 0; i < d.n; i++) {
      tenkan[i] = isNum(t9.hh[i]) ? (t9.hh[i] + t9.ll[i]) / 2 : NaN;
      kijun[i] = isNum(t26.hh[i]) ? (t26.hh[i] + t26.ll[i]) / 2 : NaN;
      rawA[i] = (isNum(tenkan[i]) && isNum(kijun[i])) ? (tenkan[i] + kijun[i]) / 2 : NaN;
      rawB[i] = isNum(t52.hh[i]) ? (t52.hh[i] + t52.ll[i]) / 2 : NaN;
      spanA[i] = i >= 26 ? rawA[i - 26] : NaN;
      spanB[i] = i >= 26 ? rawB[i - 26] : NaN;
      chikou[i] = i + 26 < d.n ? d.close[i + 26] : NaN;
    }
    return { tenkan: tenkan, kijun: kijun, spanA: spanA, spanB: spanB, chikou: chikou };
  }

  function shift(a, n) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) out[i] = i >= n ? a[i - n] : NaN;
    return out;
  }

  /* zip values to [{time, value}], skipping holes so lines break properly */
  function zip(d, a) {
    var out = [];
    for (var i = 0; i < a.length && i < d.n; i++) {
      if (isNum(a[i])) out.push({ time: d.time[i], value: a[i] });
    }
    return out;
  }

  function zipColor(d, a, up, down) {
    var out = [];
    for (var i = 0; i < a.length && i < d.n; i++) {
      if (isNum(a[i])) out.push({ time: d.time[i], value: a[i], color: a[i] >= 0 ? up : down });
    }
    return out;
  }

  /* TradingView's built-in MACD colours the histogram four ways:
       hist >= 0 ? (rising ? grow_above : fall_above)
                 : (rising ? grow_below : fall_below)
     i.e. dark green / faded green above zero, faded red / dark red below. */
  function zipColor4(d, a, growAbove, fallAbove, growBelow, fallBelow) {
    var out = [];
    var prev = NaN;
    for (var i = 0; i < a.length && i < d.n; i++) {
      var v = a[i];
      if (isNum(v)) {
        var rising = isNum(prev) ? prev < v : true;
        var c = v >= 0
          ? (rising ? growAbove : fallAbove)
          : (rising ? growBelow : fallBelow);
        out.push({ time: d.time[i], value: v, color: c });
      }
      prev = isNum(v) ? v : NaN;
    }
    return out;
  }

  function zipPick(d, a, pred) {
    var out = [];
    for (var i = 0; i < a.length && i < d.n; i++) {
      if (isNum(a[i]) && pred(i)) out.push({ time: d.time[i], value: a[i] });
    }
    return out;
  }

  /* A flat series used for TradingView's pane background fills: an AreaSeries
     pinned between `lo` and `hi`, filled bottom → top with `c` → `c2`. */
  function zipFlat(d, v) {
    var out = [];
    if (!isNum(v)) return out;
    for (var i = 0; i < d.n; i++) out.push({ time: d.time[i], value: v });
    return out;
  }
  function bandFill(d, lo, hi, c, c2) {
    return {
      type: "area", base: lo, band: true, color: c, color2: c2 || c,
      lastValue: false, data: zipFlat(d, hi)
    };
  }

  /* ================================================= indicator registry */
  var SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];
  var MA_TYPES = ["EMA", "SMA"];
  /* TradingView's Timeframe row offers Chart plus every interval above it. */
  var TF_OPTIONS = ["Chart", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];

  /* The ladder an input.timeframe() offers in TradingView's own dialog. Values
     stay in Pine's notation — "60" for an hour, "D" for a day — because that
     is what the runtime resamples with; the label is only for reading. The
     empty entry is "same as the chart", which a script gets when it omits the
     argument. */
  var PINE_TF_OPTIONS = [
    { v: "", t: "Chart" },
    { v: "1", t: "1 minute" }, { v: "3", t: "3 minutes" }, { v: "5", t: "5 minutes" },
    { v: "10", t: "10 minutes" }, { v: "15", t: "15 minutes" }, { v: "30", t: "30 minutes" },
    { v: "45", t: "45 minutes" },
    { v: "60", t: "1 hour" }, { v: "120", t: "2 hours" }, { v: "180", t: "3 hours" },
    { v: "240", t: "4 hours" }, { v: "360", t: "6 hours" }, { v: "720", t: "12 hours" },
    { v: "D", t: "1 day" }, { v: "W", t: "1 week" }, { v: "M", t: "1 month" }
  ];

  /* TradingView's interval typography: `15m` `4h` stay lowercase, but the
     day/week/month steps are shouted — `1D` `1W` `1M`. */
  function tfLabel(tf) { return String(tf || "").replace(/[dw]$/, function (m) { return m.toUpperCase(); }); }

  function F(key, label, type, extra) {
    var f = { key: key, label: label, type: type };
    if (extra) Object.keys(extra).forEach(function (k) { f[k] = extra[k]; });
    return f;
  }
  function fPeriod(v) { return F("period", "Length", "number", { min: 1, max: 500, dflt: v }); }
  function fSource() { return F("source", "Source", "select", { options: SOURCES }); }
  function fColor(key, label, dflt) { return F(key, label, "color", { dflt: dflt }); }
  function fWidth(label, key) {
    return F(key || "width", label || "Line width", "range", { min: 1, max: 4, step: 1 });
  }
  function fHeight() { return F("paneHeight", "Pane height", "range", { min: 60, max: 280, step: 10 }); }
  function fCheck(key, label, dflt) { return F(key, label, "checkbox", { dflt: dflt }); }
  function fMa(key, label, dflt) { return F(key, label, "select", { options: MA_TYPES, dflt: dflt }); }
  function fTf(key, label) { return F(key, label, "select", { options: TF_OPTIONS, dflt: "Chart" }); }
  /* Section headers are decorative rows inside a settings tab. */
  function fSection(title, tab) { return { key: "__sec", label: title, type: "section", tab: tab || "inputs" }; }

  /* TradingView splits an indicator dialog into Inputs and Style: colour and
     slider controls belong to Style, every other control is an Input. */
  function fieldTab(f) {
    if (f.tab) return f.tab;
    if (f.type === "section") return "inputs";
    return (f.type === "color" || f.type === "range") ? "style" : "inputs";
  }

  function maBy(a, n, type) {
    if (type === "SMA") return smaArr(a, n);
    return emaArr(a, n);
  }

  /* ---------------------------------------------------- timeframe (MACD) */
  function tfSeconds(tf) {
    var m = /^(\d+)\s*([smhdwM])$/.exec(String(tf || ""));
    if (!m) return 0;
    var mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 }[m[2]];
    return mult ? parseInt(m[1], 10) * mult : 0;
  }

  /* Aggregate the chart's bars onto a coarser interval so an indicator can run
     on "4h" while the chart shows "15m" — TradingView's Timeframe row. */
  function resample(d, tf) {
    var sec = tfSeconds(tf);
    if (!sec) return null;
    var monthly = /M$/.test(tf);
    var out = { time: [], open: [], high: [], low: [], close: [], volume: [], n: 0 };
    var map = new Array(d.n), cur = null, idx = -1, i, t, b, dt;
    for (i = 0; i < d.n; i++) {
      t = d.time[i];
      if (monthly) {
        dt = new Date(t * 1000);
        b = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1) / 1000;
      } else {
        b = Math.floor(t / sec) * sec;
      }
      if (b !== cur) {
        cur = b; idx = out.time.length;
        out.time.push(b);
        out.open.push(d.open[i]);
        out.high.push(d.high[i]);
        out.low.push(d.low[i]);
        out.close.push(d.close[i]);
        out.volume.push(d.volume[i] || 0);
      } else {
        if (d.high[i] > out.high[idx]) out.high[idx] = d.high[i];
        if (d.low[i] < out.low[idx]) out.low[idx] = d.low[i];
        out.close[idx] = d.close[i];
        out.volume[idx] += d.volume[i] || 0;
      }
      map[i] = idx;
    }
    out.n = out.time.length;
    return { d: out, map: map };
  }

  /* Stretch an indicator computed on coarser bars back over the chart's bars.
     A -1 marks a chart bar older than everything we hold for that timeframe —
     it becomes a gap rather than a phantom flat line. */
  function expandBack(a, map) {
    var out = new Array(map.length);
    for (var i = 0; i < map.length; i++) out[i] = map[i] < 0 ? NaN : a[map[i]];
    return out;
  }

  /* TradingView's Visibility tab: one row per interval unit, each with an
     enable checkbox and an inclusive from/to range. */
  function defaultVis() {
    var row = function (from, to) { return { on: true, from: from, to: to }; };
    return {
      sec: row(1, 59), min: row(1, 59), hour: row(1, 24), day: row(1, 31),
      week: row(1, 52), month: row(1, 12), range: row(1, 1)
    };
  }

  function parseInterval(iv) {
    var m = /^(\d+)\s*([smhdwM])$/.exec(String(iv || "").trim());
    if (!m) return null;
    var units = { s: "sec", m: "min", h: "hour", d: "day", w: "week", M: "month" };
    return { n: parseInt(m[1], 10), unit: units[m[2]] };
  }

  /* True when the indicator is allowed on the chart's current interval. */
  function intervalVisible(vis, iv) {
    if (!vis) return true;
    var p = parseInterval(iv);
    if (!p) return true;
    var row = vis[p.unit];
    if (!row || row.on === false) return false;
    return p.n >= (row.from == null ? 1 : row.from) && p.n <= (row.to == null ? 1e9 : row.to);
  }

  function D(o) {
    var f = {};
    o.forEach(function (kv) { f[kv[0]] = kv[1]; });
    return f;
  }

  /* ================================================ TradingView Style tab */
  /* Captured from TradingView's own indicator dialogs. Every Style tab is a
     two-column grid — a label cell holding the show/hide checkbox, then a
     control cell with a colour swatch, an optional plot-style dropdown and an
     optional value — closed by a big separator and the OUTPUT VALUES /
     INPUT VALUES sections. Row kinds:
       plot  label + checkbox │ swatch · plot style (or line style) · [value]
       fill  label + checkbox │ swatch [· second swatch]
       grp   full-width label + checkbox, then its `kid` rows
       kid   grouped label    │ swatch [· plot style]
       sep   group separator
     `p` indexes the study's plots, `pl` its price lines, `c`/`c2` the colour
     params (`cfb` a fallback key), `w` the width param, `ls` the line style,
     `ps` the plot style and `v`/`dv` an inline value such as a band level. */
  var PLOT_STYLES = [
    "Price line", "Line", "Line with breaks", "Step line", "Step line with breaks",
    "Step line with diamonds", "Histogram", "Cross", "Area", "Area with breaks",
    "Columns", "Circles"
  ];
  /* The colour popover's Line style radios, in TradingView's order; the values
     are Light Weight Charts' LineStyle numbers. */
  var LINE_STYLES = [{ v: 0, label: "Solid" }, { v: 2, label: "Dashed" }, { v: 1, label: "Dotted" }];
  var THICKNESS = [1, 2, 3, 4];
  /* TradingView's colour palette: two rows of neutrals and primaries, then six
     rows of tints and shades. */
  var TV_PALETTE = [
    ["#ffffff", "#dbdbdb", "#b8b8b8", "#9c9c9c", "#808080", "#636363", "#4a4a4a", "#2e2e2e", "#0f0f0f", "#000000"],
    ["#f23645", "#ff9800", "#ffeb3b", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#673ab7", "#9c27b0", "#e91e63"],
    ["#fccbcd", "#ffe0b2", "#fff9c4", "#c8e6c9", "#ace5dc", "#b2ebf2", "#bbd9fb", "#d1c4e9", "#e1bee7", "#f8bbd0"],
    ["#faa1a4", "#ffcc80", "#fff59d", "#a5d6a7", "#70ccbd", "#80deea", "#90bff9", "#b39ddb", "#ce93d8", "#f48fb1"],
    ["#f77c80", "#ffb74d", "#fff176", "#81c784", "#42bda8", "#4dd0e1", "#5b9cf6", "#9575cd", "#ba68c8", "#f06292"],
    ["#f7525f", "#ffa726", "#ffee58", "#66bb6a", "#22ab94", "#26c6da", "#3179f5", "#7e57c2", "#ab47bc", "#ec407a"],
    ["#b22833", "#f57c00", "#fbc02d", "#388e3c", "#056656", "#0097a7", "#1848cc", "#512da8", "#7b1fa2", "#c2185b"],
    ["#801922", "#e65100", "#f57f17", "#1b5e20", "#00332a", "#006064", "#0c3299", "#311b92", "#4a148c", "#880e4f"]
  ];
  function plotStyleKind(s) {
    if (s === "Histogram" || s === "Columns") return "hist";
    if (s === "Area" || s === "Area with breaks") return "area";
    return "line";
  }
  /* Parse "#rgb", "#rrggbb", "rgb()" and "rgba()" into {r,g,b,a}. */
  function parseCol(c) {
    var s = String(c || "").trim();
    if (!s) return null;
    if (s[0] === "#") {
      var h = s.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      if (!isNum(n)) return null;
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    var m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    var p = m[1].split(",");
    var a = p.length > 3 ? parseFloat(p[3]) : 1;
    return { r: +p[0], g: +p[1], b: +p[2], a: isNum(a) ? a : 1 };
  }
  function withAlpha(c, a) {
    var p = parseCol(c);
    if (!p) return c;
    a = Math.max(0, Math.min(1, a));
    if (a >= 1) {
      function h2(n) { var s = Math.round(n).toString(16); return s.length < 2 ? "0" + s : s; }
      return "#" + h2(p.r) + h2(p.g) + h2(p.b);
    }
    return "rgba(" + Math.round(p.r) + "," + Math.round(p.g) + "," + Math.round(p.b) + "," + Math.round(a * 100) / 100 + ")";
  }
  function alphaOf(c) { var p = parseCol(c); return p ? p.a : 1; }
  function colourOf(prm, key, fb) {
    if (!key) return null;
    if (prm[key] !== undefined && prm[key] !== "") return prm[key];
    if (fb && prm[fb]) return prm[fb];
    return null;
  }

  var SROWS = {
    sma: [{ k: "plot", lab: "MA", p: 0, c: "color", w: "width", ls: "l_color" }],
    ema: [{ k: "plot", lab: "EMA", p: 0, c: "color", w: "width", ls: "l_color" }],
    wma: [{ k: "plot", lab: "WMA", p: 0, c: "color", w: "width", ls: "l_color" }],
    hma: [{ k: "plot", lab: "HMA", p: 0, c: "color", w: "width", ls: "l_color" }],
    bb: [
      { k: "plot", lab: "Basis", p: 0, c: "color", w: "width", ls: "l_color" },
      { k: "plot", lab: "Upper", p: 1, c: "colorUp", cfb: "color2", w: "widthUp", lw: 1, ls: "l_up", lsd: 2 },
      { k: "plot", lab: "Lower", p: 2, c: "colorLo", cfb: "color2", w: "widthLo", lw: 1, ls: "l_lo", lsd: 2 },
      { k: "fill", lab: "Background", c: "bgc", d: "rgba(96,165,250,0.14)" }
    ],
    keltner: [
      { k: "plot", lab: "Upper", p: 1, c: "colorUp", cfb: "color", w: "widthUp", lw: 1, ls: "l_up", lsd: 2 },
      { k: "plot", lab: "Basis", p: 0, c: "color", w: "width", ls: "l_color" },
      { k: "plot", lab: "Lower", p: 2, c: "colorLo", cfb: "color", w: "widthLo", lw: 1, ls: "l_lo", lsd: 2 },
      { k: "fill", lab: "Background", c: "bgc", d: "rgba(20,184,166,0.14)" }
    ],
    donchian: [
      { k: "plot", lab: "Basis", p: 2, c: "color", w: "width", ls: "l_color" },
      { k: "plot", lab: "Upper", p: 0, c: "colorUp", cfb: "color", w: "widthUp", lw: 1, ls: "l_up", lsd: 2 },
      { k: "plot", lab: "Lower", p: 1, c: "colorLo", cfb: "color", w: "widthLo", lw: 1, ls: "l_lo", lsd: 2 },
      { k: "fill", lab: "Background", c: "bgc", d: "rgba(244,114,182,0.14)" }
    ],
    vwap: [
      { k: "plot", lab: "VWAP", p: 0, c: "color", w: "width", ls: "l_color" },
      { k: "plot", lab: "Upper Band #1", c: "colorUp", cfb: "color", w: "widthUp", lw: 1, ls: "l_up", lsd: 2 },
      { k: "plot", lab: "Lower Band #1", c: "colorLo", cfb: "color", w: "widthLo", lw: 1, ls: "l_lo", lsd: 2 },
      { k: "fill", lab: "Bands Fill #1", c: "bgc", d: "rgba(167,139,250,0.14)" }
    ],
    supertrend: [
      { k: "plot", lab: "Up Trend", p: 0, c: "color", w: "width", ls: "l_color" },
      { k: "plot", lab: "Down Trend", p: 1, c: "color2", w: "width", ls: "l_color2" },
      { k: "plot", lab: "Body Middle", c: "colorMid", cfb: "color2", w: "widthMid", lw: 1, ls: "l_mid" },
      { k: "fill", lab: "Uptrend background", c: "bgc", d: "rgba(34,197,94,0.14)" },
      { k: "fill", lab: "Downtrend background", c: "bgc2", d: "rgba(239,68,68,0.14)" }
    ],
    psar: [{ k: "plot", lab: "ParabolicSAR", c: "color", markers: true, ps: "ps_color" }],
    ichimoku: [
      { k: "plot", lab: "Conversion Line", p: 0, c: "color", w: "width", ls: "l_color" },
      { k: "plot", lab: "Base Line", p: 1, c: "color2", w: "width", ls: "l_color2" },
      { k: "plot", lab: "Lagging Span", p: 4, c: "colorCh", d: "#a78bfa", w: "width", ls: "l_ch" },
      { k: "plot", lab: "Leading Span A", p: 2, c: "color3", w: "width", ls: "l_color3" },
      { k: "plot", lab: "Leading Span B", p: 3, c: "colorLo", cfb: "color3", w: "width", ls: "l_lo", lsd: 2 },
      { k: "plot", lab: "Kumo Cloud Upper Line", c: "colorKu", cfb: "color3", w: "width", ls: "l_ku" },
      { k: "plot", lab: "Kumo Cloud Lower Line", c: "colorKl", cfb: "color3", w: "width", ls: "l_kl" },
      { k: "grp", lab: "Cloud Fill" },
      { k: "kid", lab: "Color 0", c: "bgc", d: "rgba(34,197,94,0.14)" },
      { k: "kid", lab: "Color 1", c: "bgc2", d: "rgba(239,68,68,0.14)" }
    ],
    alligator: [
      { k: "plot", lab: "Jaw", p: 2, c: "color3", w: "width", ls: "l_color3" },
      { k: "plot", lab: "Teeth", p: 1, c: "color2", w: "width", ls: "l_color2" },
      { k: "plot", lab: "Lips", p: 0, c: "color", w: "width", ls: "l_color" }
    ],
    rsi: [
      { k: "plot", lab: "RSI", p: 0, c: "color", w: "width", ls: "l_color" },
      { k: "plot", lab: "RSI-based MA", p: 1, c: "colorMA", d: "#2962ff", w: "widthMA", lw: 1, ls: "l_ma", onOff: true },
      { k: "plot", lab: "RSI Upper Band", pl: 0, c: "bandU", d: "#ef4444", w: "widthBand", lw: 1, ls: "l_bu", v: "ob", dv: 70 },
      { k: "plot", lab: "RSI Middle Band", pl: 1, c: "bandM", d: "#3a4c61", w: "widthBand", lw: 1, ls: "l_bm", v: "mid", dv: 50 },
      { k: "plot", lab: "RSI Lower Band", pl: 2, c: "bandL", d: "#22c55e", w: "widthBand", lw: 1, ls: "l_bl", v: "os", dv: 30 },
      /* Read off TradingView's own canvas: #7E57C2 at 10% over #0f0f0f lands on
         exactly the (26,22,33) the widget paints between 30 and 70. */
      { k: "fill", lab: "RSI Background Fill", p: 2, c: "bgc", d: "rgba(126,87,194,0.1)" },
      { k: "fill", lab: "Overbought Gradient Fill", p: 3, onOff: true, c: "bgcUp", d: "rgba(242,54,69,0.22)", c2: "bgcUp2", d2: "rgba(242,54,69,0.02)" },
      { k: "fill", lab: "Oversold Gradient Fill", p: 4, onOff: true, c: "bgcDn", d: "rgba(8,153,129,0.02)", c2: "bgcDn2", d2: "rgba(8,153,129,0.22)" }
    ],
    macd: [
      { k: "grp", lab: "Histogram", p: 2, ps: "ps_hist", dps: "Histogram" },
      { k: "kid", lab: "Color 0", c: "histUp", ps: "ps_hist", dps: "Histogram" },
      { k: "kid", lab: "Color 1", c: "histUpFade" },
      { k: "kid", lab: "Color 2", c: "histDnFade" },
      { k: "kid", lab: "Color 3", c: "histDn" },
      { k: "sep" },
      { k: "plot", lab: "MACD", p: 0, c: "color", w: "width", ls: "l_color" },
      { k: "plot", lab: "Signal line", p: 1, c: "color2", w: "width2", ls: "l_color2" },
      { k: "plot", lab: "Zero", pl: 0, c: "zero", w: "widthZero", lw: 1, ls: "l_zero" }
    ],
    stoch: [
      { k: "plot", lab: "%K", p: 0, c: "color", w: "widthK", lw: 2, ls: "l_color" },
      { k: "plot", lab: "%D", p: 1, c: "color2", w: "widthD", lw: 1, ls: "l_color2" },
      { k: "plot", lab: "Upper Band", pl: 0, c: "bandU", d: "#ef4444", w: "widthBand", lw: 1, ls: "l_bu", v: "u", dv: 80 },
      { k: "plot", lab: "Middle Band", pl: 1, c: "bandM", d: "#3a4c61", w: "widthBand", lw: 1, ls: "l_bm", v: "m", dv: 50 },
      { k: "plot", lab: "Lower Band", pl: 2, c: "bandL", d: "#22c55e", w: "widthBand", lw: 1, ls: "l_bl", v: "l", dv: 20 },
      { k: "fill", lab: "Background", p: 2, c: "bgc", d: "rgba(25,150,250,0.1)" }
    ],
    stochrsi: [
      { k: "plot", lab: "K", p: 0, c: "color", w: "widthK", lw: 2, ls: "l_color" },
      { k: "plot", lab: "D", p: 1, c: "color2", w: "widthD", lw: 1, ls: "l_color2" },
      { k: "plot", lab: "Upper Band", pl: 0, c: "bandU", d: "#ef4444", w: "widthBand", lw: 1, ls: "l_bu", v: "u", dv: 80 },
      { k: "plot", lab: "Middle Band", pl: 1, c: "bandM", d: "#3a4c61", w: "widthBand", lw: 1, ls: "l_bm", v: "m", dv: 50 },
      { k: "plot", lab: "Lower Band", pl: 2, c: "bandL", d: "#22c55e", w: "widthBand", lw: 1, ls: "l_bl", v: "l", dv: 20 },
      { k: "fill", lab: "Background", p: 2, c: "bgc", d: "rgba(25,150,250,0.1)" }
    ],
    mfi: [
      { k: "plot", lab: "MF", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" },
      { k: "plot", lab: "Overbought", pl: 0, c: "bandU", d: "#ef4444", w: "widthBand", lw: 1, ls: "l_bu", v: "u", dv: 80 },
      { k: "plot", lab: "Middle Band", pl: 1, c: "bandM", d: "#3a4c61", w: "widthBand", lw: 1, ls: "l_bm", v: "m", dv: 50 },
      { k: "plot", lab: "Oversold", pl: 2, c: "bandL", d: "#22c55e", w: "widthBand", lw: 1, ls: "l_bl", v: "l", dv: 20 },
      { k: "fill", lab: "Background", p: 1, c: "bgc", d: "rgba(25,150,250,0.1)" }
    ],
    cci: [
      { k: "plot", lab: "CCI", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" },
      { k: "plot", lab: "CCI-based MA", p: 1, c: "colorMA", d: "#2962ff", w: "widthMA", lw: 1, ls: "l_ma", onOff: true },
      { k: "plot", lab: "Upper Band", pl: 0, c: "bandU", d: "#ef4444", w: "widthBand", lw: 1, ls: "l_bu", v: "u", dv: 100 },
      { k: "plot", lab: "Middle Band", pl: 1, c: "bandM", d: "#3a4c61", w: "widthBand", lw: 1, ls: "l_bm", v: "m", dv: 0 },
      { k: "plot", lab: "Lower Band", pl: 2, c: "bandL", d: "#22c55e", w: "widthBand", lw: 1, ls: "l_bl", v: "l", dv: -100 },
      { k: "fill", lab: "Background", p: 2, c: "bgc", d: "rgba(25,150,250,0.1)" }
    ],
    willr: [
      { k: "plot", lab: "%R", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" },
      { k: "plot", lab: "Upper Band", pl: 0, c: "bandU", d: "#ef4444", w: "widthBand", lw: 1, ls: "l_bu", v: "u", dv: -20 },
      { k: "plot", lab: "Middle Level", pl: 1, c: "bandM", d: "#3a4c61", w: "widthBand", lw: 1, ls: "l_bm", v: "m", dv: -50 },
      { k: "plot", lab: "Lower Band", pl: 2, c: "bandL", d: "#22c55e", w: "widthBand", lw: 1, ls: "l_bl", v: "l", dv: -80 },
      { k: "fill", lab: "Background", p: 1, c: "bgc", d: "rgba(25,150,250,0.1)" }
    ],
    roc: [
      { k: "plot", lab: "ROC", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" },
      { k: "plot", lab: "Zero Line", pl: 0, c: "zeroC", d: "#3a4c61", w: "widthBand", lw: 1, ls: "l_zero", v: "z", dv: 0 }
    ],
    mom: [{ k: "plot", lab: "MOM", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" }],
    ao: [
      { k: "grp", lab: "AO", p: 0, ps: "ps_hist", dps: "Histogram" },
      { k: "kid", lab: "Color 0", c: "color", ps: "ps_hist", dps: "Histogram" },
      { k: "kid", lab: "Color 1", c: "color2" }
    ],
    atr: [{ k: "plot", lab: "ATR", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" }],
    adx: [{ k: "plot", lab: "ADX", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" }],
    stddev: [{ k: "plot", lab: "StdDev", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" }],
    volume: [
      { k: "grp", lab: "Volume", p: 0, ps: "ps_hist", dps: "Histogram" },
      { k: "kid", lab: "Growing", c: "color", ps: "ps_hist", dps: "Histogram" },
      { k: "kid", lab: "Falling", c: "color2" },
      { k: "sep" },
      { k: "plot", lab: "Volume MA", p: 1, c: "colorMa", d: "#60a5fa", w: "widthMa", lw: 1, ls: "l_ma" }
    ],
    obv: [{ k: "plot", lab: "OnBalanceVolume", p: 0, c: "color", w: "width", lw: 2, ls: "l_color" }]
  };

  function colourSeed(s, key, dflt, fb) {
    if (!key || s.defaults[key] !== undefined) return;
    if (dflt !== undefined) s.defaults[key] = dflt;
    else if (fb && s.defaults[fb] !== undefined) s.defaults[key] = s.defaults[fb];
  }
  /* Give a study every param its Style tab needs, so old layouts saved before
     a row existed still render and edit cleanly. */
  function seedStyle(s) {
    s.srows.forEach(function (r, i) {
      if (r.k === "plot" || r.k === "fill" || r.k === "grp") {
        r.on = "sh" + i;
        if (s.defaults[r.on] === undefined) s.defaults[r.on] = !r.onOff;
      }
      /* Plot rows carry a TradingView plot-style dropdown; price-line rows
         carry a line style instead, which lives on their `ls` key. */
      if (r.k === "plot" && r.pl == null && !r.ps) {
        r.ps = "ps_" + String(r.c || r.lab).replace(/\W+/g, "");
      }
      colourSeed(s, r.c, r.d, r.cfb);
      colourSeed(s, r.c2, r.d2, r.c2fb);
      if (r.w && s.defaults[r.w] === undefined) s.defaults[r.w] = r.lw != null ? r.lw : 2;
      if (r.ls && s.defaults[r.ls] === undefined) s.defaults[r.ls] = r.lsd != null ? r.lsd : 0;
      if (r.ps && s.defaults[r.ps] === undefined) s.defaults[r.ps] = r.dps || "Line";
      if (r.v && s.defaults[r.v] === undefined) s.defaults[r.v] = r.dv;
    });
    if (s.defaults.precision === undefined) s.defaults.precision = "";
    if (s.defaults.lblScale === undefined) s.defaults.lblScale = true;
    if (s.defaults.lblStatus === undefined) s.defaults.lblStatus = true;
    if (s.defaults.inpStatus === undefined) s.defaults.inpStatus = true;
  }

  var STUDIES = [];
  /* Declared here rather than next to its first read so a study defined after
     start-up — a Pine script the user just wrote — registers the same way the
     built-ins do. */
  var STUDY_MAP = {};
  function defStudy(s) {
    /* Every indicator carries a TradingView Visibility tab; new studies get it
       for free, and instances saved before it existed pick it up on load. */
    if (!s.defaults.vis) s.defaults.vis = defaultVis();
    if (SROWS[s.id]) s.srows = SROWS[s.id];
    if (s.srows) seedStyle(s);
    /* Re-defining an id replaces it in place: a Pine script re-saved under the
       same id has to take over from the version already on the chart. */
    var prev = STUDY_MAP[s.id];
    if (prev) {
      var at = STUDIES.indexOf(prev);
      if (at >= 0) STUDIES[at] = s; else STUDIES.push(s);
    } else {
      STUDIES.push(s);
    }
    STUDY_MAP[s.id] = s;
    return s;
  }

  /* ---------------------------------------------------------- overlays */
  defStudy({
    id: "sma", name: "Moving Average (SMA)", short: "SMA", group: "Trend", kind: "overlay",
    defaults: D([["period", 20], ["source", "close"], ["color", "#2962ff"], ["width", 2]]),
    fields: [fPeriod(20), fSource(), fColor("color", "Colour", "#2962ff"), fWidth()],
    build: function (d, p) {
      return { plots: [{ type: "line", color: p.color, width: p.width, data: zip(d, smaArr(srcArr(d, p.source), p.period)) }] };
    }
  });

  defStudy({
    id: "ema", name: "Exponential MA (EMA)", short: "EMA", group: "Trend", kind: "overlay",
    defaults: D([["period", 20], ["source", "close"], ["color", "#ff9800"], ["width", 2]]),
    fields: [fPeriod(20), fSource(), fColor("color", "Colour", "#ff9800"), fWidth()],
    build: function (d, p) {
      return { plots: [{ type: "line", color: p.color, width: p.width, data: zip(d, emaArr(srcArr(d, p.source), p.period)) }] };
    }
  });

  defStudy({
    id: "wma", name: "Weighted MA (WMA)", short: "WMA", group: "Trend", kind: "overlay",
    defaults: D([["period", 30], ["source", "close"], ["color", "#4caf50"], ["width", 2]]),
    fields: [fPeriod(30), fSource(), fColor("color", "Colour", "#4caf50"), fWidth()],
    build: function (d, p) {
      return { plots: [{ type: "line", color: p.color, width: p.width, data: zip(d, wmaArr(srcArr(d, p.source), p.period)) }] };
    }
  });

  defStudy({
    id: "hma", name: "Hull MA (HMA)", short: "HMA", group: "Trend", kind: "overlay",
    defaults: D([["period", 34], ["source", "close"], ["color", "#a78bfa"], ["width", 2]]),
    fields: [fPeriod(34), fSource(), fColor("color", "Colour", "#a78bfa"), fWidth()],
    build: function (d, p) {
      return { plots: [{ type: "line", color: p.color, width: p.width, data: zip(d, hmaArr(srcArr(d, p.source), p.period)) }] };
    }
  });

  defStudy({
    id: "bb", name: "Bollinger Bands", short: "BB", group: "Trend", kind: "overlay",
    defaults: D([["period", 20], ["mult", 2], ["source", "close"], ["color", "#3b82f6"], ["color2", "#60a5fa"], ["width", 2]]),
    fields: [fPeriod(20), F("mult", "Std deviation", "number", { min: 0.5, max: 6, step: 0.1, dflt: 2 }),
      fSource(), fColor("color", "Basis", "#3b82f6"), fColor("color2", "Bands", "#60a5fa"), fWidth()],
    build: function (d, p) {
      var a = srcArr(d, p.source);
      var mid = smaArr(a, p.period), sd = sdArr(a, p.period);
      var up = new Array(d.n), lo = new Array(d.n);
      for (var i = 0; i < d.n; i++) {
        up[i] = isNum(mid[i]) ? mid[i] + p.mult * sd[i] : NaN;
        lo[i] = isNum(mid[i]) ? mid[i] - p.mult * sd[i] : NaN;
      }
      return {
        plots: [
          { type: "line", color: p.color, width: p.width, data: zip(d, mid) },
          { type: "line", color: p.color2, width: Math.max(1, p.width - 1), lineStyle: 2, data: zip(d, up) },
          { type: "line", color: p.color2, width: Math.max(1, p.width - 1), lineStyle: 2, data: zip(d, lo) }
        ]
      };
    }
  });

  defStudy({
    id: "keltner", name: "Keltner Channel", short: "KC", group: "Volatility", kind: "overlay",
    defaults: D([["period", 20], ["mult", 2], ["source", "close"], ["color", "#14b8a6"], ["width", 2]]),
    fields: [fPeriod(20), F("mult", "ATR multiplier", "number", { min: 0.5, max: 6, step: 0.1, dflt: 2 }),
      fSource(), fColor("color", "Colour", "#14b8a6"), fWidth()],
    build: function (d, p) {
      var mid = emaArr(srcArr(d, p.source), p.period), a = atrArr(d, 10);
      var up = new Array(d.n), lo = new Array(d.n);
      for (var i = 0; i < d.n; i++) {
        up[i] = isNum(mid[i]) && isNum(a[i]) ? mid[i] + p.mult * a[i] : NaN;
        lo[i] = isNum(mid[i]) && isNum(a[i]) ? mid[i] - p.mult * a[i] : NaN;
      }
      return {
        plots: [
          { type: "line", color: p.color, width: p.width, data: zip(d, mid) },
          { type: "line", color: p.color, width: Math.max(1, p.width - 1), lineStyle: 2, data: zip(d, up) },
          { type: "line", color: p.color, width: Math.max(1, p.width - 1), lineStyle: 2, data: zip(d, lo) }
        ]
      };
    }
  });

  defStudy({
    id: "donchian", name: "Donchian Channel", short: "DC", group: "Volatility", kind: "overlay",
    defaults: D([["period", 20], ["color", "#f472b6"], ["width", 2]]),
    fields: [fPeriod(20), fColor("color", "Colour", "#f472b6"), fWidth()],
    build: function (d, p) {
      var w = hhll(d, p.period);
      var mid = smaArr(d.close, p.period);
      return {
        plots: [
          { type: "line", color: p.color, width: Math.max(1, p.width - 1), lineStyle: 2, data: zip(d, w.hh) },
          { type: "line", color: p.color, width: Math.max(1, p.width - 1), lineStyle: 2, data: zip(d, w.ll) },
          { type: "line", color: p.color, width: p.width, data: zip(d, mid) }
        ]
      };
    }
  });

  defStudy({
    id: "vwap", name: "VWAP (session)", short: "VWAP", group: "Trend", kind: "overlay",
    defaults: D([["color", "#a78bfa"], ["width", 2]]),
    fields: [fColor("color", "Colour", "#a78bfa"), fWidth()],
    build: function (d, p) {
      return { plots: [{ type: "line", color: p.color, width: p.width, data: zip(d, vwapArr(d)) }] };
    }
  });

  defStudy({
    id: "supertrend", name: "Supertrend", short: "ST", group: "Trend", kind: "overlay",
    defaults: D([["period", 10], ["mult", 3], ["color", "#22c55e"], ["color2", "#ef4444"], ["width", 2]]),
    fields: [fPeriod(10), F("mult", "ATR multiplier", "number", { min: 0.5, max: 8, step: 0.5, dflt: 3 }),
      fColor("color", "Up trend", "#22c55e"), fColor("color2", "Down trend", "#ef4444"), fWidth()],
    build: function (d, p) {
      var st = supertrendArr(d, p.period, p.mult);
      return {
        plots: [
          { type: "line", color: p.color, width: p.width, data: zipPick(d, st.line, function (i) { return st.dir[i] === 1; }) },
          { type: "line", color: p.color2, width: p.width, data: zipPick(d, st.line, function (i) { return st.dir[i] === -1; }) }
        ]
      };
    }
  });

  defStudy({
    id: "psar", name: "Parabolic SAR", short: "PSAR", group: "Trend", kind: "overlay",
    defaults: D([["step", 0.02], ["max", 0.2], ["color", "#f59e0b"]]),
    fields: [F("step", "Step", "number", { min: 0.005, max: 0.1, step: 0.005, dflt: 0.02 }),
      F("max", "Max step", "number", { min: 0.05, max: 0.5, step: 0.01, dflt: 0.2 }),
      fColor("color", "Colour", "#f59e0b")],
    markers: true,
    build: function (d, p) {
      var s = sarArr(d, p.step, p.max), marks = [];
      var prevLong = null;
      for (var i = 1; i < d.n; i++) {
        if (!isNum(s[i])) continue;
        var long = d.close[i] >= s[i];
        if (prevLong === null || long !== prevLong) {
          marks.push({ time: d.time[i], position: long ? "belowBar" : "aboveBar", color: p.color, shape: "circle" });
        }
        prevLong = long;
      }
      return { plots: [], markers: marks };
    }
  });

  defStudy({
    id: "ichimoku", name: "Ichimoku Cloud", short: "ICH", group: "Trend", kind: "overlay",
    defaults: D([["color", "#ef4444"], ["color2", "#3b82f6"], ["color3", "#22c55e"], ["width", 1]]),
    fields: [fColor("color", "Tenkan", "#ef4444"), fColor("color2", "Kijun", "#3b82f6"),
      fColor("color3", "Cloud", "#22c55e"), fWidth()],
    build: function (d, p) {
      var k = ichimokuArr(d);
      return {
        plots: [
          { type: "line", color: p.color, width: p.width, data: zip(d, k.tenkan) },
          { type: "line", color: p.color2, width: p.width, data: zip(d, k.kijun) },
          { type: "line", color: p.color3, width: p.width, data: zip(d, k.spanA) },
          { type: "line", color: p.color3, width: p.width, lineStyle: 2, data: zip(d, k.spanB) },
          { type: "line", color: "#a78bfa", width: p.width, data: zip(d, k.chikou) }
        ]
      };
    }
  });

  defStudy({
    id: "alligator", name: "Alligator (Bill Williams)", short: "ALL", group: "Bill Williams", kind: "overlay",
    defaults: D([["color", "#22d3ee"], ["color2", "#ef4444"], ["color3", "#22c55e"], ["width", 1]]),
    fields: [fColor("color", "Lips (5)", "#22d3ee"), fColor("color2", "Teeth (8)", "#ef4444"),
      fColor("color3", "Jaw (13)", "#22c55e"), fWidth()],
    build: function (d, p) {
      var hl2 = srcArr(d, "hl2");
      var lips = shift(emaK(hl2, 5, 1 / 5), 3);
      var teeth = shift(emaK(hl2, 8, 1 / 8), 5);
      var jaw = shift(emaK(hl2, 13, 1 / 13), 8);
      return {
        plots: [
          { type: "line", color: p.color, width: p.width, data: zip(d, lips) },
          { type: "line", color: p.color2, width: p.width, data: zip(d, teeth) },
          { type: "line", color: p.color3, width: p.width, data: zip(d, jaw) }
        ]
      };
    }
  });

  /* ------------------------------------------------------ pane studies */
  defStudy({
    id: "rsi", name: "Relative Strength Index", short: "RSI", group: "Oscillators", kind: "pane",
    defaults: D([["period", 14], ["color", "#a78bfa"], ["width", 2], ["paneHeight", 130],
      ["ob", 70], ["mid", 50], ["os", 30]]),
    fields: [fPeriod(14), fColor("color", "Colour", "#a78bfa"), fWidth(), fHeight()],
    build: function (d, p) {
      var v = rsiArr(d.close, p.period);
      var lo = isNum(p.os) ? p.os : 30, hi = isNum(p.ob) ? p.ob : 70;
      /* TradingView fits the RSI pane to the plotted values (a 12–87 window on
         a typical series), and leaves both gradient fills switched off. When
         they are switched on they run to the edge of the *plotted* range, not
         to 0/100, so turning them on never rescales the pane. */
      var vMax = -Infinity, vMin = Infinity;
      for (var i = 0; i < d.n; i++) {
        if (isNum(v[i])) { if (v[i] > vMax) vMax = v[i]; if (v[i] < vMin) vMin = v[i]; }
      }
      if (!isNum(vMax)) { vMax = hi; vMin = lo; }
      return {
        plots: [
          { type: "line", color: p.color, width: p.width, data: zip(d, v) },
          { type: "line", color: p.colorMA || "#2962ff", width: p.widthMA || 1, data: zip(d, smaArr(v, 14)) },
          bandFill(d, lo, hi, p.bgc, p.bgc2),
          bandFill(d, hi, vMax > hi ? vMax : NaN, p.bgcUp, p.bgcUp2),
          bandFill(d, vMin < lo ? vMin : NaN, lo, p.bgcDn, p.bgcDn2)
        ],
        priceLines: [{ price: hi, color: "#ef4444" }, { price: p.mid, color: "#3a4c61" }, { price: lo, color: "#22c55e" }]
      };
    }
  });

  defStudy({
    id: "macd", name: "MACD", short: "MACD", group: "Oscillators", kind: "pane",
    defaults: D([
      ["source", "close"], ["fast", 12], ["slow", 26], ["signal", 9],
      ["oscMa", "EMA"], ["sigMa", "EMA"], ["tf", "Chart"], ["waitClose", false],
      /* TradingView's built-in MACD: #2962FF line, #FF6D00 signal, and a
         four-way histogram (dark/fade green above zero, dark/fade red below). */
      ["color", "#2962ff"], ["color2", "#ff6d00"], ["width", 2], ["width2", 1],
      ["histUp", "#26a69a"], ["histUpFade", "#b2dfdb"],
      ["histDn", "#ff5252"], ["histDnFade", "#ffcdd2"],
      ["zero", "rgba(120,123,134,0.5)"], ["paneHeight", 150]
    ]),
    labelKeys: ["fast", "slow", "signal"], labelSource: true,
    fields: [
      fSource(),
      F("fast", "Fast length", "number", { min: 2, max: 200, dflt: 12 }),
      F("slow", "Slow length", "number", { min: 3, max: 400, dflt: 26 }),
      F("signal", "Signal length", "number", { min: 1, max: 100, dflt: 9 }),
      fMa("oscMa", "Oscillator MA type", "EMA"),
      fMa("sigMa", "Signal MA type", "EMA"),
      fSection("CALCULATION", "inputs"),
      fTf("tf", "Timeframe"),
      fCheck("waitClose", "Wait for timeframe closes", false),
      fSection("HISTOGRAM", "style"),
      fColor("histUp", "Rising above zero", "#26a69a"),
      fColor("histUpFade", "Falling above zero", "#b2dfdb"),
      fColor("histDn", "Falling below zero", "#ff5252"),
      fColor("histDnFade", "Rising below zero", "#ffcdd2"),
      fSection("LINES", "style"),
      fColor("color", "MACD line", "#2962ff"),
      fColor("color2", "Signal line", "#ff6d00"),
      fColor("zero", "Zero line", "rgba(120,123,134,0.5)"),
      fWidth("MACD width", "width"), fWidth("Signal width", "width2"), fHeight()
    ],
    build: function (d, p, inj) {
      var calc = d, map = null;
      var tf = (p.tf && p.tf !== "Chart") ? p.tf : null;
      /* `inj` is this indicator's own fetched history (offTfBars) — use it when
         we have it, otherwise derive the coarser bars from the chart's own. */
      if (inj && inj.calc && inj.calc.n && inj.map) { calc = inj.calc; map = inj.map; }
      else if (tf) { var rs = resample(d, tf); if (rs) { calc = rs.d; map = rs.map; } }
      var src = srcArr(calc, p.source || "close");
      var fast = maBy(src, p.fast, p.oscMa);
      var slow = maBy(src, p.slow, p.oscMa);
      var m = new Array(calc.n), i;
      for (i = 0; i < calc.n; i++) m[i] = (isNum(fast[i]) && isNum(slow[i])) ? fast[i] - slow[i] : NaN;
      var sig = maBy(m, p.signal, p.sigMa);
      var hist = new Array(calc.n);
      for (i = 0; i < calc.n; i++) hist[i] = (isNum(m[i]) && isNum(sig[i])) ? m[i] - sig[i] : NaN;
      if (map) { m = expandBack(m, map); sig = expandBack(sig, map); hist = expandBack(hist, map); }
      return {
        plots: [
          { type: "line", color: p.color, width: p.width || 2, data: zip(d, m) },
          { type: "line", color: p.color2, width: p.width2 || 1, data: zip(d, sig) },
          { type: "hist", data: zipColor4(d, hist, p.histUp || "#26a69a", p.histUpFade || "#b2dfdb",
            p.histDnFade || "#ffcdd2", p.histDn || "#ff5252") }
        ],
        priceLines: [{ price: 0, color: p.zero || "rgba(120,123,134,0.5)" }]
      };
    }
  });

  defStudy({
    id: "stoch", name: "Stochastic", short: "STOCH", group: "Oscillators", kind: "pane",
    defaults: D([["period", 14], ["smooth", 3], ["color", "#3b82f6"], ["color2", "#f59e0b"], ["paneHeight", 120]]),
    fields: [fPeriod(14), F("smooth", "Smoothing", "number", { min: 1, max: 50, dflt: 3 }),
      fColor("color", "%K", "#3b82f6"), fColor("color2", "%D", "#f59e0b"), fHeight()],
    build: function (d, p) {
      var k = stochRaw(d, p.period);
      var ds = smaArr(k, p.smooth);
      var lo = isNum(p.l) ? p.l : 20, hi = isNum(p.u) ? p.u : 80;
      return {
        plots: [
          { type: "line", color: p.color, width: 2, data: zip(d, k) },
          { type: "line", color: p.color2, width: 1, data: zip(d, ds) },
          bandFill(d, lo, hi, p.bgc, p.bgc2)
        ],
        priceLines: [{ price: hi, color: "#ef4444" }, { price: p.m, color: "#3a4c61" }, { price: lo, color: "#22c55e" }]
      };
    }
  });

  defStudy({
    id: "stochrsi", name: "Stochastic RSI", short: "STOCHRSI", group: "Oscillators", kind: "pane",
    defaults: D([["rsiLen", 14], ["stochLen", 14], ["smooth", 3], ["color", "#22d3ee"], ["color2", "#f59e0b"], ["paneHeight", 120]]),
    fields: [F("rsiLen", "RSI length", "number", { min: 2, max: 200, dflt: 14 }),
      F("stochLen", "Stoch length", "number", { min: 2, max: 200, dflt: 14 }),
      F("smooth", "Smoothing", "number", { min: 1, max: 50, dflt: 3 }),
      fColor("color", "%K", "#22d3ee"), fColor("color2", "%D", "#f59e0b"), fHeight()],
    build: function (d, p) {
      var r = rsiArr(d.close, p.rsiLen);
      var fake = { time: d.time, n: d.n, high: r, low: r, close: r, volume: d.volume, open: r };
      var k = stochRaw(fake, p.stochLen);
      var ds = smaArr(k, p.smooth);
      var lo = isNum(p.l) ? p.l : 20, hi = isNum(p.u) ? p.u : 80;
      return {
        plots: [
          { type: "line", color: p.color, width: 2, data: zip(d, k) },
          { type: "line", color: p.color2, width: 1, data: zip(d, ds) },
          bandFill(d, lo, hi, p.bgc, p.bgc2)
        ],
        priceLines: [{ price: hi, color: "#ef4444" }, { price: p.m, color: "#3a4c61" }, { price: lo, color: "#22c55e" }]
      };
    }
  });

  defStudy({
    id: "mfi", name: "Money Flow Index", short: "MFI", group: "Oscillators", kind: "pane",
    defaults: D([["period", 14], ["color", "#14b8a6"], ["paneHeight", 120]]),
    fields: [fPeriod(14), fColor("color", "Colour", "#14b8a6"), fHeight()],
    build: function (d, p) {
      var lo = isNum(p.l) ? p.l : 20, hi = isNum(p.u) ? p.u : 80;
      return {
        plots: [
          { type: "line", color: p.color, width: 2, data: zip(d, mfiArr(d, p.period)) },
          bandFill(d, lo, hi, p.bgc, p.bgc2)
        ],
        priceLines: [{ price: hi, color: "#ef4444" }, { price: p.m, color: "#3a4c61" }, { price: lo, color: "#22c55e" }]
      };
    }
  });

  defStudy({
    id: "cci", name: "Commodity Channel Index", short: "CCI", group: "Oscillators", kind: "pane",
    defaults: D([["period", 20], ["color", "#f59e0b"], ["paneHeight", 120]]),
    fields: [fPeriod(20), fColor("color", "Colour", "#f59e0b"), fHeight()],
    build: function (d, p) {
      var v = cciArr(d, p.period);
      var lo = isNum(p.l) ? p.l : -100, hi = isNum(p.u) ? p.u : 100;
      return {
        plots: [
          { type: "line", color: p.color, width: 2, data: zip(d, v) },
          { type: "line", color: p.colorMA || "#2962ff", width: p.widthMA || 1, data: zip(d, smaArr(v, p.period)) },
          bandFill(d, lo, hi, p.bgc, p.bgc2)
        ],
        priceLines: [{ price: hi, color: "#ef4444" }, { price: p.m, color: "#3a4c61" }, { price: lo, color: "#22c55e" }]
      };
    }
  });

  defStudy({
    id: "willr", name: "Williams %R", short: "W%R", group: "Oscillators", kind: "pane",
    defaults: D([["period", 14], ["color", "#f472b6"], ["paneHeight", 110]]),
    fields: [fPeriod(14), fColor("color", "Colour", "#f472b6"), fHeight()],
    build: function (d, p) {
      var lo = isNum(p.l) ? p.l : -80, hi = isNum(p.u) ? p.u : -20;
      return {
        plots: [
          { type: "line", color: p.color, width: 2, data: zip(d, willrArr(d, p.period)) },
          bandFill(d, lo, hi, p.bgc, p.bgc2)
        ],
        priceLines: [{ price: hi, color: "#ef4444" }, { price: p.m, color: "#3a4c61" }, { price: lo, color: "#22c55e" }]
      };
    }
  });

  defStudy({
    id: "roc", name: "Rate of Change", short: "ROC", group: "Oscillators", kind: "pane",
    defaults: D([["period", 12], ["color", "#60a5fa"], ["paneHeight", 110]]),
    fields: [fPeriod(12), fColor("color", "Colour", "#60a5fa"), fHeight()],
    build: function (d, p) {
      return {
        plots: [{ type: "line", color: p.color, width: 2, data: zip(d, rocArr(d.close, p.period)) }],
        priceLines: [{ price: 0, color: "#3a4c61" }]
      };
    }
  });

  defStudy({
    id: "mom", name: "Momentum", short: "MOM", group: "Oscillators", kind: "pane",
    defaults: D([["period", 10], ["color", "#a3e635"], ["paneHeight", 110]]),
    fields: [fPeriod(10), fColor("color", "Colour", "#a3e635"), fHeight()],
    build: function (d, p) {
      return {
        plots: [{ type: "line", color: p.color, width: 2, data: zip(d, momArr(d.close, p.period)) }],
        priceLines: [{ price: 0, color: "#3a4c61" }]
      };
    }
  });

  defStudy({
    id: "ao", name: "Awesome Oscillator", short: "AO", group: "Bill Williams", kind: "pane",
    defaults: D([["fast", 5], ["slow", 34], ["color", "#22c55e"], ["color2", "#ef4444"], ["paneHeight", 120]]),
    fields: [F("fast", "Fast period", "number", { min: 2, max: 200, dflt: 5 }),
      F("slow", "Slow period", "number", { min: 5, max: 400, dflt: 34 }),
      fColor("color", "Rising", "#22c55e"), fColor("color2", "Falling", "#ef4444"), fHeight()],
    build: function (d, p) {
      var hl2 = srcArr(d, "hl2");
      var f = smaArr(hl2, p.fast), s = smaArr(hl2, p.slow), v = new Array(d.n);
      for (var i = 0; i < d.n; i++) v[i] = (isNum(f[i]) && isNum(s[i])) ? f[i] - s[i] : NaN;
      return {
        plots: [{ type: "hist", data: zipColor(d, v, p.color, p.color2) }],
        priceLines: [{ price: 0, color: "#3a4c61" }]
      };
    }
  });

  defStudy({
    id: "atr", name: "Average True Range", short: "ATR", group: "Volatility", kind: "pane",
    defaults: D([["period", 14], ["color", "#fb923c"], ["paneHeight", 110]]),
    fields: [fPeriod(14), fColor("color", "Colour", "#fb923c"), fHeight()],
    build: function (d, p) {
      return { plots: [{ type: "line", color: p.color, width: 2, data: zip(d, atrArr(d, p.period)) }] };
    }
  });

  defStudy({
    id: "adx", name: "Average Directional Index", short: "ADX", group: "Volatility", kind: "pane",
    defaults: D([["period", 14], ["diLen", 14], ["color", "#f59e0b"], ["color2", "#22c55e"], ["color3", "#ef4444"], ["paneHeight", 140]]),
    fields: [fPeriod(14), F("diLen", "DI length", "number", { min: 2, max: 200, dflt: 14 }),
      fColor("color", "ADX", "#f59e0b"), fColor("color2", "+DI", "#22c55e"), fColor("color3", "−DI", "#ef4444"), fHeight()],
    build: function (d, p) {
      var r = adxArr(d, p.period, p.diLen);
      return {
        plots: [
          { type: "line", color: p.color, width: 2, data: zip(d, r.adx) },
          { type: "line", color: p.color2, width: 1, data: zip(d, r.pdi) },
          { type: "line", color: p.color3, width: 1, data: zip(d, r.ndi) }
        ],
        priceLines: [{ price: 25, color: "#3a4c61" }]
      };
    }
  });

  defStudy({
    id: "stddev", name: "Standard Deviation", short: "STDDEV", group: "Volatility", kind: "pane",
    defaults: D([["period", 20], ["color", "#a78bfa"], ["paneHeight", 110]]),
    fields: [fPeriod(20), fColor("color", "Colour", "#a78bfa"), fHeight()],
    build: function (d, p) {
      return { plots: [{ type: "line", color: p.color, width: 2, data: zip(d, sdArr(d.close, p.period)) }] };
    }
  });

  defStudy({
    /* TradingView has no volume pane: the histogram is an overlay on the MAIN
       pane, riding an unnamed price scale pinned to the bottom quarter of it
       (194px of a 777px chart when sampled). `overlayScale` puts both plots on
       that unnamed scale so their ~1e9 numbers never touch the price axis;
       pinVolumeStrip() then buys back the bottom 75% and drops the strip
       behind the candles. The bars carry TV's real #26a69a / #ef5350 at 50%
       alpha — rgb(26,90,84) / rgb(127,49,47) over the #0f0f0f canvas — so the
       grid shows through them exactly as it does on tv.com, which a
       pre-composited hex can no longer do now that volume shares the pane.
       `ma` starts off: TradingView's volume MA is opt-in. */
    id: "volume", name: "Volume", short: "VOL", group: "Volume",
    kind: "overlay", overlayScale: true,
    defaults: D([["color", "#26a69a"], ["color2", "#ef5350"], ["ma", 0]]),
    fields: [fColor("color", "Up bar", "#26a69a"), fColor("color2", "Down bar", "#ef5350"),
      F("ma", "Moving average (0 = off)", "number", { min: 0, max: 200, dflt: 0 })],
    build: function (d, p) {
      var bars = [], maxV = 0, i;
      var up = withAlpha(p.color, 0.5), dn = withAlpha(p.color2, 0.5);
      for (i = 0; i < d.n; i++) {
        if (d.volume[i] > maxV) maxV = d.volume[i];
        bars.push({
          time: d.time[i],
          value: d.volume[i],
          color: d.close[i] >= d.open[i] ? up : dn
        });
      }
      /* 0..peak, not peak..peak: without an explicit floor the scale's own
         autoscale starts at the smallest non-zero print and every bar bottoms
         out above the pane edge. */
      var plots = [{
        type: "hist", data: bars, volume: true, overlayScale: true,
        autoscale: { minValue: 0, maxValue: maxV || 1 }
      }];
      plots.push({
        type: "line", color: p.colorMa || "#60a5fa", width: p.widthMa || 1,
        data: p.ma > 1 ? zip(d, smaArr(d.volume, p.ma)) : [], volume: true, overlayScale: true
      });
      return { plots: plots };
    }
  });

  defStudy({
    id: "obv", name: "On-Balance Volume", short: "OBV", group: "Volume", kind: "pane",
    defaults: D([["color", "#22d3ee"], ["ma", 21], ["paneHeight", 110]]),
    fields: [fColor("color", "Colour", "#22d3ee"), F("ma", "Moving average (0 = off)", "number", { min: 0, max: 200, dflt: 21 }), fHeight()],
    build: function (d, p) {
      var v = obvArr(d), plots = [{ type: "line", color: p.color, width: 2, data: zip(d, v) }];
      if (p.ma > 1) plots.push({ type: "line", color: "#f59e0b", width: 1, data: zip(d, smaArr(v, p.ma)) });
      return { plots: plots, priceLines: [{ price: 0, color: "#3a4c61" }] };
    }
  });

  /* STUDY_MAP is filled in by defStudy as each study is defined above —
     there is nothing left to enumerate here. */
  var GROUP_ORDER = ["Trend", "Oscillators", "Volatility", "Volume", "Bill Williams", "Pine"];

  /* ======================================================= Pine Script =====
     A user script becomes an ordinary study definition: `build` runs the
     interpreter over the chart's own bars and the plan it returns is mapped
     onto the same plots, price lines and markers the hand-written studies
     produce — so the legend, Settings dialog, Style tab, status line and
     visibility rules all keep working with no special-casing. */
  var PINE_GROUP = "Pine";
  var PINE_SCRIPTS_KEY = "cx.pine.scripts";

  function pineHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + s.length.toString(36);
  }

  function pineBars(d) {
    var out = new Array(d.n);
    for (var i = 0; i < d.n; i++) {
      out[i] = {
        time: d.time[i], open: d.open[i], high: d.high[i], low: d.low[i],
        close: d.close[i], volume: d.volume ? (d.volume[i] || 0) : 0
      };
    }
    return out;
  }

  /* Enough history for every rolling window to warm up, with no dependency on
     data having loaded — used to discover what a script draws. */
  function pineDummyBars() {
    var out = [];
    for (var i = 0; i < 300; i++) {
      var c = 100 + Math.sin(i / 9) * 6 + Math.sin(i / 31) * 3;
      out.push({
        time: 1700000000 + i * 86400,
        open: c * 0.999, high: c * 1.008, low: c * 0.992, close: c,
        volume: 1000 + (i % 7) * 13
      });
    }
    return out;
  }

  /* Lightweight Charts' marker API draws four shapes in three positions, so
     Pine's wider shape.* vocabulary is folded onto those. label.*_style is a
     box with text on TradingView; a square marker carrying the same text is
     the closest the marker API gets. */
  var PINE_SHAPE = {
    circle: "circle", cross: "square", xcross: "square", diamond: "square",
    square: "square", flagup: "square", flagdown: "square", flag: "square",
    triup: "arrowUp", arrowup: "arrowUp", labelup: "arrowUp",
    tridown: "arrowDown", arrowdown: "arrowDown", labeldown: "arrowDown",
    labelleft: "square", labelright: "square", labelcenter: "square",
    none: "circle"
  };
  var PINE_POS = {
    abovebar: "aboveBar", top: "aboveBar", absolutetop: "aboveBar",
    belowbar: "belowBar", bottom: "belowBar", absolutebottom: "belowBar",
    inbar: "inBar", absolute: "aboveBar"
  };
  var PINE_LS = { solid: 0, dotted: 1, dashed: 2, large_dashed: 3, sparse_dotted: 4 };
  function pineHistStyle(s) { return s === "histogram" || s === "columns" || s === "cross"; }

  /* Pine lets a line's colour change bar by bar — plot(ma, color = stacked ?
     green : red) — which Lightweight Charts cannot express on a single series.
     `L.colors` lists only the bars where the colour *switched*, so the runs are
     walked off that short list instead of the whole history. Each run repeats
     the boundary point, so the line stays unbroken across a switch. */
  function colourRuns(data, L) {
    var ch = L.colors || [], runs = [], cur = L.color, ci = 0, from = 0;
    if (!ch.length) return [{ color: L.color, data: data }];
    for (var b = 0; b <= data.length; b++) {
      while (ci < ch.length && ch[ci].at === b) { cur = ch[ci].color; ci++; }
      var nextAt = ci < ch.length ? ch[ci].at : Infinity;
      if ((nextAt === b + 1 || b === data.length) && b >= from) {
        runs.push({ color: cur, data: data.slice(from, b + 1) });
        from = b;
      }
    }
    return runs;
  }
  /* A histogram is the one style Lightweight Charts colours per point, so it
     stays a single series rather than one per run. */
  function colourPoints(data, L) {
    var ch = L.colors || [];
    if (!ch.length) return data;
    var out = [], ci = 0, cur = L.color;
    for (var i = 0; i < data.length; i++) {
      while (ci < ch.length && ch[ci].at === i) { cur = ch[ci].color; ci++; }
      var pt = { time: data[i].time, value: data[i].value };
      if (cur !== L.color) pt.color = cur;
      out.push(pt);
    }
    return out;
  }

  /* bgcolor() washes the whole pane rather than drawing a line, and Lightweight
     Charts has no primitive for it. Each contiguous run of one colour becomes
     an area pinned between two levels on a private price scale, which
     autoscales to the band alone — so the band always fills the pane exactly,
     at any zoom, and its numbers never reach the candle scale.

     A band spans only from its first bar's x to its last bar's x, so two
     neighbours would leave a bar-wide unpainted seam where the condition
     flips. The seam bar is claimed by the run that ENDS there rather than the
     one that starts there: bands are added in run order and Lightweight Charts
     draws in insertion order, so the incoming colour still wins exactly on the
     flip candle while the outgoing one keeps every candle before it. Claiming
     it the other way round — starting each run one bar early — closes the seam
     just as well but slides every colour change one candle to the left of where
     the script made it, which reads as "the background starts before the
     cross" and as "start from 2nd candle starts from the 1st". */
  function bgRuns(bg, d) {
    var runs = [], cur = null;
    for (var i = 0; i < (bg || []).length; i++) {
      var e = bg[i];
      if (!e || !e.color || !isNum(e.at)) continue;
      /* An entry already sits on the current run's last bar when a script calls
         bgcolor() twice per bar; keep only the later colour. */
      if (cur && cur.color === e.color && e.at <= cur.last + 1) {
        if (e.at > cur.last) cur.last = e.at;
        continue;
      }
      if (cur) runs.push(cur);
      cur = { color: e.color, first: e.at, last: e.at };
    }
    if (cur) runs.push(cur);
    return runs.map(function (R, i) {
      var a = R.first, b = R.last, nxt = runs[i + 1];
      if (nxt && nxt.first === b + 1) b += 1;          /* take the seam bar */
      else if (b <= a && a > 0) a -= 1;                /* a lone bar needs two points to draw */
      var lo = Math.max(0, a), hi = Math.min(d.n - 1, b), data = [];
      for (var j = lo; j <= hi; j++) data.push({ time: d.time[j], value: 1 });
      return { color: R.color, data: data };
    }).filter(function (R) { return R.data.length > 1; });
  }

  /* Plan -> the object `build()` is expected to return. */
  function pineResult(d, plan) {
    var plots = [], priceLines = [], markers = [];
    (plan.lines || []).forEach(function (L) {
      if (L.display === "none") return;
      var data = zip(d, L.values);
      var st = typeof L.style === "string" ? L.style : "line";
      if (pineHistStyle(st)) {
        plots.push({ type: "hist", color: L.color, data: colourPoints(data, L) });
      } else if (st === "area") {
        colourRuns(data, L).forEach(function (R, ri) {
          var p = { type: "area", color: R.color, width: L.width, base: L.histBase, data: R.data };
          if (ri > 0) p.lastValue = false;   /* one price label, not one per run */
          plots.push(p);
        });
      } else {
        colourRuns(data, L).forEach(function (R, ri) {
          var p = { type: "line", color: R.color, width: L.width, data: R.data };
          if (ri > 0) p.lastValue = false;
          plots.push(p);
        });
      }
    });
    (plan.hlines || []).forEach(function (h) {
      priceLines.push({
        price: h.price, color: h.color,
        lineWidth: Math.max(1, Math.round(h.width) || 1),
        lineStyle: PINE_LS[h.style] != null ? PINE_LS[h.style] : 0,
        title: h.title
      });
    });
    (plan.shapes || []).forEach(function (S) {
      var pos = PINE_POS[S.location] || "aboveBar";
      var shp = PINE_SHAPE[S.style] || "circle";
      for (var i = 0; i < S.values.length && i < d.n; i++) {
        if (S.values[i] !== true) continue;
        markers.push({ time: d.time[i], position: pos, color: S.color, shape: shp });
      }
    });
    /* label.new / line.new / box.new — TradingView's imperative drawing
       objects. Each already resolved to a bar index and a price inside the
       runtime; here they become the closest thing Lightweight Charts has:
       a labelled marker, a two-point segment and a range-pinned band. */
    (plan.labels || []).forEach(function (L) {
      if (L.dead || !isNum(L.bar) || L.bar < 0 || L.bar >= d.n) return;
      var shp = PINE_SHAPE[L.style] || PINE_SHAPE[L.style.replace(/^style_/, "")] || "labelup";
      var pos = L.yloc === "top" ? "aboveBar" : L.yloc === "bottom" ? "belowBar" : "aboveBar";
      if (L.style === "labeldown" || L.style === "arrowdown") pos = "belowBar";
      var mk = { time: d.time[L.bar], position: pos, color: L.color, shape: shp };
      if (L.text) mk.text = L.text;
      /* A label pinned to a price rides that price instead of snapping to the
         bar's high/low, which is what yloc.price means. */
      if (L.yloc === "price" && isNum(L.price)) mk.price = L.price;
      markers.push(mk);
    });
    (plan.drawlines || []).forEach(function (R) {
      if (R.dead) return;
      var a = isNum(R.bar1) ? R.bar1 : -1, b = isNum(R.bar2) ? R.bar2 : -1;
      if (a < 0 && b < 0) return;
      if (a < 0) a = b; if (b < 0) b = a;
      var lo = Math.max(0, Math.min(a, b)), hi = Math.min(d.n - 1, Math.max(a, b));
      if (lo === hi) return;
      var data = [];
      /* `extend` grows the segment to the chart edge along its own slope,
         exactly as TradingView does, rather than stopping at the anchors. */
      var dy = isNum(R.p1) && isNum(R.p2) ? (R.p2 - R.p1) / (b - a || 1) : 0;
      if ((R.extend === "left" || R.extend === "both") && isNum(R.p1)) {
        data.push({ time: d.time[0], value: R.p1 + dy * (0 - a) });
      }
      if (isNum(R.p1) && isNum(R.p2)) {
        data.push({ time: d.time[lo], value: R.p1 + dy * (lo - a) });
        data.push({ time: d.time[hi], value: R.p1 + dy * (hi - a) });
      }
      if ((R.extend === "right" || R.extend === "both") && isNum(R.p2)) {
        data.push({ time: d.time[d.n - 1], value: R.p2 + dy * ((d.n - 1) - b) });
      }
      data.sort(function (m, n) { return m.time - n.time; });
      if (data.length < 2) return;
      plots.push({
        type: "line", color: R.color, width: Math.max(1, Math.round(R.width) || 1),
        lastValue: false, data: data
      });
    });
    (plan.boxes || []).forEach(function (B) {
      if (B.dead) return;
      var a = isNum(B.bar1) ? B.bar1 : -1, b = isNum(B.bar2) ? B.bar2 : -1;
      if (a < 0 && b < 0) return;
      if (a < 0) a = b; if (b < 0) b = a;
      var lo = Math.max(0, Math.min(a, b)), hi = Math.min(d.n - 1, Math.max(a, b));
      if (!isNum(B.top) || !isNum(B.bottom) || lo === hi) return;
      var mn = Math.min(B.top, B.bottom), mx = Math.max(B.top, B.bottom);
      /* An area pinned between the box's edges, confined to its bar range —
         the fill TradingView paints inside box.new's corners. */
      var flat = [];
      for (var i = lo; i <= hi; i++) flat.push({ time: d.time[i], value: mx });
      plots.push({
        type: "area", base: mn, band: true, color: B.bgcolor || B.color,
        color2: B.bgcolor || B.color, lastValue: false, data: flat
      });
    });
    /* fill() whose bounds are constant lands as an area band. A band that
       moves bar to bar cannot be drawn at all: Lightweight Charts has no band
       series, which is why the built-in Bollinger study draws three lines and
       no fill for exactly the same reason. */
    (plan.fills || []).forEach(function (F) {
      var n = Math.min(F.from.length, F.to.length);
      if (!n) return;
      var lo = F.from[n - 1], hi = F.to[n - 1];
      if (!isNum(lo) || !isNum(hi)) return;
      for (var i = 0; i < n; i++) {
        if (!isNum(F.from[i]) || !isNum(F.to[i]) ||
            Math.abs(F.from[i] - lo) > 1e-9 || Math.abs(F.to[i] - hi) > 1e-9) return;
      }
      plots.push(bandFill(d, Math.min(lo, hi), Math.max(lo, hi), F.color));
    });
    return { plots: plots, priceLines: priceLines, markers: markers,
             bgRuns: bgRuns(plan.bgcolors, d) };
  }

  /* Style-tab rows, one per output — TradingView gives a Pine indicator a
     show/hide checkbox, a swatch and a plot-style dropdown for each plot. */
  function pineSrows(plan) {
    var rows = [];
    (plan.lines || []).forEach(function (L, i) {
      var st = typeof L.style === "string" ? L.style : "line";
      var hist = pineHistStyle(st);
      rows.push({
        k: "plot", lab: L.title || "Plot " + (i + 1), p: i,
        c: "pc" + i, d: L.color,
        w: hist ? null : "pw" + i, lw: L.width || 2,
        ls: hist ? null : "pl" + i, lsd: 0,
        ps: "pps" + i, dps: hist ? "Histogram" : (st === "area" ? "Area" : "Line")
      });
    });
    if ((plan.shapes || []).length) {
      rows.push({
        k: "plot", lab: plan.shapes[0].title || "Markers", markers: true,
        c: "mcol", d: plan.shapes[0].color, ps: "mstyle", dps: "Line"
      });
    }
    return rows;
  }

  /* Inputs become settings-panel fields, keyed exactly the way the runtime
     looks them up (inputId), so a value changed in the dialog is the value the
     script reads. */
  function pineField(key, it) {
    var lab = it.title || (it.kind === "input.bool" ? "Enabled" : "Value");
    if (it.type === "number") {
      var o = { dflt: it.dflt };
      if (isNum(it.minval)) o.min = it.minval;
      if (isNum(it.maxval)) o.max = it.maxval;
      if (it.kind === "input.int") o.step = 1;
      return F(key, lab, "number", o);
    }
    if (it.type === "checkbox") return F(key, lab, "checkbox", { dflt: it.dflt });
    if (it.type === "color") return F(key, lab, "color", { dflt: typeof it.dflt === "string" ? it.dflt : "#2962ff" });
    if (it.type === "source") return F(key, lab, "select", { options: SOURCES, dflt: it.dflt });
    if (it.type === "timeframe") {
      /* A script that defaults to something off the ladder ("1D", "30m") still
         needs its own value listed, or picking anything would silently rewrite
         it on the next save. */
      var tf = typeof it.dflt === "string" ? it.dflt : "";
      var tfo = PINE_TF_OPTIONS.slice();
      if (!tfo.some(function (o) { return o.v === tf; })) tfo.unshift({ v: tf, t: tf });
      return F(key, lab, "select", { options: tfo, dflt: tf });
    }
    if (Array.isArray(it.options) && it.options.length) {
      return F(key, lab, "select", { options: it.options, dflt: it.dflt });
    }
    return F(key, lab, "text", { dflt: it.dflt });
  }
  function pineInputs(comp) {
    var seen = {}, fields = [], defaults = {};
    (comp.inputs || []).forEach(function (it) {
      if (seen[it.id]) return;   /* same id reads the same setting at runtime */
      seen[it.id] = 1;
      if (it.dflt !== undefined) defaults[it.id] = it.dflt;
      fields.push(pineField(it.id, it));
    });
    defaults.precision = "";
    defaults.paneHeight = 140;
    defaults.lblStatus = true;
    return { fields: fields, defaults: defaults };
  }

  /* Compile, probe and register. Returns null when the source does not
     compile, carrying the error so the editor can show it on the right line. */
  function definePineStudy(src, id) {
    if (!window.Pine) return null;
    var comp;
    try { comp = window.Pine.compileCached(src); }
    catch (e) { return { error: e.message }; }
    if (!comp || comp.error) return { error: comp ? comp.error : "compile failed" };

    var probe = null;
    try { probe = window.Pine.run(window.Pine.compileCached(src), pineDummyBars(), {}); }
    catch (e) { probe = null; }

    var io = pineInputs(comp);
    var s = {
      id: id || ("pine:" + pineHash(src)),
      name: comp.name || "Pine Script",
      /* TradingView writes the whole indicator() title in the legend — there
         is no short form for a script, so nothing is trimmed here. */
      short: comp.name || "Pine",
      group: PINE_GROUP,
      kind: comp.overlay ? "overlay" : "pane",
      source: src,
      defaults: io.defaults,
      fields: io.fields,
      build: function (d, p) {
        var plan;
        try {
          plan = window.Pine.run(window.Pine.compileCached(this.source), pineBars(d), p);
        } catch (e) {
          console.warn("[chartview] pine " + this.id, e);
          return { plots: [], priceLines: [], markers: [] };
        }
        if (plan.errors && plan.errors.length) console.warn("[chartview] pine " + this.id, plan.errors);
        return pineResult(d, plan);
      }
    };
    if (probe && probe.lines && probe.lines.length) s.srows = pineSrows(probe);
    /* Plot titles, so the status line can name each output the way TV does. */
    if (probe && probe.lines && probe.lines.length) {
      s.plotTitles = probe.lines.map(function (L, i) { return L.title || "Plot " + (i + 1); });
    }
    defStudy(s);
    return { id: s.id, name: s.name, kind: s.kind, inputs: io.fields.length };
  }

  function pineScriptsAll() {
    var v = recall(PINE_SCRIPTS_KEY, null);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  function pineSaveSource(id, src) {
    var all = pineScriptsAll();
    all[id] = src;
    store(PINE_SCRIPTS_KEY, all);
    pinePushRemote(all);
  }
  /* ---- server mirror --------------------------------------------------
     localStorage is per-browser and can be evicted wholesale. One was, and
     every saved script went with it, so the same map is mirrored to
     data/pine_scripts.json. localStorage stays the read path — start-up is
     synchronous and a round trip there would delay every chart — so start-up
     instead merges in whatever the server holds that the browser has lost,
     and every save and delete pushes the map back. */
  var PINE_REMOTE = "/api/pine";
  function pinePushRemote(all) {
    try {
      fetch(PINE_REMOTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scripts: all }),
      }).catch(function () { /* offline — the local copy still stands */ });
    } catch (e) { /* fetch unavailable */ }
  }
  function pinePullRemote() {
    try {
      fetch(PINE_REMOTE).then(function (r) { return r.json(); }).then(function (j) {
        var remote = (j && j.scripts) || {};
        var local = pineScriptsAll();
        var recovered = [];
        Object.keys(remote).forEach(function (id) {
          /* On a conflict the browser wins: every edit pushes immediately, so
             anything present locally was written after the server copy. */
          if (!local[id]) { local[id] = remote[id]; recovered.push(id); }
        });
        if (!recovered.length) return;
        store(PINE_SCRIPTS_KEY, local);
        recovered.forEach(function (id) { definePineStudy(local[id], id); });
      }).catch(function () { /* offline — nothing to merge */ });
    } catch (e) { /* fetch unavailable */ }
  }
  /* Called at start-up so instances persisted under `cx.cv.ind.*` resolve to
     a real study before the chart asks for them. */
  function restorePineStudies() {
    var all = pineScriptsAll();
    Object.keys(all).forEach(function (id) { definePineStudy(all[id], id); });
  }
  restorePineStudies();
  pinePullRemote();

  /* Register a script and return its study id. Passing `id` keeps an existing
     instance attached across an edit — the chart already holds that id. */
  function addPineStudy(src, id) {
    src = String(src || "");
    if (!src.trim()) return { error: "The script is empty." };
    var res = definePineStudy(src, id || ("pine:" + pineHash(src)));
    if (res && !res.error) pineSaveSource(res.id, src);
    return res;
  }


  /* Last printed value of each visible plot, as TradingView's status line
     prints them: fixed decimals when Precision is set, market-style after. */
  function fmtVal(v, prec) {
    if (!isNum(v)) return "";
    if (isNum(prec) && prec >= 0) return v.toFixed(prec);
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(2) + "K";
    if (a >= 100) return v.toFixed(2);
    if (a >= 1) return v.toFixed(3);
    if (a === 0) return "0";
    if (a >= 0.0001) return v.toFixed(4);
    return v.toPrecision(3);
  }
  function statusValues(inst) {
    if (inst.params.lblStatus === false) return "";
    if (!inst.plotVals || !inst.plotVals.length) return "";
    var pr = inst.params.precision;
    var n = (pr === undefined || pr === "" || pr === "Default") ? -1 : parseInt(pr, 10);
    var out = [];
    /* TradingView labels every Pine output in the status line — "Price 83.06K
       SuperTrend 76.66K" — because a script can carry a dozen plots and bare
       numbers are unreadable. Built-in studies keep the classic bare list. */
    var st = STUDY_MAP[inst.id];
    var titles = st && st.plotTitles;
    inst.plotVals.forEach(function (v, i) {
      if (!isNum(v)) return;
      var val = fmtVal(v, n);
      out.push(titles && titles[i] ? titles[i] + " " + val : val);
    });
    return out.join("  ");
  }

  function studyLabel(inst) {
    var st = STUDY_MAP[inst.id];
    if (!st) return inst.id;
    var p = inst.params;
    /* TradingView's "Inputs in status line" checkbox: unchecked, the status
       line carries the study name and nothing else. */
    if (p.inpStatus === false) return (st.short || st.name);
    var parts = [];
    /* TradingView writes the legend as "MACD close 12 26 9" — source first,
       space separated. Everything else keeps the classic "RSI 14, close". */
    if (st.labelSource && p.source) parts.push(p.source);
    (st.labelKeys || ["period", "rsiLen", "stochLen", "fast", "signal", "step"]).forEach(function (k) {
      if (isNum(p[k]) && st.defaults[k] !== undefined) parts.push(p[k]);
    });
    if (!parts.length) return (st.short || st.name);
    return (st.short || st.name) + " " + parts.join(st.labelKeys ? " " : ",");
  }

  function studyDetail(inst) {
    var st = STUDY_MAP[inst.id];
    if (!st) return "";
    var p = inst.params, bits = [];
    if (st.defaults.source !== undefined && p.source) bits.push(p.source);
    if (st.defaults.period !== undefined) bits.push("len " + p.period);
    if (st.defaults.mult !== undefined) bits.push("×" + p.mult);
    if (st.kind === "pane") bits.push(p.paneHeight + "px");
    return bits.join(" · ");
  }

  /* ====================================================== drawing tools */
  var TOOLS = [
    { id: "cursor", label: "Cross", key: "V" },
    { id: "delete", label: "Eraser", key: "E" },
    { id: "trend", label: "Trendline", key: "T" },
    { id: "ray", label: "Ray", key: "R" },
    { id: "extline", label: "Extended line" },
    { id: "hline", label: "Horizontal line", key: "H" },
    { id: "hray", label: "Horizontal ray" },
    { id: "vline", label: "Vertical line" },
    { id: "channel", label: "Parallel channel" },
    { id: "fib", label: "Fib retracement" },
    { id: "fibext", label: "Trend-based fib extension" },
    { id: "xabcd", label: "XABCD pattern" },
    { id: "headshoulders", label: "Head and shoulders" },
    { id: "longpos", label: "Long position" },
    { id: "shortpos", label: "Short position" },
    { id: "pricerange", label: "Price range" },
    { id: "daterange", label: "Date range" },
    { id: "brush", label: "Brush" },
    { id: "highlighter", label: "Highlighter" },
    { id: "marker", label: "Arrow marker" },
    { id: "arrow", label: "Arrow" },
    { id: "rect", label: "Rectangle" },
    { id: "ellipse", label: "Ellipse" },
    { id: "text", label: "Text" },
    { id: "note", label: "Note" },
    { id: "pricelabel", label: "Price label" },
    { id: "sticker", label: "Stickers" },
    { id: "measure", label: "Measure", key: "M" },
    { id: "zoomregion", label: "Zoom in", key: "Z" }
  ];
  /* TradingView's remaining tools, captured row-for-row from the live rail
     flyouts. TOOLS_X entries are wired into TOOL_GROUPS + SHAPE below. */
  var TOOLS_X = [
    /* Cursors */
    { id: "dot", label: "Dot" },
    { id: "cursarrow", label: "Arrow" },
    { id: "demo", label: "Demonstration" },
    { id: "magic", label: "Magic" },
    /* Trend tools */
    { id: "infoline", label: "Info line" },
    { id: "trendangle", label: "Trend angle" },
    { id: "crossline", label: "Crossline" },
    { id: "regression", label: "Regression trend" },
    { id: "flattop", label: "Flat top/bottom" },
    { id: "disjoint", label: "Disjoint channel" },
    { id: "pitchfork", label: "Pitchfork" },
    { id: "schiff", label: "Schiff pitchfork" },
    { id: "schiffmod", label: "Modified Schiff pitchfork" },
    { id: "insidepf", label: "Inside pitchfork" },
    /* Geometric shapes */
    { id: "arrowup", label: "Arrow mark up" },
    { id: "arrowdown", label: "Arrow mark down" },
    { id: "rotrect", label: "Rotated rectangle" },
    { id: "path", label: "Path" },
    { id: "circle", label: "Circle" },
    { id: "polyline", label: "Polyline" },
    { id: "tri", label: "Triangle" },
    { id: "arc", label: "Arc" },
    { id: "curve", label: "Curve" },
    { id: "doublecurve", label: "Double curve" },
    /* Fibonacci and Gann tools */
    { id: "fibchannel", label: "Fib channel" },
    { id: "fibtime", label: "Fib time zone" },
    { id: "fibfan", label: "Fib speed resistance fan" },
    { id: "fibtimeext", label: "Trend-based fib time" },
    { id: "fibcircles", label: "Fib circles" },
    { id: "fibspiral", label: "Fib spiral" },
    { id: "fibarcs", label: "Fib speed resistance arcs" },
    { id: "fibwedge", label: "Fib wedge" },
    { id: "pitchfan", label: "Pitchfan" },
    { id: "gannbox", label: "Gann box" },
    { id: "gannfixed", label: "Gann square fixed" },
    { id: "gannsquare", label: "Gann square" },
    { id: "gannfan", label: "Gann fan" },
    /* Chart patterns, Elliott waves and cycles */
    { id: "cypher", label: "Cypher" },
    { id: "abcd", label: "ABCD" },
    { id: "tripattern", label: "Triangle pattern" },
    { id: "threedrivers", label: "Three drives" },
    { id: "elliot5", label: "Impulse (12345)" },
    { id: "elliot3", label: "Correction (ABC)" },
    { id: "elliottri", label: "Triangle (ABCDE)" },
    { id: "elliotwxy", label: "Double combo (WXY)" },
    { id: "elliotwxyxz", label: "Triple combo (WXYXZ)" },
    { id: "cycliclines", label: "Cyclic lines" },
    { id: "timecycles", label: "Time cycles" },
    { id: "sine", label: "Sine line" },
    /* Forecasting, volume-based and measuring tools */
    { id: "forecast", label: "Position forecast" },
    { id: "barspattern", label: "Bars pattern" },
    { id: "ghostfeed", label: "Ghost feed" },
    { id: "sector", label: "Sector" },
    { id: "avwap", label: "Anchored VWAP" },
    { id: "frvp", label: "Fixed range volume profile" },
    { id: "avp", label: "Anchored volume profile" },
    { id: "dpr", label: "Date and price range" },
    /* Text, notes and content */
    { id: "pricenote", label: "Price note" },
    { id: "pin", label: "Pin" },
    { id: "table", label: "Table" },
    { id: "callout", label: "Callout" },
    { id: "comment", label: "Comment" },
    { id: "signpost", label: "Signpost" },
    { id: "flag", label: "Flag mark" },
    { id: "image", label: "Image" },
    { id: "post", label: "Post" },
    { id: "idea", label: "Idea" }
  ];
  TOOLS = TOOLS.concat(TOOLS_X);
  /* Cursor *modes* live in the first flyout: picking one keeps you in the
     crosshair tool but changes how it reads, and never starts a drawing. */
  var CURSOR_MODE = { dot: 1, cursarrow: 1, demo: 1, magic: 1 };
  /* Path and polyline keep collecting clicks until you double-click. */
  var VARLEN = { path: 1, polyline: 1 };

  /* ------------------------------------------------------- SHAPE registry
     Declarative drawing tools.  Each entry declares:
       n     points needed before the drawing is placed
       hit   (g, x, y, tol, env) -> anchor | -1 | null   (optional; falls
             back to a polyline hit through every anchor)
       draw  (ctx, o) paints it — `o` carries the resolved anchors plus the
             helpers the classic switch below already uses.
     Tools absent from here fall through to that switch, so everything that
     worked before still works exactly as it did. */
  var SHAPE = {};

  function shpSeg(ctx, x1, y1, x2, y2) {
    if (x1 == null || y1 == null || x2 == null || y2 == null) return;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  function shpPoly(ctx, xs, ys, i0, i1) {
    var started = false, i;
    for (i = i0; i <= i1; i++) {
      if (i < 0 || i >= xs.length || xs[i] == null || ys[i] == null) continue;
      if (!started) { ctx.beginPath(); ctx.moveTo(xs[i], ys[i]); started = true; }
      else ctx.lineTo(xs[i], ys[i]);
    }
    if (started) ctx.stroke();
  }

  /* Closed polygon: fill it at 12% (the way TradingView tints shapes), then
     stroke the outline in the drawing's own colour. */
  function shpFillPoly(ctx, pts) {
    if (!pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.save(); ctx.globalAlpha = 0.12; ctx.fill(); ctx.restore();
    ctx.stroke();
  }

  /* Least-squares line + residual spread, in screen pixels. */
  function shpFit(xs, ys) {
    var n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0, i;
    for (i = 0; i < xs.length; i++) {
      n++; sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i];
    }
    if (n < 2) return null;
    var den = n * sxx - sx * sx;
    if (!den) return null;
    var m = (n * sxy - sx * sy) / den, b = (sy - m * sx) / n, s2 = 0;
    for (i = 0; i < xs.length; i++) { var e = ys[i] - (m * xs[i] + b); s2 += e * e; }
    return { m: m, b: b, sd: Math.sqrt(s2 / n) };
  }

  /* Circle through three points. */
  function shpCirc(x1, y1, x2, y2, x3, y3) {
    var d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    if (Math.abs(d) < 1e-6) return null;
    var k1 = x1 * x1 + y1 * y1, k2 = x2 * x2 + y2 * y2, k3 = x3 * x3 + y3 * y3;
    var cx = (k1 * (y2 - y3) + k2 * (y3 - y1) + k3 * (y1 - y2)) / d;
    var cy = (k1 * (x3 - x2) + k2 * (x1 - x3) + k3 * (x2 - x1)) / d;
    return { cx: cx, cy: cy, r: Math.hypot(x1 - cx, y1 - cy) };
  }

  /* Is `c` on the forward sweep from `a` to `b`? Decides arc() direction. */
  function shpBetween(a, b, c) {
    var T = Math.PI * 2;
    return (((c - a) % T) + T) % T <= (((b - a) % T) + T) % T;
  }

  function shpArrowUp(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x, y - 20); ctx.lineTo(x - 12, y - 3); ctx.lineTo(x - 4, y - 3);
    ctx.lineTo(x - 4, y + 20); ctx.lineTo(x + 4, y + 20);
    ctx.lineTo(x + 4, y - 3); ctx.lineTo(x + 12, y - 3);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  function shpArrowDown(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x, y + 20); ctx.lineTo(x - 12, y + 3); ctx.lineTo(x - 4, y + 3);
    ctx.lineTo(x - 4, y - 20); ctx.lineTo(x + 4, y - 20);
    ctx.lineTo(x + 4, y + 3); ctx.lineTo(x + 12, y + 3);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  /* Pitchfork and its three TradingView variants share one construction. */
  function shpFork(ctx, o, mode) {
    var xs = o.xs, ys = o.ys;
    if (xs[0] == null || xs[1] == null || xs[2] == null) return;
    var tx = (xs[1] + xs[2]) / 2, ty = (ys[1] + ys[2]) / 2;   // median target
    var ox = xs[0], oy = ys[0];
    if (mode === "schiff") { ox = (ox + tx) / 2; oy = (oy + ty) / 2; }
    else if (mode === "schiffmod") {
      var hx = (xs[0] + tx) / 2, hy = (ys[0] + ty) / 2;
      ox = (xs[0] + hx) / 2; oy = (ys[0] + hy) / 2;
    }
    shpSeg(ctx, ox, oy, xs[1], ys[1]);          // handle arms
    shpSeg(ctx, ox, oy, xs[2], ys[2]);
    var mx = tx - ox, my = ty - oy;
    if (!mx && !my) return;
    var dx = mx * 40, dy = my * 40;             // a far point on the same ray
    var e = o.extendSeg(ox, oy, ox + dx, oy + dy, o.w, o.h);
    shpSeg(ctx, e[0], e[1], e[2], e[3]);        // median line, edge to edge
    var a1 = xs[1], b1 = ys[1], a2 = xs[2], b2 = ys[2];
    if (mode === "inside") {
      a1 = (xs[0] + xs[1]) / 2; b1 = (ys[0] + ys[1]) / 2;
      a2 = (xs[0] + xs[2]) / 2; b2 = (ys[0] + ys[2]) / 2;
    }
    var p1 = o.extendSeg(a1, b1, a1 + dx, b1 + dy, o.w, o.h);
    shpSeg(ctx, p1[0], p1[1], p1[2], p1[3]);
    var p2 = o.extendSeg(a2, b2, a2 + dx, b2 + dy, o.w, o.h);
    shpSeg(ctx, p2[0], p2[1], p2[2], p2[3]);
  }

  /* --- Trend tools -------------------------------------------------- */
  SHAPE.infoline = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys, p = o.pts;
      if (xs[0] == null || xs[1] == null) return;
      shpSeg(ctx, xs[0], ys[0], xs[1], ys[1]);
      var dp = p[1].price - p[0].price;
      var pos = dp >= 0;
      var pct = p[0].price ? (dp / p[0].price) * 100 : 0;
      var bars = Math.abs(o.barIndexAt(p[1].time) - o.barIndexAt(p[0].time));
      o.labelBox([
        [(pos ? "+" : "−") + o.fmtPrice(Math.abs(dp)), pos ? "#26a69a" : "#f23645"],
        [(pos ? "+" : "−") + Math.abs(pct).toFixed(2) + "%", pos ? "#26a69a" : "#f23645"],
        [bars + " bars", "#dbdbdb"],
        [o.durTxt(Math.abs(p[1].time - p[0].time)), "#dbdbdb"]
      ], Math.max(xs[0], xs[1]) + 10, Math.min(ys[0], ys[1]) - 6, { border: o.col });
    }
  };

  SHAPE.trendangle = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      shpSeg(ctx, xs[0], ys[0], xs[1], ys[1]);
      var dx = xs[1] - xs[0], dy = ys[1] - ys[0];
      if (!dx && !dy) return;
      var a = Math.atan2(dy, dx), deg = a * 180 / Math.PI;
      if (deg > 90) deg -= 180;
      if (deg < -90) deg += 180;
      ctx.beginPath();
      if (a >= 0) ctx.arc(xs[0], ys[0], 24, 0, a);
      else ctx.arc(xs[0], ys[0], 24, a, 0);
      ctx.stroke();
      o.labelBox([[deg.toFixed(2) + "°", "#dbdbdb"]],
        xs[0] + (dx >= 0 ? 34 : -54), ys[0] - 14, { border: o.col });
    }
  };

  SHAPE.crossline = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys, i;
      if (xs[0] == null || xs[1] == null) return;
      var e = o.extendSeg(xs[0], ys[0], xs[1], ys[1], o.w, o.h);
      shpSeg(ctx, e[0], e[1], e[2], e[3]);
      for (i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(xs[i] - 8, ys[i]); ctx.lineTo(xs[i] + 8, ys[i]);
        ctx.moveTo(xs[i], ys[i] - 8); ctx.lineTo(xs[i], ys[i] + 8);
        ctx.stroke();
      }
    }
  };

  SHAPE.regression = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var x0 = Math.min(xs[0], xs[1]), x1 = Math.max(xs[0], xs[1]);
      var fx = [], fy = [], i, xx;
      if (o.data && o.data.n) {
        for (i = 0; i < o.data.n; i++) {
          xx = o.xOf(o.data.time[i]);
          if (xx == null || xx < x0 || xx > x1) continue;
          fx.push(xx); fy.push(o.yOf(o.data.close[i]));
        }
      }
      var f = fx.length > 2 ? shpFit(fx, fy) : null;
      if (!f) { shpSeg(ctx, xs[0], ys[0], xs[1], ys[1]); return; }
      var yA = f.b, yB = f.m * o.w + f.b, s = Math.max(4, f.sd);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, yA - s); ctx.lineTo(o.w, yB - s);
      ctx.lineTo(o.w, yB + s); ctx.lineTo(0, yA + s);
      ctx.closePath(); ctx.globalAlpha = 0.12; ctx.fill(); ctx.restore();
      shpSeg(ctx, 0, yA - s, o.w, yB - s);
      shpSeg(ctx, 0, yA + s, o.w, yB + s);
      shpSeg(ctx, 0, yA, o.w, yB);
    }
  };

  SHAPE.flattop = {
    n: 3, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var e = o.extendSeg(xs[0], ys[0], xs[1], ys[1], o.w, o.h);
      shpSeg(ctx, e[0], e[1], e[2], e[3]);
      if (ys[2] != null) shpSeg(ctx, 0, ys[2], o.w, ys[2]);
    }
  };

  SHAPE.disjoint = {
    n: 4, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys, i, e;
      for (i = 0; i < 4; i += 2) {
        if (xs[i] == null || xs[i + 1] == null) continue;
        e = o.extendSeg(xs[i], ys[i], xs[i + 1], ys[i + 1], o.w, o.h);
        shpSeg(ctx, e[0], e[1], e[2], e[3]);
      }
    }
  };

  SHAPE.pitchfork = { n: 3, draw: function (c, o) { shpFork(c, o, "andrews"); } };
  SHAPE.schiff = { n: 3, draw: function (c, o) { shpFork(c, o, "schiff"); } };
  SHAPE.schiffmod = { n: 3, draw: function (c, o) { shpFork(c, o, "schiffmod"); } };
  SHAPE.insidepf = { n: 3, draw: function (c, o) { shpFork(c, o, "inside"); } };

  /* --- Geometric shapes --------------------------------------------- */
  SHAPE.arrowup = { n: 1, draw: function (c, o) { if (o.xs[0] != null) shpArrowUp(c, o.xs[0], o.ys[0]); } };
  SHAPE.arrowdown = { n: 1, draw: function (c, o) { if (o.xs[0] != null) shpArrowDown(c, o.xs[0], o.ys[0]); } };

  SHAPE.rotrect = {
    n: 3, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null || xs[2] == null) return;
      var dx = xs[1] - xs[0], dy = ys[1] - ys[0];
      var L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      var vx = xs[2] - xs[0], vy = ys[2] - ys[0];
      var t = vx * ux + vy * uy;                      // drop the along-edge part
      var px = vx - t * ux, py = vy - t * uy;         // keep the offset
      shpFillPoly(ctx, [[xs[0], ys[0]], [xs[0] + dx, ys[0] + dy],
        [xs[0] + dx + px, ys[0] + dy + py], [xs[0] + px, ys[0] + py]]);
    }
  };

  SHAPE.path = { n: 2, draw: function (c, o) { shpPoly(c, o.xs, o.ys, 0, o.xs.length - 1); } };
  SHAPE.polyline = { n: 2, draw: function (c, o) { shpPoly(c, o.xs, o.ys, 0, o.xs.length - 1); } };

  SHAPE.circle = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var r = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
      ctx.beginPath(); ctx.arc(xs[0], ys[0], r, 0, Math.PI * 2);
      ctx.save(); ctx.globalAlpha = 0.12; ctx.fill(); ctx.restore();
      ctx.beginPath(); ctx.arc(xs[0], ys[0], r, 0, Math.PI * 2); ctx.stroke();
    }
  };

  SHAPE.tri = {
    n: 3, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null || xs[2] == null) return;
      shpFillPoly(ctx, [[xs[0], ys[0]], [xs[1], ys[1]], [xs[2], ys[2]]]);
    }
  };

  SHAPE.arc = {
    n: 3, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null || xs[2] == null) return;
      var c = shpCirc(xs[0], ys[0], xs[1], ys[1], xs[2], ys[2]);
      if (!c) { shpPoly(ctx, xs, ys, 0, 2); return; }
      var a1 = Math.atan2(ys[0] - c.cy, xs[0] - c.cx);
      var a2 = Math.atan2(ys[1] - c.cy, xs[1] - c.cx);
      var a3 = Math.atan2(ys[2] - c.cy, xs[2] - c.cx);
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, c.r, a1, a3, !shpBetween(a1, a3, a2));
      ctx.stroke();
    }
  };

  SHAPE.curve = {
    n: 3, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null || xs[2] == null) return;
      /* Quadratic whose control point lands so the curve passes through p2. */
      var cx = 2 * xs[1] - (xs[0] + xs[2]) / 2;
      var cy = 2 * ys[1] - (ys[0] + ys[2]) / 2;
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      ctx.quadraticCurveTo(cx, cy, xs[2], ys[2]);
      ctx.stroke();
    }
  };

  SHAPE.doublecurve = {
    n: 4, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys, i;
      for (i = 0; i < 4; i++) if (xs[i] == null) return;
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      ctx.bezierCurveTo(xs[1], ys[1], xs[2], ys[2], xs[3], ys[3]);
      ctx.stroke();
    }
  };

  /* ------------------------------------------- Fibonacci and Gann tools
     TradingView's retracement levels, plus the extended set the circular
     Fibonacci tools (circles, spiral, arcs, wedge) lay out around them. */
  var FIB_LV = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  var FIB_EXT = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1,
    1.272, 1.618, 2.618, 4.236];
  /* Gann's seven slopes: price units per bar, in TV's own labelling. */
  var GANN_LV = [[0.25, "1×4"], [1 / 3, "1×3"], [0.5, "1×2"], [1, "1×1"],
    [2, "2×1"], [3, "3×1"], [4, "4×1"]];

  /* Tiny level caption, clamped inside the overlay. */
  function shpTag(ctx, o, text, x, y, col) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    var tw = ctx.measureText(text).width + 6;
    var tx = Math.max(1, Math.min(o.w - tw - 1, x));
    var ty = Math.max(1, Math.min(o.h - 15, y));
    ctx.fillStyle = "#131722";
    ctx.globalAlpha = 0.9;
    ctx.fillRect(tx, ty, tw, 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = col || "#dbdbdb";
    ctx.fillText(text, tx + 3, ty + 11);
    ctx.restore();
  }

  /* x for a timestamp even when it sits outside the loaded bars — fib time
     zones routinely project past the last candle, where xOf() says null. */
  function shpXAt(o, t) {
    var x = o.xOf(t);
    if (x != null) return x;
    var d = o.data;
    if (!d || !d.time || d.time.length < 2) return null;
    var t0 = d.time[0], t1 = d.time[d.time.length - 1];
    var x0 = o.xOf(t0), x1 = o.xOf(t1);
    if (x0 == null || x1 == null) return null;
    var span = t1 - t0;
    if (!span) return null;
    return x0 + (x1 - x0) * ((t - t0) / span);
  }

  /* Full-height vertical line at a timestamp, captioned at the top. Lines
     that would land outside the overlay are dropped rather than let their
     caption pile up against the edge. */
  function shpTimeLine(ctx, o, time, label) {
    var x = shpXAt(o, time);
    if (x == null || !isFinite(x)) return;
    if (x < -20 || x > o.w - 20) return;
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, o.h); ctx.stroke();
    if (label != null) shpTag(ctx, o, label, x + 3, 4, o.col);
  }

  /* The seven Gann rays, fanned from (ox,oy). (bdx,bdy) is the 1×1 slope —
     the vector from the drawing's first point to its second. */
  function shpGannRays(ctx, o, ox, oy, bdx, bdy) {
    if (!bdx && !bdy) return;
    GANN_LV.forEach(function (lv) {
      var r = lv[0];
      ctx.globalAlpha = r === 1 ? 0.95 : 0.6;
      shpSeg(ctx, ox, oy, ox + bdx * 8, oy + bdy * r * 8);
      ctx.globalAlpha = 1;
      var k = Math.min(1, 1 / r);
      shpTag(ctx, o, lv[1], ox + bdx * k + 5, oy + bdy * r * k - 7, o.col);
    });
  }

  /* Quarter arc centred on the first point, passing through the second. */
  function shpGannArc(ctx, o) {
    var dx = o.xs[1] - o.xs[0], dy = o.ys[1] - o.ys[0];
    var R = Math.hypot(dx, dy);
    if (!R) return;
    var a = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.arc(o.xs[0], o.ys[0], R, a - Math.PI / 4, a + Math.PI / 4);
    ctx.stroke();
  }

  /* The tinted box every Gann square starts from. */
  function shpGannBox(ctx, o) {
    var rx = Math.min(o.xs[0], o.xs[1]), ry = Math.min(o.ys[0], o.ys[1]);
    var rw = Math.abs(o.xs[1] - o.xs[0]), rh = Math.abs(o.ys[1] - o.ys[0]);
    if (rw < 2 || rh < 2) return null;
    ctx.save();
    ctx.globalAlpha = 0.1; ctx.fillStyle = o.col;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.restore();
    ctx.strokeRect(rx, ry, rw, rh);
    return { rx: rx, ry: ry, rw: rw, rh: rh, rising: o.ys[1] < o.ys[0] };
  }

  /* Thirds grid + the trend diagonal, with 1/3 and 2/3 captions. */
  function shpGannGrid(ctx, o, b) {
    var k, yy, xx;
    ctx.globalAlpha = 0.7;
    for (k = 1; k <= 2; k++) {
      yy = b.ry + b.rh * k / 3; xx = b.rx + b.rw * k / 3;
      shpSeg(ctx, b.rx, yy, b.rx + b.rw, yy);
      shpSeg(ctx, xx, b.ry, xx, b.ry + b.rh);
    }
    ctx.globalAlpha = 1;
    var lo = b.rising ? b.ry + b.rh : b.ry;
    var hi = b.rising ? b.ry : b.ry + b.rh;
    shpSeg(ctx, b.rx, lo, b.rx + b.rw, hi);
    shpTag(ctx, o, "1/3", b.rx + 4, b.ry + b.rh / 3 - 16, o.col);
    shpTag(ctx, o, "2/3", b.rx + 4, b.ry + b.rh * 2 / 3 - 16, o.col);
    shpTag(ctx, o, "1/3", b.rx + b.rw / 3 - 12, b.ry + b.rh + 3, o.col);
    shpTag(ctx, o, "2/3", b.rx + b.rw * 2 / 3 - 12, b.ry + b.rh + 3, o.col);
  }

  /* Fibonacci channel — three parallel levels slid from p0 to p2. */
  SHAPE.fibchannel = {
    n: 3, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null || xs[2] == null) return;
      var dx = xs[1] - xs[0], dy = ys[1] - ys[0];
      if (!dx && !dy) return;
      FIB_LV.forEach(function (lv) {
        var ax = xs[0] + (xs[2] - xs[0]) * lv;
        var ay = ys[0] + (ys[2] - ys[0]) * lv;
        var e = o.extendSeg(ax, ay, ax + dx, ay + dy, o.w, o.h);
        ctx.globalAlpha = (lv === 0 || lv === 1) ? 0.95 : 0.55;
        shpSeg(ctx, e[0], e[1], e[2], e[3]);
        ctx.globalAlpha = 1;
        shpTag(ctx, o, String(lv), ax + 4, ay - 7, o.col);
      });
    }
  };

  /* Fib time zone — vertical zones a Fibonacci number of periods apart. */
  SHAPE.fibtime = {
    n: 2, draw: function (ctx, o) {
      var p0 = o.pts[0], p1 = o.pts[1];
      if (!p0 || !p1) return;
      var dt = p1.time - p0.time;
      if (!dt) return;
      shpTimeLine(ctx, o, p0.time, "0");
      [1, 2, 3, 5, 8, 13, 21, 34, 55, 89].forEach(function (z) {
        shpTimeLine(ctx, o, p0.time + dt * z, String(z));
      });
    }
  };

  /* Trend-based fib time — the trend from p0→p1, projected from p2. */
  SHAPE.fibtimeext = {
    n: 3, draw: function (ctx, o) {
      var p0 = o.pts[0], p1 = o.pts[1], p2 = o.pts[2];
      if (!p0 || !p1 || !p2) return;
      if (o.xs[0] != null && o.xs[1] != null) {
        shpSeg(ctx, o.xs[0], o.ys[0], o.xs[1], o.ys[1]);
      }
      var dt = p1.time - p0.time;
      if (!dt) return;
      shpTimeLine(ctx, o, p2.time, "0");
      [1, 2, 3, 5, 8, 13, 21, 34, 55].forEach(function (z) {
        shpTimeLine(ctx, o, p2.time + dt * z, String(z));
      });
    }
  };

  /* Fib speed resistance fan — rays to the price levels above p1. */
  SHAPE.fibfan = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      FIB_LV.forEach(function (lv, i) {
        var tx = xs[1], ty = ys[0] + (ys[1] - ys[0]) * lv;
        var e = o.extendSeg(xs[0], ys[0], tx, ty, o.w, o.h);
        ctx.globalAlpha = i % 2 === 0 ? 0.95 : 0.55;
        shpSeg(ctx, e[0], e[1], e[2], e[3]);
        ctx.globalAlpha = 1;
        shpTag(ctx, o, String(lv),
          xs[0] + (tx - xs[0]) * 0.62 + 4,
          ys[0] + (ty - ys[0]) * 0.62 - 7, o.col);
      });
      ctx.globalAlpha = 1;
      shpSeg(ctx, xs[0], ys[0], xs[1], ys[1]);
    }
  };

  /* Fib circles — concentric rings on the extended Fibonacci set. */
  SHAPE.fibcircles = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var r = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
      if (!r) return;
      FIB_EXT.forEach(function (lv, i) {
        if (!lv) return;
        ctx.globalAlpha = i % 2 === 0 ? 0.95 : 0.5;
        ctx.beginPath(); ctx.arc(xs[0], ys[0], r * lv, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        shpTag(ctx, o, String(lv),
          xs[0] + r * lv * 0.7071 - 14, ys[0] - r * lv * 0.7071 - 6, o.col);
      });
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(xs[0], ys[0], 2.5, 0, Math.PI * 2);
      ctx.fillStyle = o.col; ctx.fill();
    }
  };

  /* Fib spiral — the same rings wound into a golden-ratio spiral that
     doubles in radius with every turn. */
  SHAPE.fibspiral = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var r0 = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
      if (!r0) return;
      var PHI = (1 + Math.sqrt(5)) / 2;
      var a0 = Math.atan2(ys[1] - ys[0], xs[1] - xs[0]);
      var perTurn = 96, t0 = -1, t1 = 6, steps = perTurn * (t1 - t0);
      var i, t, ang, rr, px, py;
      ctx.beginPath();
      for (i = 0; i <= steps; i++) {
        t = t0 + i / perTurn;
        ang = a0 + t * Math.PI * 2;
        rr = r0 * Math.pow(PHI, t);
        px = xs[0] + rr * Math.cos(ang);
        py = ys[0] + rr * Math.sin(ang);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
      /* the starting ring the spiral is measured from */
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.beginPath(); ctx.arc(xs[0], ys[0], r0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  };

  /* Fib speed resistance arcs — the same rings, half-swung over the trend. */
  SHAPE.fibarcs = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var r = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
      if (!r) return;
      var a0 = Math.atan2(ys[1] - ys[0], xs[1] - xs[0]);
      FIB_EXT.forEach(function (lv, i) {
        if (!lv) return;
        ctx.globalAlpha = i % 2 === 0 ? 0.95 : 0.5;
        ctx.beginPath();
        ctx.arc(xs[0], ys[0], r * lv, a0, a0 + Math.PI);
        ctx.stroke();
        ctx.globalAlpha = 1;
        var am = a0 + Math.PI / 2;
        shpTag(ctx, o, String(lv),
          xs[0] + r * lv * Math.cos(am) - 14,
          ys[0] + r * lv * Math.sin(am) - 6, o.col);
      });
      ctx.globalAlpha = 1;
      var e = o.extendSeg(xs[0], ys[0], xs[1], ys[1], o.w, o.h);
      shpSeg(ctx, e[0], e[1], e[2], e[3]);
    }
  };

  /* Fib wedge — a quarter-turn of the same rings. */
  SHAPE.fibwedge = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var r = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
      if (!r) return;
      var a0 = Math.atan2(ys[1] - ys[0], xs[1] - xs[0]);
      var a1 = a0 + Math.PI / 2;
      var far = (o.w + o.h) * 2;
      var e1 = o.extendSeg(xs[0], ys[0],
        xs[0] + far * Math.cos(a0), ys[0] + far * Math.sin(a0), o.w, o.h);
      var e2 = o.extendSeg(xs[0], ys[0],
        xs[0] + far * Math.cos(a1), ys[0] + far * Math.sin(a1), o.w, o.h);
      shpSeg(ctx, e1[0], e1[1], e1[2], e1[3]);
      shpSeg(ctx, e2[0], e2[1], e2[2], e2[3]);
      FIB_EXT.forEach(function (lv, i) {
        if (!lv) return;
        ctx.globalAlpha = i % 2 === 0 ? 0.95 : 0.5;
        ctx.beginPath(); ctx.arc(xs[0], ys[0], r * lv, a0, a1);
        ctx.stroke();
        ctx.globalAlpha = 1;
        var am = a0 + Math.PI / 4;
        shpTag(ctx, o, String(lv),
          xs[0] + r * lv * Math.cos(am) - 14,
          ys[0] + r * lv * Math.sin(am) - 6, o.col);
      });
      ctx.globalAlpha = 1;
    }
  };

  /* Pitchfan — a fan of levels spanning the angle between two anchors. */
  SHAPE.pitchfan = {
    n: 3, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null || xs[2] == null) return;
      var ox = xs[0], oy = ys[0];
      var a1 = Math.atan2(ys[1] - oy, xs[1] - ox);
      var a2 = Math.atan2(ys[2] - oy, xs[2] - ox);
      var dA = a2 - a1;
      while (dA > Math.PI) dA -= Math.PI * 2;
      while (dA < -Math.PI) dA += Math.PI * 2;
      var reach = (o.w + o.h) * 2;
      var arm = Math.max(30, Math.hypot(xs[1] - ox, ys[1] - oy));
      FIB_LV.forEach(function (lv, i) {
        var ang = a1 + dA * lv;
        ctx.globalAlpha = i % 2 === 0 ? 0.95 : 0.5;
        shpSeg(ctx, ox, oy, ox + reach * Math.cos(ang), oy + reach * Math.sin(ang));
        ctx.globalAlpha = 1;
        if (lv > 0 && lv < 1) {
          shpTag(ctx, o, String(lv),
            ox + arm * Math.cos(ang) + 5, oy + arm * Math.sin(ang) - 7, o.col);
        }
      });
      ctx.globalAlpha = 1;
      shpSeg(ctx, ox, oy, xs[1], ys[1]);
      shpSeg(ctx, ox, oy, xs[2], ys[2]);
      var am = Math.atan2((ys[1] + ys[2]) / 2 - oy,
        (xs[1] + xs[2]) / 2 - ox);
      shpSeg(ctx, ox, oy, ox + reach * Math.cos(am), oy + reach * Math.sin(am));
    }
  };

  /* Gann box — the tinted square with its thirds grid and trend diagonal. */
  SHAPE.gannbox = {
    n: 2, draw: function (ctx, o) {
      if (o.xs[0] == null || o.xs[1] == null) return;
      var b = shpGannBox(ctx, o);
      if (b) shpGannGrid(ctx, o, b);
    }
  };

  /* Gann square — box plus the angle rays and their arc. */
  SHAPE.gannsquare = {
    n: 2, draw: function (ctx, o) {
      if (o.xs[0] == null || o.xs[1] == null) return;
      var b = shpGannBox(ctx, o);
      if (!b) return;
      shpGannGrid(ctx, o, b);
      shpGannArc(ctx, o);
      shpGannRays(ctx, o, o.xs[0], o.ys[0], o.xs[1] - o.xs[0], o.ys[1] - o.ys[0]);
    }
  };

  /* Gann square fixed — rays and arc on a fixed square, no thirds grid. */
  SHAPE.gannfixed = {
    n: 2, draw: function (ctx, o) {
      if (o.xs[0] == null || o.xs[1] == null) return;
      shpGannArc(ctx, o);
      shpGannRays(ctx, o, o.xs[0], o.ys[0], o.xs[1] - o.xs[0], o.ys[1] - o.ys[0]);
      [0, 1].forEach(function (i) {
        ctx.beginPath();
        ctx.arc(o.xs[i], o.ys[i], 4, 0, Math.PI * 2);
        ctx.fillStyle = o.col; ctx.fill();
        ctx.strokeStyle = "#131722"; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.strokeStyle = o.col; ctx.lineWidth = o.lw;
      });
    }
  };

  /* Gann fan — the seven slopes on their own. */
  SHAPE.gannfan = {
    n: 2, draw: function (ctx, o) {
      if (o.xs[0] == null || o.xs[1] == null) return;
      shpGannRays(ctx, o, o.xs[0], o.ys[0], o.xs[1] - o.xs[0], o.ys[1] - o.ys[0]);
    }
  };

  /* --------------------------------------- patterns, Elliott waves, cycles
     Every chart pattern and Elliott count in TradingView is the same drawing
     underneath: a labelled zigzag. `shpWave` renders it — a tinted silhouette
     under each leg (chart patterns only), a dot on each vertex and a tag
     naming it. `labels` are aligned to the point index, so an empty leading
     string leaves the origin unlabelled the way TV's Elliott tools do. */
  function shpWave(ctx, o, labels, shade) {
    var xs = o.xs, ys = o.ys, i;
    var n = Math.min(xs.length, labels.length);
    if (n < 2) return;
    for (i = 0; i < n; i++) if (xs[i] == null) return;
    if (shade) {
      for (i = 0; i + 1 < n; i++) {
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.beginPath();
        ctx.moveTo(xs[i], ys[i]);
        ctx.lineTo(xs[i + 1], ys[i + 1]);
        ctx.lineTo(xs[i + 1], ys[i]);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    shpPoly(ctx, xs, ys, 0, n - 1);
    for (i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(xs[i], ys[i], 3, 0, Math.PI * 2);
      ctx.fillStyle = o.col;
      ctx.fill();
      if (labels[i]) shpTag(ctx, o, labels[i], xs[i] + 5, ys[i] - 17, o.col);
    }
  }

  /* Two converging trendlines through the alternate vertices of a triangle. */
  function shpTriBounds(ctx, o, n) {
    var xs = o.xs, ys = o.ys, i;
    if (xs.length < n) return;
    for (i = 0; i < n; i++) if (xs[i] == null) return;
    ctx.save();
    ctx.globalAlpha = 0.75;
    for (i = 0; i + 2 < n; i += 2) shpSeg(ctx, xs[i], ys[i], xs[i + 2], ys[i + 2]);
    for (i = 1; i + 2 < n; i += 2) shpSeg(ctx, xs[i], ys[i], xs[i + 2], ys[i + 2]);
    ctx.restore();
  }

  SHAPE.cypher = {
    n: 5, draw: function (ctx, o) { shpWave(ctx, o, ["X", "A", "B", "C", "D"], true); }
  };

  SHAPE.abcd = {
    n: 4, draw: function (ctx, o) { shpWave(ctx, o, ["A", "B", "C", "D"], true); }
  };

  SHAPE.tripattern = {
    n: 6, draw: function (ctx, o) {
      shpTriBounds(ctx, o, 6);
      shpWave(ctx, o, ["A", "B", "C", "D", "E", "F"], true);
    }
  };

  SHAPE.threedrivers = {
    n: 7, draw: function (ctx, o) { shpWave(ctx, o, ["0", "1", "2", "3", "4", "5", "6"], true); }
  };

  SHAPE.elliot5 = {
    n: 6, draw: function (ctx, o) { shpWave(ctx, o, ["", "1", "2", "3", "4", "5"], false); }
  };

  SHAPE.elliot3 = {
    n: 4, draw: function (ctx, o) { shpWave(ctx, o, ["", "A", "B", "C"], false); }
  };

  SHAPE.elliottri = {
    n: 6, draw: function (ctx, o) { shpWave(ctx, o, ["", "A", "B", "C", "D", "E"], false); }
  };

  SHAPE.elliotwxy = {
    n: 4, draw: function (ctx, o) { shpWave(ctx, o, ["", "W", "X", "Y"], false); }
  };

  SHAPE.elliotwxyxz = {
    n: 6, draw: function (ctx, o) { shpWave(ctx, o, ["", "W", "X", "Y", "X", "Z"], false); }
  };

  /* Cyclic lines — a full-height rule at every cycle from the first point. */
  SHAPE.cycliclines = {
    n: 2, draw: function (ctx, o) {
      var p0 = o.pts[0], p1 = o.pts[1];
      if (!p0 || !p1) return;
      var dt = p1.time - p0.time;
      if (!dt) return;
      shpTimeLine(ctx, o, p0.time, "0");
      for (var i = 1; i <= 40; i++) shpTimeLine(ctx, o, p0.time + dt * i, String(i));
    }
  };

  /* Time cycles — the same period, but walked along the axis as circles. */
  SHAPE.timecycles = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var p0 = o.pts[0], p1 = o.pts[1];
      if (!p0 || !p1) return;
      var dt = p1.time - p0.time;
      if (!dt) return;
      var r = Math.abs(ys[1] - ys[0]) / 2;
      var cy = (ys[0] + ys[1]) / 2;
      if (!r) return;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(o.w, cy);
      ctx.globalAlpha = 0.45; ctx.stroke();
      ctx.restore();
      for (var i = 0; i <= 40; i++) {
        var x = shpXAt(o, p0.time + dt * i);
        if (x == null || !isFinite(x)) continue;
        if (x < -r - 20 || x > o.w + r + 20) continue;
        ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2);
        ctx.save();
        ctx.globalAlpha = i === 0 ? 0.95 : 0.55;
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  /* Sine line — one period per the two anchors, run clear across the pane. */
  SHAPE.sine = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var period = Math.abs(xs[1] - xs[0]);
      if (!period) return;
      var mid = (ys[0] + ys[1]) / 2, amp = (ys[1] - ys[0]) / 2;
      var start = Math.min(xs[0], xs[1]);
      ctx.beginPath();
      for (var x = 0; x <= o.w; x += 2) {
        var y = mid + amp * Math.sin((x - start) / period * Math.PI * 2);
        if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(o.w, mid); ctx.stroke();
      ctx.restore();
    }
  };

  /* ------------------------------------------------ forecasting and volume
     Index of the bar at a timestamp, clamped into the loaded series. */
  function shpIdx(o, t) {
    var i = o.barIndexAt(t);
    if (i == null || i < 0) return 0;
    if (i > o.data.n - 1) return o.data.n - 1;
    return i;
  }

  /* First bar at or after `from` that lands on screen, found by bisection so
     the walks below never touch every bar of a 200k-bar history. */
  function shpFirstVisible(o, from) {
    var d = o.data, lo = from, hi = d.n - 1, best = from, mid, x;
    while (lo <= hi) {
      mid = (lo + hi) >> 1;
      x = o.xOf(d.time[mid]);
      if (x != null && x >= -60) { best = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return best;
  }

  /* Re-draw the bars of i0…i1 again and again, walking right off the end of
     the source range until the overlay runs out of room. `ghost` renders the
     candles as hollow outlines in the drawing colour, which is exactly how
     TradingView's ghost feed differs from its bars pattern. */
  function shpReplicate(ctx, o, i0, i1, ghost) {
    var d = o.data, span = i1 - i0 + 1;
    if (span < 1) return;
    var x0 = Math.min(o.xs[0], o.xs[1]), x1 = Math.max(o.xs[0], o.xs[1]);
    var step = (x1 - x0) / span;
    if (!(step > 0)) step = 6;
    var bw = Math.max(1.5, step * 0.7);
    var done = false, guard = 0, c, i, src, dx;
    ctx.save();
    for (c = 0; c < 40 && !done; c++) {
      for (i = 0; i < span && !done; i++) {
        src = i0 + i;
        dx = x1 + step * (c * span + i + 0.5);
        if (dx > o.w + 4) { done = true; break; }
        if (dx < -4) continue;
        var yo = o.yOf(d.open[src]), yh = o.yOf(d.high[src]);
        var yl = o.yOf(d.low[src]), yc = o.yOf(d.close[src]);
        if (yo == null || yh == null || yl == null || yc == null) continue;
        var bull = d.close[src] >= d.open[src];
        ctx.globalAlpha = ghost ? (c ? 0.5 : 0.9) : (c ? 0.55 : 1);
        ctx.strokeStyle = ghost ? o.col : (bull ? "#089981" : "#f23645");
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(dx, yh); ctx.lineTo(dx, yl);
        ctx.stroke();
        var top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
        if (ghost) {
          ctx.save();
          ctx.globalAlpha *= 0.18;
          ctx.fillRect(dx - bw / 2, top, bw, hgt);
          ctx.restore();
        } else {
          ctx.fillRect(dx - bw / 2, top, bw, hgt);
        }
        if (++guard > 4000) done = true;
      }
    }
    ctx.restore();
  }

  /* Volume-by-price buckets for bars i0…i1, spread uniformly across each
     bar's own high–low span the way TradingView builds a profile. */
  function shpVolBuckets(o, i0, i1, BUCKETS) {
    var d = o.data, i;
    if (i1 <= i0) return null;
    var lo = Infinity, hi = -Infinity;
    for (i = i0; i <= i1; i++) {
      if (d.low[i] < lo) lo = d.low[i];
      if (d.high[i] > hi) hi = d.high[i];
    }
    if (!isFinite(lo) || !isFinite(hi) || !(hi > lo)) return null;
    var span = hi - lo, b = [], poc = 0, maxV = 0;
    for (i = 0; i < BUCKETS; i++) b.push(0);
    for (i = i0; i <= i1; i++) {
      var v = d.volume[i] || 0;
      var k1 = Math.floor((d.low[i] - lo) / span * (BUCKETS - 1));
      var k2 = Math.floor((d.high[i] - lo) / span * (BUCKETS - 1));
      k1 = k1 < 0 ? 0 : (k1 > BUCKETS - 1 ? BUCKETS - 1 : k1);
      k2 = k2 < 0 ? 0 : (k2 > BUCKETS - 1 ? BUCKETS - 1 : k2);
      if (k2 < k1) { var s = k1; k1 = k2; k2 = s; }
      var per = v / (k2 - k1 + 1);
      for (var k = k1; k <= k2; k++) b[k] += per;
    }
    for (i = 0; i < BUCKETS; i++) if (b[i] > maxV) { maxV = b[i]; poc = i; }
    if (!maxV) return null;
    return { b: b, maxV: maxV, poc: poc, lo: lo, hi: hi, n: BUCKETS };
  }

  /* Lay a profile out as horizontal bars growing right from `x0`. */
  function shpVolBars(ctx, o, prof, x0, width) {
    if (!prof) return;
    var yHi = o.yOf(prof.hi), yLo = o.yOf(prof.lo);
    var bh = (yHi != null && yLo != null)
      ? Math.max(2, Math.abs(yHi - yLo) / prof.n + 1)
      : Math.max(2, o.h / prof.n * 0.85);
    ctx.save();
    for (var i = 0; i < prof.n; i++) {
      var price = prof.hi - (prof.hi - prof.lo) * (i + 0.5) / prof.n;
      var y = o.yOf(price);
      if (y == null) continue;
      var len = width * (prof.b[i] / prof.maxV);
      if (len < 0.5) continue;
      ctx.globalAlpha = i === prof.poc ? 0.95 : 0.5;
      ctx.fillRect(x0, y - bh / 2, len, bh);
    }
    ctx.globalAlpha = 1;
    var py = o.yOf(prof.hi - (prof.hi - prof.lo) * (prof.poc + 0.5) / prof.n);
    if (py != null) shpTag(ctx, o, "POC", x0 + 4, py - 16, o.col);
    ctx.restore();
  }

  /* Position forecast — a cone opening out from the anchor to the edge. */
  SHAPE.forecast = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var x0 = xs[0], y0 = ys[0], dx = xs[1] - xs[0], dy = ys[1] - ys[0];
      if (!dx) return;
      var right = dx > 0 ? o.w : 0;
      var f = (right - x0) / dx;
      if (!isFinite(f) || f <= 0) return;
      var proj = Math.min(f, 5);
      var midY = y0 + dy * proj;
      if (midY < o.h * 0.12) midY = o.h * 0.12;
      else if (midY > o.h * 0.88) midY = o.h * 0.88;
      var half = Math.abs(dy) * proj * 0.9 || 36;
      if (half > o.h * 0.25) half = o.h * 0.25;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(right, midY - half);
      ctx.lineTo(right, midY + half);
      ctx.closePath();
      ctx.globalAlpha = 0.13; ctx.fillStyle = o.col; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(right, midY - half);
      ctx.moveTo(x0, y0); ctx.lineTo(right, midY + half);
      ctx.stroke();
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(right, midY); ctx.stroke();
      ctx.restore();
      shpTag(ctx, o, "forecast", right - 74, midY - half - 17, o.col);
    }
  };

  /* Bars pattern — the chosen bars, replayed forward to the right. */
  SHAPE.barspattern = {
    n: 2, draw: function (ctx, o) {
      if (o.xs[0] == null || o.xs[1] == null || !o.data) return;
      var i0 = shpIdx(o, o.pts[0].time), i1 = shpIdx(o, o.pts[1].time);
      if (i1 < i0) { var t = i0; i0 = i1; i1 = t; }
      var x0 = Math.min(o.xs[0], o.xs[1]), x1 = Math.max(o.xs[0], o.xs[1]);
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = o.col;
      ctx.strokeRect(x0 + 0.5, Math.min(o.ys[0], o.ys[1]) + 0.5,
        Math.max(2, x1 - x0 - 1), Math.max(2, Math.abs(o.ys[1] - o.ys[0]) - 1));
      ctx.restore();
      shpReplicate(ctx, o, i0, i1, false);
    }
  };

  /* Ghost feed — the same replay, drawn as hollow forecast candles. */
  SHAPE.ghostfeed = {
    n: 2, draw: function (ctx, o) {
      if (o.xs[0] == null || o.xs[1] == null || !o.data) return;
      var i0 = shpIdx(o, o.pts[0].time), i1 = shpIdx(o, o.pts[1].time);
      if (i1 < i0) { var t = i0; i0 = i1; i1 = t; }
      shpReplicate(ctx, o, i0, i1, true);
    }
  };

  /* Sector — a filled pie wedge swept from the first point to the third. */
  SHAPE.sector = {
    n: 3, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null || xs[2] == null) return;
      var R = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
      if (!R) return;
      var a1 = Math.atan2(ys[1] - ys[0], xs[1] - xs[0]);
      var a2 = Math.atan2(ys[2] - ys[0], xs[2] - xs[0]);
      var dA = a2 - a1;
      while (dA > Math.PI) dA -= Math.PI * 2;
      while (dA < -Math.PI) dA += Math.PI * 2;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      ctx.arc(xs[0], ys[0], R, a1, a2, dA < 0);
      ctx.closePath();
      ctx.globalAlpha = 0.14; ctx.fillStyle = o.col; ctx.fill();
      ctx.globalAlpha = 1; ctx.stroke();
      ctx.restore();
      var far = (o.w + o.h) * 2;
      [a1, a2].forEach(function (a) {
        var e = o.extendSeg(xs[0], ys[0],
          xs[0] + far * Math.cos(a), ys[0] + far * Math.sin(a), o.w, o.h);
        ctx.beginPath(); ctx.moveTo(e[0], e[1]); ctx.lineTo(e[2], e[3]);
        ctx.stroke();
      });
    }
  };

  /* Anchored VWAP — cumulative typical price weighted by volume from the
     anchor bar to the newest one. */
  SHAPE.avwap = {
    n: 1,
    hit: function (g, x) {
      if (g.xs[0] == null) return null;
      return Math.abs(x - g.xs[0]) <= 9 ? -1 : null;
    },
    draw: function (ctx, o) {
      if (!o.data || !o.data.n) return;
      var d = o.data, i0 = shpIdx(o, o.pts[0].time), i, anyVol = false;
      for (i = i0; i < d.n; i++) if (d.volume[i]) { anyVol = true; break; }
      var start = shpFirstVisible(o, i0);
      var pv = 0, vv = 0, started = false, lx = 0, ly = 0;
      ctx.beginPath();
      for (i = i0; i < d.n; i++) {
        var tp = (d.high[i] + d.low[i] + d.close[i]) / 3;
        var v = anyVol ? (d.volume[i] || 0) : 1;
        pv += tp * v; vv += v;
        if (i < start || !vv) continue;
        var x = o.xOf(d.time[i]);
        if (x == null) continue;
        if (x > o.w + 60) break;
        if (x < -60) continue;
        var y = o.yOf(pv / vv);
        if (y == null) continue;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        lx = x; ly = y;
      }
      if (started) {
        ctx.stroke();
        if (vv) shpTag(ctx, o, o.fmtPrice(pv / vv), lx - 54, ly - 16, o.col);
      }
      var ax = o.xOf(d.time[i0]);
      if (ax != null) {
        ctx.beginPath();
        ctx.arc(ax, o.ys[0] == null ? o.h / 2 : o.ys[0], 3.5, 0, Math.PI * 2);
        ctx.fillStyle = o.col; ctx.fill();
      }
    }
  };

  /* Fixed range volume profile — a profile over the chosen bar range. */
  SHAPE.frvp = {
    n: 2, draw: function (ctx, o) {
      if (!o.data || o.xs[1] == null || !o.pts[1]) return;
      var i0 = shpIdx(o, o.pts[0].time), i1 = shpIdx(o, o.pts[1].time);
      if (i1 < i0) { var t = i0; i0 = i1; i1 = t; }
      var x0 = Math.min(o.xs[0], o.xs[1]), x1 = Math.max(o.xs[0], o.xs[1]);
      var prof = shpVolBuckets(o, i0, i1, 42);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = o.col;
      ctx.strokeRect(x0 + 0.5, Math.min(o.ys[0], o.ys[1]) + 0.5,
        Math.max(2, x1 - x0 - 1), Math.max(2, Math.abs(o.ys[1] - o.ys[0]) - 1));
      ctx.restore();
      if (prof) shpVolBars(ctx, o, prof, x0 + 3, Math.max(40, (x1 - x0) * 0.55));
    }
  };

  /* Anchored volume profile — one anchor bar, profiled to the newest bar. */
  SHAPE.avp = {
    n: 1,
    hit: function (g, x) {
      if (g.xs[0] == null) return null;
      return Math.abs(x - g.xs[0]) <= 9 ? -1 : null;
    },
    draw: function (ctx, o) {
      if (!o.data) return;
      var i0 = shpIdx(o, o.pts[0].time);
      var prof = shpVolBuckets(o, i0, o.data.n - 1, 42);
      var ax = o.xOf(o.data.time[i0]);
      if (ax != null) {
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, o.h);
        ctx.strokeStyle = o.col; ctx.stroke();
        ctx.restore();
      }
      var x0 = ax == null ? 0 : ax;
      var width = Math.min(140, Math.max(40, o.w - x0 - 6));
      if (x0 + width > o.w - 4) x0 = Math.max(2, o.w - 4 - width);
      if (prof) shpVolBars(ctx, o, prof, x0 + 3, width - 6);
    }
  };

  /* Date and price range — one box that reports both its span and its move. */
  SHAPE.dpr = {
    n: 2, draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var x0 = Math.min(xs[0], xs[1]), x1 = Math.max(xs[0], xs[1]);
      var y0 = Math.min(ys[0], ys[1]), y1 = Math.max(ys[0], ys[1]);
      if (x1 - x0 < 2 || y1 - y0 < 2) return;
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = o.col;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
      ctx.globalAlpha = 0.85;
      var bx = x1 - 14;
      ctx.beginPath();
      ctx.moveTo(bx, y0); ctx.lineTo(bx + 6, y0);
      ctx.lineTo(bx + 6, y1); ctx.lineTo(bx, y1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0, y1 - 9); ctx.lineTo(x0, y1 - 3);
      ctx.lineTo(x1, y1 - 3); ctx.lineTo(x1, y1 - 9);
      ctx.stroke();
      ctx.globalAlpha = 1;
      var pA = o.pts[0].price, pB = o.pts[1].price;
      var dP = pB - pA, pct = pA ? (dP / pA) * 100 : 0;
      var sign = dP >= 0 ? "+" : "\u2212";
      var nb = Math.abs(shpIdx(o, o.pts[1].time) - shpIdx(o, o.pts[0].time));
      o.labelBox([
        [sign + o.fmtPrice(Math.abs(dP)), dP >= 0 ? "#26a69a" : "#f23645"],
        [sign + Math.abs(pct).toFixed(2) + "%", "#b8b8b8"],
        [nb + " bar" + (nb === 1 ? "" : "s") + " \u00b7 " +
          o.durTxt(Math.abs(o.pts[1].time - o.pts[0].time)), "#dbdbdb"]
      ], (x0 + x1) / 2 - 46, (y0 + y1) / 2 - 24);
      ctx.restore();
    }
  };

  /* ------------------------------------------------- text, notes, content
     Rounded rectangle path used by the note-style annotations. */
  function shpRound(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    if (r < 0) r = 0;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* Selection box for the one-point annotations: an area hung off the
     anchor, big enough to grab without swallowing the whole pane. */
  function shpAnchorHit(boxW, boxH) {
    return function (g, x, y) {
      if (g.xs[0] == null || g.ys[0] == null) return null;
      var x0 = g.xs[0] - 6, y0 = g.ys[0] - (boxH || 40);
      var bw = (boxW || 64) + 12;
      return (x >= x0 && x <= x0 + bw && y >= y0 && y <= g.ys[0] + 10) ? -1 : null;
    };
  }

  /* Price note — the level, its value and the note beneath it. */
  SHAPE.pricenote = {
    n: 1,
    hit: shpAnchorHit(104, 46),
    draw: function (ctx, o) {
      if (o.xs[0] == null || o.ys[0] == null) return;
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(o.xs[0], o.ys[0]);
      ctx.lineTo(o.xs[0] + 78, o.ys[0]);
      ctx.stroke();
      ctx.restore();
      o.labelBox([
        [o.fmtPrice(o.pts[0].price), o.col],
        [(o.d && o.d.text) || "note", "#b8b8b8"]
      ], o.xs[0] + 8, o.ys[0] - 46);
    }
  };

  /* Pin — a map pin with a caption beside it. */
  SHAPE.pin = {
    n: 1,
    hit: shpAnchorHit(72, 48),
    draw: function (ctx, o) {
      if (o.xs[0] == null || o.ys[0] == null) return;
      var cx = o.xs[0], cy = o.ys[0] - 15;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 9, Math.PI, 0);
      ctx.lineTo(cx, cy + 20);
      ctx.closePath();
      ctx.fillStyle = o.col; ctx.fill();
      ctx.strokeStyle = "#131722"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
      var t = (o.d && o.d.text) || "Pin";
      o.labelBox([[t, "#dbdbdb"]], cx + 14, cy - 18);
    }
  };

  /* Comment — a speech balloon with three dots in it. */
  SHAPE.comment = {
    n: 1,
    hit: shpAnchorHit(46, 44),
    draw: function (ctx, o) {
      if (o.xs[0] == null || o.ys[0] == null) return;
      var x = o.xs[0], y = o.ys[0] - 34, w = 32, h = 22;
      ctx.save();
      ctx.fillStyle = o.col;
      shpRound(ctx, x, y, w, h, 6);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + 7, y + h - 2);
      ctx.lineTo(x + 5, y + h + 8);
      ctx.lineTo(x + 16, y + h - 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#131722";
      for (var i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(x + 9 + i * 7, y + h / 2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      var t = o.d && o.d.text;
      if (t) o.labelBox([[t, "#dbdbdb"]], x + w + 8, y);
    }
  };

  /* Flag mark — a pennant on a pole. */
  SHAPE.flag = {
    n: 1,
    hit: shpAnchorHit(56, 48),
    draw: function (ctx, o) {
      if (o.xs[0] == null || o.ys[0] == null) return;
      var x = o.xs[0], y = o.ys[0];
      ctx.save();
      ctx.strokeStyle = o.col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 34); ctx.stroke();
      ctx.fillStyle = o.col;
      ctx.beginPath();
      ctx.moveTo(x + 1, y - 34);
      ctx.lineTo(x + 26, y - 27);
      ctx.lineTo(x + 1, y - 20);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y - 2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      var t = o.d && o.d.text;
      if (t) o.labelBox([[t, "#dbdbdb"]], x + 30, y - 44);
    }
  };

  /* Signpost — a caption board on a post. */
  SHAPE.signpost = {
    n: 1,
    hit: shpAnchorHit(96, 54),
    draw: function (ctx, o) {
      if (o.xs[0] == null || o.ys[0] == null) return;
      var x = o.xs[0], y = o.ys[0];
      var t = (o.d && o.d.text) || "Signpost";
      ctx.save();
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      var tw = Math.max(52, ctx.measureText(t).width + 16);
      ctx.strokeStyle = o.col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 32); ctx.stroke();
      ctx.fillStyle = o.col;
      shpRound(ctx, x + 1, y - 52, tw, 24, 4);
      ctx.fill();
      ctx.fillStyle = "#131722";
      ctx.fillText(t, x + 9, y - 35);
      ctx.restore();
    }
  };

  /* Table — a shaded header over a simple grid. */
  SHAPE.table = {
    n: 2,
    draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var x0 = Math.min(xs[0], xs[1]), x1 = Math.max(xs[0], xs[1]);
      var y0 = Math.min(ys[0], ys[1]), y1 = Math.max(ys[0], ys[1]);
      if (x1 - x0 < 24 || y1 - y0 < 24) return;
      var COLS = 3, ROWS = 5;
      var cw = (x1 - x0) / COLS, rh = (y1 - y0) / ROWS, c, r;
      ctx.save();
      ctx.fillStyle = "#131722";
      ctx.globalAlpha = 0.94;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = o.col;
      ctx.fillRect(x0, y0, x1 - x0, rh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#3a3a3a";
      ctx.lineWidth = 1;
      for (c = 1; c < COLS; c++) {
        ctx.beginPath();
        ctx.moveTo(x0 + c * cw, y0); ctx.lineTo(x0 + c * cw, y1);
        ctx.stroke();
      }
      for (r = 1; r < ROWS; r++) {
        ctx.beginPath();
        ctx.moveTo(x0, y0 + r * rh); ctx.lineTo(x1, y0 + r * rh);
        ctx.stroke();
      }
      ctx.strokeStyle = o.col;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
      ctx.fillStyle = "#dbdbdb";
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText((o.d && o.d.text) || "Table", x0 + 7, y0 + rh * 0.68);
      ctx.restore();
    }
  };

  /* Callout — a caption bubble reached by a leader from the anchor. */
  SHAPE.callout = {
    n: 2,
    draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var txt = (o.d && o.d.text) || "Callout";
      ctx.save();
      ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
      var tw = ctx.measureText(txt).width;
      ctx.restore();
      var bw = tw + 20, bh = 34;
      var bx = o.clamp(xs[1] - bw / 2, 2, Math.max(2, o.w - bw - 2));
      var by = o.clamp(ys[1] - bh - 14, 2, Math.max(2, o.h - bh - 2));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      ctx.lineTo(o.clamp(xs[1], bx, bx + bw), o.clamp(ys[1], by, by + bh));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(xs[0], ys[0], 3.5, 0, Math.PI * 2);
      ctx.fillStyle = o.col; ctx.fill();
      ctx.globalAlpha = 0.96;
      ctx.fillStyle = "#131722";
      shpRound(ctx, bx, by, bw, bh, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = o.col; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#dbdbdb";
      ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(txt, bx + 10, by + 21);
      ctx.restore();
    }
  };

  /* Image — a framed picture slot with the landscape mark TV uses. */
  SHAPE.image = {
    n: 2,
    draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var x0 = Math.min(xs[0], xs[1]), x1 = Math.max(xs[0], xs[1]);
      var y0 = Math.min(ys[0], ys[1]), y1 = Math.max(ys[0], ys[1]);
      if (x1 - x0 < 18 || y1 - y0 < 18) return;
      ctx.save();
      ctx.fillStyle = "#1a1a1a";
      ctx.globalAlpha = 0.96;
      shpRound(ctx, x0, y0, x1 - x0, y1 - y0, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#3a3a3a"; ctx.lineWidth = 1;
      ctx.stroke();
      var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      var s = Math.max(8, Math.min(x1 - x0, y1 - y0) * 0.26);
      ctx.strokeStyle = "#5a5a5a"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx + s * 0.5, cy - s * 0.5, s * 0.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - s, cy + s * 0.7);
      ctx.lineTo(cx - s * 0.2, cy - s * 0.35);
      ctx.lineTo(cx + s * 0.35, cy + s * 0.2);
      ctx.lineTo(cx + s * 0.7, cy - s * 0.1);
      ctx.lineTo(cx + s, cy + s * 0.7);
      ctx.stroke();
      ctx.restore();
      var cap = o.d && o.d.text;
      if (cap) o.labelBox([[cap, "#dbdbdb"]], x0 + 5, y1 - 21);
    }
  };

  /* Post — a social-post card: avatar, name bar and body lines. */
  SHAPE.post = {
    n: 2,
    draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var x0 = Math.min(xs[0], xs[1]), x1 = Math.max(xs[0], xs[1]);
      var y0 = Math.min(ys[0], ys[1]), y1 = Math.max(ys[0], ys[1]);
      if (x1 - x0 < 60 || y1 - y0 < 40) return;
      ctx.save();
      ctx.fillStyle = "#131722";
      ctx.globalAlpha = 0.96;
      shpRound(ctx, x0, y0, x1 - x0, y1 - y0, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#3a3a3a"; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x0 + 18, y0 + 18, 10, 0, Math.PI * 2);
      ctx.fillStyle = o.col; ctx.globalAlpha = 0.85; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#4a4a4a";
      ctx.fillRect(x0 + 34, y0 + 12, Math.min(70, (x1 - x0) * 0.35), 6);
      var body = (o.d && o.d.text) || "";
      ctx.fillStyle = "#5a5a5a";
      var lines = Math.min(4, Math.max(2, Math.floor((y1 - y0 - 40) / 12)));
      for (var i = 0; i < lines; i++) {
        ctx.fillRect(x0 + 12, y0 + 36 + i * 12,
          (x1 - x0 - 24) * (i === lines - 1 ? 0.55 : 0.9), 6);
      }
      ctx.restore();
      if (body) o.labelBox([[body, "#dbdbdb"]], x0 + 6, y1 - 21);
    }
  };

  /* Idea — TV's idea card: a header strip over a sparkline. */
  SHAPE.idea = {
    n: 2,
    draw: function (ctx, o) {
      var xs = o.xs, ys = o.ys;
      if (xs[0] == null || xs[1] == null) return;
      var x0 = Math.min(xs[0], xs[1]), x1 = Math.max(xs[0], xs[1]);
      var y0 = Math.min(ys[0], ys[1]), y1 = Math.max(ys[0], ys[1]);
      if (x1 - x0 < 70 || y1 - y0 < 46) return;
      ctx.save();
      ctx.fillStyle = "#131722";
      ctx.globalAlpha = 0.96;
      shpRound(ctx, x0, y0, x1 - x0, y1 - y0, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#3a3a3a"; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = o.col;
      ctx.fillRect(x0 + 1, y0 + 1, x1 - x0 - 2, 18);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#4a4a4a";
      ctx.fillRect(x0 + 8, y0 + 7, Math.min(64, (x1 - x0) * 0.4), 6);
      /* sparkline across the lower two thirds */
      var pad = 10;
      var px0 = x0 + pad, px1 = x1 - pad;
      var py0 = y0 + 30, py1 = y1 - 10;
      if (px1 > px0 && py1 > py0) {
        ctx.beginPath();
        var steps = 24;
        for (var i = 0; i <= steps; i++) {
          var t = i / steps;
          var px = px0 + (px1 - px0) * t;
          var wobble = Math.sin(t * Math.PI * 3.2) * 0.55 + Math.sin(t * Math.PI * 7.5) * 0.25;
          var py = (py0 + py1) / 2 - wobble * (py1 - py0) * 0.8 - (t - 0.5) * (py1 - py0) * 0.5;
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.strokeStyle = o.col;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
      var t2 = o.d && o.d.text;
      if (t2) o.labelBox([[t2, "#dbdbdb"]], x0 + 6, y1 - 21);
    }
  };

  /* One-point drawings place on a single click. */
  var ONE_POINT = {
    hline: 1, hray: 1, vline: 1, text: 1, note: 1, pricelabel: 1, sticker: 1,
    marker: 1, arrowup: 1, arrowdown: 1,
    pricenote: 1, pin: 1, comment: 1, signpost: 1, flag: 1
  };
  /* Drawings whose label the user can type (and re-edit by double-clicking). */
  var TEXTY = {
    text: 1, note: 1, pricelabel: 1, sticker: 1,
    pricenote: 1, pin: 1, table: 1, callout: 1, comment: 1,
    signpost: 1, flag: 1, image: 1, post: 1, idea: 1
  };

  /* TradingView's left rail is a column of *tool groups*: one button per
     group showing the group's last-used tool, with a small triangle that opens
     a flyout of every tool in that group. The group order, section headers and
     item labels below mirror the live TradingView rail's flyout menus. */
  var TOOL_GROUPS = [
    { id: "cursor", sections: [[null, ["cursor", "dot", "cursarrow", "demo", "magic", "delete"]]] },
    { id: "trend", sections: [
      ["LINES", ["trend", "ray", "infoline", "extline", "trendangle",
        "hline", "hray", "vline", "crossline"]],
      ["CHANNELS", ["channel", "regression", "flattop", "disjoint"]],
      ["PITCHFORKS", ["pitchfork", "schiff", "schiffmod", "insidepf"]]] },
    { id: "fib", sections: [
      ["FIBONACCI", ["fib", "fibext", "fibchannel", "fibtime", "fibfan",
        "fibtimeext", "fibcircles", "fibspiral", "fibarcs", "fibwedge", "pitchfan"]],
      ["GANN", ["gannbox", "gannfixed", "gannsquare", "gannfan"]]] },
    { id: "patterns", sections: [
      ["CHART PATTERNS", ["xabcd", "cypher", "headshoulders", "abcd",
        "tripattern", "threedrivers"]],
      ["ELLIOTT WAVES", ["elliot5", "elliot3", "elliottri", "elliotwxy",
        "elliotwxyxz"]],
      ["CYCLES", ["cycliclines", "timecycles", "sine"]]] },
    { id: "positions", sections: [
      ["FORECASTING", ["longpos", "shortpos", "forecast", "barspattern",
        "ghostfeed", "sector"]],
      ["VOLUME-BASED", ["avwap", "frvp", "avp"]],
      ["MEASURERS", ["pricerange", "daterange", "dpr"]]] },
    { id: "brush", sections: [["BRUSHES", ["brush", "highlighter"]],
      ["ARROWS", ["marker", "arrow", "arrowup", "arrowdown"]],
      ["SHAPES", ["rect", "rotrect", "path", "circle", "ellipse",
        "polyline", "tri", "arc", "curve", "doublecurve"]]] },
    { id: "text", sections: [
      ["TEXT AND NOTES", ["text", "note", "pricenote", "pin", "table",
        "callout", "comment", "pricelabel", "signpost", "flag"]],
      ["CONTENT", ["image", "post", "idea"]]] },
    { id: "icon", sections: [["SMILES & PEOPLE", ["sticker"]]] }
  ];
  function groupTools(g) {
    var out = [];
    g.sections.forEach(function (s) { out = out.concat(s[1]); });
    return out;
  }

  /* ================================================= module-level state */
  var navStack = [];
  var layoutCarry = null;      // last indicator layout (survives re-mounts)
  var drawCarry = null;        // { key, items } for timeframe switches
  var pendingPrefer = "switch";
  var universeCache = null;
  var activeInstance = null;

  function pushNav(entry) {
    var top = navStack[navStack.length - 1];
    if (top && top.symbol === entry.symbol && top.interval === entry.interval && top.limit === entry.limit) return;
    navStack.push(entry);
    if (navStack.length > 40) navStack.shift();
  }

  /* ================================================================= API */
  function mount(view, opts) {
    opts = opts || {};
    if (activeInstance) { try { activeInstance.destroy(); } catch (e) { /* noop */ } }

    if (!LW || typeof LW.createChart !== "function") {
      view.innerHTML = '<div class="error-box">The chart library failed to load — check static/vendor/lightweight-charts.standalone.production.js.</div>';
      return function () {};
    }

    var api = opts.api || function (p) { return fetch(p).then(function (r) { return r.json(); }); };
    var toast = opts.toast || function () {};
    var fmtPrice = opts.fmtPrice || function (v) { return isNum(v) ? String(v) : "–"; };
    var fmtPct = opts.fmtPct || function (v) { return isNum(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) + "%" : "–"; };
    var fmtCompact = opts.fmtCompact || function (v) {
      if (!isNum(v)) return "–";
      if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
      if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
      if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "K";
      return String(Math.round(v));
    };

    var TIMEFRAMES = opts.timeframes || ["15m", "1h", "4h", "1d", "1w"];
    /* 0 is the ALL button: walk the exchange back to its very first bar. */
    var BAR_COUNTS = opts.barCounts || [100, 300, 500, 1000, 0];

    var alive = true;
    var loadSeq = 0;
    var data = null;
    var chart = null;
    var candleSeries = null;
    var markerApi = null;
    /* Compare: an overlay line of a second symbol on its own price scale. */
    var compareSym = null;
    var compareSeries = null;
    var compareEpoch = 0;
    /* Drawing history behind the header's undo / redo pair. */
    var undoStack = [], redoStack = [], undoLast = null, undoTimer = 0;
    var dialog = null;
    var suggestBox = null;
    var searchTimer = null;
    var redrawRaf = null;
    var redrawTick = null;
    var resizeHandler = null;
    var keyHandler = null;

    /* Bar replay. Declared up here because the overlay painter and the history
       backfill guard both read it during mount. */
    /* `armed` is the start-pick step TradingView has you do before a replay
       begins: the whole series stays on screen and a marker waits on the bar
       you choose. Nothing is hidden until a start is actually confirmed. */
    var replay = { on: false, armed: false, dragging: false, idx: 0, playing: false,
                   speed: 1, timer: 0, full: null, startIdx: 0 };
    var replayBar = null, replayPlayBtn = null, replayRead = null, replaySpeedBtn = null;
    var replayScrub = null, replayJump = null, replayHint = null;

    var st = {
      symbol: (opts.symbol || "BTCUSDT").toUpperCase(),
      interval: opts.interval || "1d",
      limit: opts.limit == null ? 300 : opts.limit,   // 0 = ALL history
      tool: "cursor",
      /* Which of the Cursors-flyout modes (Cross/Dot/Arrow/…) is active. */
      cursorMode: (function () {
        var p = recall("cx.cv.toolgrp.cursor", "cursor");
        return CURSOR_MODE[p] ? p : "cursor";
      })(),
      magnet: !!recall("cx.cv.magnet", false),
      locked: !!recall("cx.cv.lock", false),
      sticky: !!recall("cx.cv.sticky", false),
      hideDrawings: !!recall("cx.cv.hidedraw", false),
      /* TradingView's favourites: tool ids pinned to the floating bar */
      favs: (function (v) {
        return Array.isArray(v) ? v.filter(function (id) { return typeof id === "string"; }) : [];
      })(recall("cx.cv.favs", [])),
      favBar: !!recall("cx.cv.favbar", true),
      favPos: recall("cx.cv.favpos", null),
      zoomRect: null,
      color: recall("cx.cv.color", "#3b82f6"),
      /* TradingView's chart-type menu (Candles / Bars / Line / Area / …) */
      chartType: (function () {
        var v = recall("cx.cv.ctype", "candles");
        return CHART_TYPES[v] ? v : "candles";
      })(),
      /* Time zone shown on the axis and in the footer clock (TV's default) */
      tz: recall("cx.cv.tz", "UTC"),
      indicators: [],
      drawings: [],
      selected: null,
      pending: null,
      dragging: null,
      hover: null,
      quote: null,
      status: ""
    };

    /* --------------------------------------------------------- storage */
    /* One indicator layout per symbol: studies follow you across timeframes the
       way TradingView keeps them, and switching 1d -> 4h can never clobber a
       saved layout the way a per-interval key could. Drawings work the same
       way — they are anchored to a timestamp, not to a bar position, so a
       vertical line dropped on the daily chart belongs on that candle at any
       timeframe you switch to. Old per-interval keys are read once (and
       merged) so drawings saved before this change keep working. */
    function iKey() { return "cx.cv.ind." + st.symbol; }
    function legacyIKey() { return "cx.cv.ind." + st.symbol + "." + st.interval; }
    function dKey() { return "cx.cv.draw." + st.symbol; }
    var LEGACY_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"];
    function legacyDKeys() {
      return LEGACY_TFS.map(function (t) { return "cx.cv.draw." + st.symbol + "." + t; });
    }

    function defaultIndicators() {
      return [
        { uid: uid("ind"), id: "volume", params: clone(STUDY_MAP.volume.defaults) },
        { uid: uid("ind"), id: "sma", params: clone(STUDY_MAP.sma.defaults) },
        { uid: uid("ind"), id: "ema", params: clone(STUDY_MAP.ema.defaults) }
      ];
    }

    function resolveDrawings() {
      /* The in-memory copy is always the freshest — a timeframe switch inside
         the session hands the same drawings straight across. */
      if (pendingPrefer === "carry" && drawCarry && drawCarry.key === st.symbol) {
        return clone(drawCarry.items);
      }
      var stored = recall(dKey(), null);
      if (stored) return stored;
      /* Drawings used to live under one key per timeframe. Merge every old
         copy the first time this symbol is opened so nothing disappears. */
      var merged = [], seen = {};
      legacyDKeys().forEach(function (k) {
        var arr = recall(k, null);
        if (!Array.isArray(arr)) return;
        arr.forEach(function (d) {
          if (!d || !d.tool) return;
          var pts = (d.points || []).map(function (p) { return p.time + "/" + p.price; }).join(",");
          var id = d.id || (d.tool + ":" + pts);
          if (seen[id]) return;
          seen[id] = 1;
          merged.push(d);
        });
      });
      if (merged.length) { store(dKey(), merged); return merged; }
      return [];
    }

    /* `st.indicators` is only filled in once the bars land (see the load
       handler below), so before that first restore the array is empty or
       still holding the previous chart. Persisting out of that window used to
       overwrite the stored layout with a partial set — adding a Pine script in
       the opening frames silently dropped Volume and the moving averages.
       Nothing writes until a restore or a preset has actually installed a
       layout the user recognises as theirs. */
    var layoutReady = false;

    function saveIndicators() {
      if (!layoutReady) return;
      store(iKey(), st.indicators.map(function (i) { return { uid: i.uid, id: i.id, params: i.params }; }));
      layoutCarry = st.indicators.map(function (i) { return { uid: i.uid, id: i.id, params: clone(i.params) }; });
    }

    function saveDrawings() {
      store(dKey(), st.drawings);
      drawCarry = { key: st.symbol, items: clone(st.drawings) };
    }

    /* -------------------------------------------------- indicator templates
       A template is the indicator list exactly as configured — every Inputs /
       Style / Visibility value — so a whole strategy can be recalled in one
       click on any symbol, any timeframe. */
    function presetList() {
      var v = recall("cx.cv.tpl", []);
      if (!Array.isArray(v)) return [];
      return v.filter(function (p) {
        return p && typeof p.name === "string" && p.name && Array.isArray(p.items);
      });
    }

    function presetSave(name) {
      name = String(name || "").trim();
      if (!name || !st.indicators.length) return false;
      var items = st.indicators.map(function (i) { return { id: i.id, params: clone(i.params) }; });
      var list = presetList().filter(function (p) { return p.name.toLowerCase() !== name.toLowerCase(); });
      list.unshift({ name: name, items: items, at: Date.now() });
      store("cx.cv.tpl", list);
      return true;
    }

    function presetApply(name) {
      var p = presetList().filter(function (x) { return x.name === name; })[0];
      if (!p) return false;
      /* Tear the running layout down before swapping the array — the old
         instances own the LW panes. */
      st.indicators.slice().forEach(destroyInstance);
      st.indicators = p.items.map(function (i) {
        var study = STUDY_MAP[i.id];
        if (!study) return null;
        return { uid: uid("ind"), id: i.id, params: Object.assign(clone(study.defaults), clone(i.params || {})) };
      }).filter(Boolean);
      rebuildIndicators();
      /* A preset installs a complete, deliberate layout, so it is as good a
         starting point as a restore — release the write guard here too. */
      layoutReady = true;
      saveIndicators();
      schedulePaneSizes();
      scheduleRedraw();
      return true;
    }

    function presetDrop(name) {
      store("cx.cv.tpl", presetList().filter(function (p) { return p.name !== name; }));
    }

    function rememberRecent() {
      var list = recall("cx.cv.recent", []);
      list = list.filter(function (s) { return s !== st.symbol; });
      list.unshift(st.symbol);
      store("cx.cv.recent", list.slice(0, 8));
    }

    function notifyState() {
      if (opts.onState) opts.onState({ symbol: st.symbol, interval: st.interval, limit: st.limit });
    }

    /* watchlist + recently-viewed symbols as one clickable chip row */
    function renderQuick() {
      if (!quickRow) return;
      var recent = recall("cx.cv.recent", []) || [];
      var wl = [];
      try { wl = (opts.watchlist && opts.watchlist()) || []; } catch (e) { wl = []; }
      var seen = {}, syms = [];
      wl.concat(recent).forEach(function (s) {
        if (typeof s === "string" && s && !seen[s]) { seen[s] = 1; syms.push(s); }
      });
      quickRow.innerHTML = "";
      quickRow.appendChild(el("span", { class: "cv-qlab", text: wl.length ? "Watchlist · recent" : "Recent" }));
      if (!syms.length) {
        quickRow.appendChild(el("span", { class: "none", text: "Symbols you open appear here" }));
        return;
      }
      syms.slice(0, 14).forEach(function (s) {
        quickRow.appendChild(el("button", {
          class: "cv-qchip" + (s === st.symbol ? " on" : ""),
          text: s.replace(/USDT$/, ""),
          title: s + (wl.indexOf(s) > -1 ? " · watchlist" : " · recent"),
          onclick: function () { goToSymbol(s); }
        }));
      });
    }

    /* ------------------------------------------------------------ DOM */
    var searchInput = el("input", {
      type: "text", value: st.symbol, spellcheck: "false",
      placeholder: "Search symbol…", title: "Jump to another market",
      oninput: onSearchInput,
      onkeydown: onSearchKey,
      onfocus: function () { if (searchInput.value.trim()) onSearchInput(); }
    });

    var backBtn = el("button", {
      class: "cv-ibtn", html: ICON.back,
      title: "Go back to the previously viewed symbol / timeframe",
      onclick: goBack
    });

    var symEl = el("div", { class: "cv-sym" });
    var nameEl = el("div", { class: "cv-name" });
    /* Filled in by the bar loader — tv.com's legend title ends with the venue
       (`Apple Inc · 1D · NASDAQ`) and that only becomes known once data lands. */
    var dataSource = "";
    var lastEl = el("div", { class: "cv-last", text: "…" });
    var chgEl = el("div", { class: "cv-chg", text: "" });
    var ohlc = { o: el("span", { class: "v", text: "–" }), h: el("span", { class: "v", text: "–" }),
      l: el("span", { class: "v", text: "–" }), c: el("span", { class: "v", text: "–" }),
      chg: el("span", { class: "v", text: "–" }), vol: el("span", { class: "v", text: "–" }),
      stamp: el("span", { class: "stamp", text: "" }) };

    var legend = el("div", { class: "cv-legend" });
    var statusEl = el("span", { class: "cv-status", text: "" });
    var quickRow = el("div", { class: "cv-quick" });
    var tfWrap = el("div", { class: "tf" });
    var barsWrap = el("div", { class: "tf" });

    var zoomOut = el("button", { class: "cv-ibtn", html: ICON.zout, title: "Zoom out (−)", onclick: function () { zoomBy(1 / 1.35); } });
    var zoomIn = el("button", { class: "cv-ibtn", html: ICON.zin, title: "Zoom in (+)", onclick: function () { zoomBy(1.35); } });
    var zoomReset = el("button", { class: "cv-ibtn", html: ICON.reset, title: "Reset zoom — fit all bars (double-click also resets)", onclick: resetZoom });
    /* TradingView's own refresh control lives beside the zoom group: one click
       re-fits the plot (zoom in/out by itself) and re-arms every price scale. */
    var refreshBtn = el("button", {
      class: "cv-ibtn cv-refresh", html: ICON.refresh,
      title: "Refresh — re-fit the chart to all bars and reset every price scale",
      onclick: refreshChart
    });
    /* Not a filled pill: on tv.com this is plain icon + label, same weight as
       every other toolbar control. The blue fill was the loudest tell that the
       chrome wasn't TradingView. */
    var indsBtn = el("button", { class: "cv-ibtn wide", html: ICON.fx + "<span>Indicators</span>", title: "Add / edit indicators", onclick: openIndicatorDialog });
    indsBtn.querySelector("span").style.cssText = "font-size:12.5px";
    /* Bar replay control — TradingView's header pair lives in the rail now,
       where the presets button sits; only replay stays up here. */
    var replayBtn = el("button", {
      class: "cv-ibtn cv-replaybtn", html: ICON.replay,
      title: "Bar replay — play the price action candle by candle",
      onclick: toggleReplay
    });

    /* -------------------------------------------------- header chrome
       TradingView's header runs, left to right: symbol · data type ·
       compare · interval · chart type · indicators · templates · alert ·
       replay · undo · redo · layout · save · manage layouts · zoom …
       quick search · settings · fullscreen · snapshot · share · trade. */
    function tbtn(cls, icon, title, onclick, label) {
      return el("button", {
        class: "cv-ibtn cv-tbtn" + (cls ? " " + cls : ""),
        html: icon + (label ? "<span>" + esc(label) + "</span>" : ""),
        title: title,
        onclick: onclick
      });
    }

    var dataTypeBtn = tbtn("cv-tb-datatype", ICON.datatype, "Switch data type", function () {
      openMenu(dataTypeBtn, [
        { header: "Data type" },
        { label: "Regular", on: true },
        { label: "Session-extended", onclick: function () { toast("Not available", "This venue publishes one continuous series", ""); } },
        { label: "Continuous contract", onclick: function () { toast("Not available", "Spot markets have no separate contract", ""); } }
      ]);
    });

    var compareBtn = tbtn("cv-tb-compare", ICON.compare, "Compare symbols", function () {
      var items = [{ header: "Compare with" }];
      var rec = (recall("cx.cv.recent", []) || []).filter(function (s) {
        return typeof s === "string" && s !== st.symbol;
      }).slice(0, 6);
      if (!rec.length) {
        items.push({ label: "No recent symbols yet", onclick: function () { toast("Compare", "Search a symbol first — it joins this list", ""); } });
      }
      rec.forEach(function (s) {
        items.push({ label: s, on: compareSym === s, onclick: function () { compareAdd(s); } });
      });
      if (compareSym) { items.push({ sep: true }); items.push({ label: "Remove comparison", onclick: compareClear }); }
      openMenu(compareBtn, items);
    });

    var chartTypeBtn = tbtn("cv-tb-type", ICON.charttype, "Chart type — " + CHART_TYPES[st.chartType].label, function () {
      openMenu(chartTypeBtn, CHART_TYPE_ORDER.map(function (id) {
        var t = CHART_TYPES[id];
        return {
          label: t.label, icon: t.icon, hint: t.hint,
          on: st.chartType === id,
          onclick: function () { setChartType(id); }
        };
      }));
    });

    var alertBtn = tbtn("cv-tb-alert", ICON.alert, "Create alert", openAlertDialog);
    var tplBtn = tbtn("cv-tb-tpl", ICON.templates, "Indicator templates", openPresetDialog);
    var undoBtn = tbtn("cv-tb-undo", ICON.undo, "Undo the last drawing change", function () { drawingsStep(-1); });
    var redoBtn = tbtn("cv-tb-redo", ICON.redo, "Redo the last undone change", function () { drawingsStep(1); });

    var layoutBtn = tbtn("cv-tb-layout", ICON.layout, "Layout setup", function () {
      openMenu(layoutBtn, [
        { header: "Chart layout" },
        { label: "Single chart", icon: CHART_TYPES.baseline.icon, on: true },
        { label: "2 charts", onclick: function () { toast("Layout", "Multi-chart layouts are not part of this workspace", ""); } },
        { label: "3 charts", onclick: function () { toast("Layout", "Multi-chart layouts are not part of this workspace", ""); } },
        { label: "4 charts", onclick: function () { toast("Layout", "Multi-chart layouts are not part of this workspace", ""); } },
        { sep: true },
        { label: "Rename layout", onclick: function () { toast("Layout", "This workspace runs one layout", ""); } }
      ]);
    });

    var saveBtn = el("button", {
      class: "cv-ibtn cv-tbtn cv-tb-save", text: "Save",
      title: "Save all charts for all symbols and intervals on your layout",
      onclick: saveNow
    });

    var manageBtn = tbtn("cv-tb-manage", ICON.caret16, "Manage layouts", function () {
      openMenu(manageBtn, [
        { header: "Layouts" },
        { label: "Crypto workspace", on: true, hint: "current" },
        { sep: true },
        { label: "Save layout as…", onclick: saveNow },
        { label: "Copy layout link", onclick: shareIdea }
      ]);
    });

    var quickBtn = tbtn("cv-tb-quick", ICON.quicksearch, "Quick search", function () {
      searchInput.focus(); searchInput.select();
    });
    var settingsBtn = tbtn("cv-tb-settings", ICON.gearTv, "Chart settings", openSettingsDialog);
    var fsBtn = tbtn("cv-tb-fs", ICON.fullscreen, "Fullscreen mode", toggleFullscreen);
    var snapBtn = tbtn("cv-tb-snap", ICON.snapshot, "Take a snapshot", takeSnapshot);
    var shareBtn = tbtn("cv-tb-share", ICON.share, "Share your idea with the trade community", shareIdea);
    var tradeBtn = tbtn("cv-tb-trade", "", "Trade", function () {
      openMenu(tradeBtn, [
        { header: "Trade" },
        { label: "Open " + st.symbol + " on Binance", onclick: function () {
          window.open("https://www.binance.com/en/trade/" + encodeURIComponent(st.symbol), "_blank", "noopener");
        } },
        { label: "Open " + st.symbol + " on Bybit", onclick: function () {
          window.open("https://www.bybit.com/en/trade/spot/" + encodeURIComponent(st.symbol.replace(/USDT$/, "") + "/USDT"), "_blank", "noopener");
        } }
      ]);
    }, "Trade");

    var colorInput = el("input", { type: "color", class: "cv-color", value: st.color, title: "Drawing colour",
      oninput: function () { st.color = colorInput.value; store("cx.cv.color", st.color); } });
    var magnetBtn = el("button", { class: "cv-ibtn", html: ICON.magnet, title: "Magnet — snap drawings to OHLC", onclick: toggleMagnet });
    var lockBtn = el("button", { class: "cv-ibtn", html: st.locked ? ICON.lock : ICON.unlock, title: "Lock drawings (block moving / editing)", onclick: toggleLock });
    var clearBtn = el("button", { class: "cv-ibtn", html: ICON.trashAll, title: "Delete every drawing on this chart", onclick: clearDrawings });

    var toolsWrap = el("div", { class: "cv-tools" });
    var chartHost = el("div", { class: "cv-chart" });
    var overlay = el("canvas", { class: "cv-overlay" });

    /* TradingView paints the symbol, OHLC strip and indicator legends straight
       onto the chart instead of giving them a bar of their own. */
    /* tv.com's strip is bare: `O331.70 H338.61 L330.70 C336.64 −3.78 (−1.11%)`.
       No "Chg" or "Vol" words — volume belongs to the study legend row below —
       and no clock, which lives on the status bar. */
    var ohlcRow = el("div", { class: "cv-ohlc" }, [
      el("span", {}, [el("span", { class: "k", text: "O" }), ohlc.o]),
      el("span", {}, [el("span", { class: "k", text: "H" }), ohlc.h]),
      el("span", {}, [el("span", { class: "k", text: "L" }), ohlc.l]),
      el("span", {}, [el("span", { class: "k", text: "C" }), ohlc.c]),
      ohlc.chg
    ]);
    var legendBox = el("div", { class: "cv-legendbox" }, [
      el("div", { class: "cv-lg1" }, [
        el("div", { class: "cv-id" }, [symEl, nameEl]),
        el("div", { class: "cv-quote" }, [lastEl, chgEl])
      ]),
      ohlcRow,
      legend
    ]);
    var mainWrap = el("div", { class: "cv-main" }, [chartHost, overlay, legendBox]);

    /* TradingView has nothing under the time axis — the old hint bar used to
       live here and every line of it is now discoverable from a rail tooltip. */
    /* TradingView keeps the whole date story under the chart: the range menu,
       the 1D…All tabs, "go to date", the clock and the adjust flag. */
    var rangeById = {};
    var RANGE_TABS = [
      { id: "1D", label: "1D", title: "1 day", days: 1 },
      { id: "5D", label: "5D", title: "5 days", days: 5 },
      { id: "1M", label: "1M", title: "1 month", days: 30 },
      { id: "3M", label: "3M", title: "3 months", days: 90 },
      { id: "6M", label: "6M", title: "6 months", days: 180 },
      { id: "YTD", label: "YTD", title: "Year to date", ytd: true },
      { id: "1Y", label: "1Y", title: "1 year", days: 365 },
      { id: "5Y", label: "5Y", title: "5 years", days: 1825 },
      { id: "All", label: "All", title: "All data", all: true }
    ];
    RANGE_TABS.forEach(function (r) { rangeById[r.id] = r; });

    /* --- interval -----------------------------------------------------
       TradingView shows one button carrying the current timeframe and
       drops the rest into a menu; the buttons themselves stay in the DOM
       so keyboard/query access to [data-tf] keeps working. */
    var tfBtn = el("button", {
      class: "cv-ibtn cv-tbtn cv-tfbtn",
      html: '<span class="cv-tf-lab"></span>' + ICON.caret16,
      title: "Time interval",
      onclick: function () { toggleTfPop(); }
    });
    /* The interval buttons stay mounted (hidden) so [data-tf] queries — and
       the segmented highlight in syncControls — keep working. */
    var tfPop = el("div", { class: "cv-menu cv-pop cv-tfpop" }, [tfWrap]);
    var tfWrapBox = el("span", { class: "cv-tfwrap" }, [tfBtn, tfPop]);
    var tfOpen = false;
    function toggleTfPop() {
      tfOpen = !tfOpen;
      tfPop.classList.toggle("on", tfOpen);
      if (tfOpen) {
        setTimeout(function () {
          document.addEventListener("mousedown", tfOutside, true);
          document.addEventListener("keydown", tfEsc, true);
        }, 0);
      } else {
        document.removeEventListener("mousedown", tfOutside, true);
        document.removeEventListener("keydown", tfEsc, true);
      }
    }
    function tfOutside(e) { if (tfOpen && tfWrapBox && !tfWrapBox.contains(e.target)) toggleTfPop(); }
    function tfEsc(e) { if (tfOpen && e && e.key === "Escape") toggleTfPop(); }

    /* --- bottom bar controls ------------------------------------------ */
    var rangeTabs = el("div", { class: "cv-ranges" });

    function rangeDays(r) {
      if (r.all) return 0;
      if (r.ytd) {
        var now = new Date();
        var jan = Date.UTC(now.getUTCFullYear(), 0, 1);
        return Math.max(1, (now.getTime() - jan) / 86400000);
      }
      return r.days;
    }
    function rangeBars(r) {
      var d = rangeDays(r);
      if (d === 0) return 0;                       /* 0 = ALL history */
      var sec = tfSec(st.interval);
      return Math.max(20, Math.min(200000, Math.ceil(d * 86400 / sec)));
    }
    function pickRange(r) { changeLimit(rangeBars(r)); syncRangeTabs(); }
    function syncRangeTabs() {
      var active = null;
      if (st.limit === 0) {
        active = "All";
      } else {
        var best = Infinity;
        RANGE_TABS.forEach(function (r) {
          if (r.all) return;
          var b = rangeBars(r);
          if (!b || st.limit <= 0) return;
          var err = Math.abs(Math.log(b / st.limit));
          if (err < best) { best = err; active = r.id; }
        });
      }
      $$(".cv-rtab", rangeTabs).forEach(function (b) {
        b.classList.toggle("on", b.dataset.range === active);
      });
    }

    var dateRangeBtn = el("button", {
      class: "cv-ibtn cv-tbtn cv-rangebtn",
      html: ICON.caret16 + "<span>Date Range</span>",
      title: "Date range",
      onclick: function () {
        openMenu(dateRangeBtn, [{ header: "Date range" }].concat(RANGE_TABS.map(function (r) {
          return { label: r.label + "  ·  " + r.title, on: st.limit === rangeBars(r), onclick: function () { pickRange(r); } };
        })));
      }
    });

    RANGE_TABS.forEach(function (r) {
      var b = el("button", { class: "cv-rtab", text: r.label, title: r.title });
      b.dataset.range = r.id;
      b.onclick = function () { pickRange(r); };
      rangeTabs.appendChild(b);
    });

    var gotoBtn = el("button", {
      class: "cv-ibtn cv-tbtn cv-gotobtn", html: ICON.goto, title: "Go to date",
      onclick: function () {
        /* Pre-fill with the newest bar we hold, like TV's Go-to-date does —
           an empty field made the first click do nothing visible. */
        var seed = new Date();
        if (data && data.n) seed = new Date(data.time[data.n - 1] * 1000);
        var iso = seed.toISOString().slice(0, 10);
        var dateIn = el("input", { type: "date", class: "cv-datein", value: iso });
        function go() { closeMenu(); goToStamp(dateIn.value); }
        dateIn.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); go(); }
        });
        var box = el("div", { class: "cv-menu cv-pop" }, [
          el("div", { class: "cv-menu-head", text: "Go to date" }),
          el("div", { class: "cv-goto-row" }, [
            dateIn,
            el("button", { class: "cv-btn cv-btn-primary", text: "Go", onclick: go })
          ])
        ]);
        showMenuBox(gotoBtn, box);
        setTimeout(function () { dateIn.focus(); dateIn.select && dateIn.select(); }, 30);
      }
    });

    var TZS = ["UTC", "Europe/London", "Europe/Berlin", "America/New_York",
               "America/Chicago", "America/Los_Angeles", "Asia/Tokyo",
               "Asia/Singapore", "Australia/Sydney"];
    var tzBtn = el("button", {
      class: "cv-ibtn cv-tbtn cv-tzbtn", title: "Time zone", text: "UTC",
      onclick: function () {
        openMenu(tzBtn, [{ header: "Time zone" }].concat(TZS.map(function (z) {
          return { label: z, on: st.tz === z, onclick: function () { setTz(z); } };
        })));
      }
    });

    var adjBtn = el("button", {
      class: "cv-ibtn cv-tbtn cv-adjbtn", text: "ADJ",
      title: "Adjust data for splits and dividends",
      onclick: function () {
        adjBtn.classList.toggle("on");
        toast("Adjusted data", "Spot crypto has no splits or dividends — the flag is kept for layout parity", "");
      }
    });
    var clockTimer = setInterval(function () {
      if (!alive) { clearInterval(clockTimer); return; }
      updateClock();
    }, 1000);

    /* ------------------------------------------------- right-hand strip
       TradingView docks a 45px column down the right edge holding 44x44
       buttons: watchlist / alerts / object tree at the top, a filler, then
       the product buttons, a 33x1 hairline and Help Center pinned to the
       bottom.  Geometry captured from the live strip (data-name
       "right-toolbar": w45, padding 2px 0, gap 2). */
    function rsBtn(k, icon, label, fn) {
      return el("button", {
        class: "cv-rbtn", "data-rs": k, html: ICON[icon],
        title: label, "aria-label": label, onclick: fn
      });
    }
    function rsSoon(label) { toast(label, "Not available in this build", ""); }
    function goRoute(h) { if (location.hash !== h) location.hash = h; }
    function rHead(body, text) { body.appendChild(el("div", { class: "cv-rp-head", text: text })); }
    function rEmpty(body, text) { body.appendChild(el("div", { class: "hint", text: text })); }
    function rRow(body, title, sub, onRemove, cls) {
      body.appendChild(el("div", { class: "cv-rp-row" + (cls ? " " + cls : "") }, [
        typeof title === "string" ? el("div", { class: "cv-rp-sym" }, [
          el("div", { class: "cv-rp-t", text: title }),
          el("div", { class: "cv-rp-s", text: sub || "" })
        ]) : title,
        onRemove ? el("button", { class: "cv-rp-x", text: "×", title: "Remove", onclick: onRemove }) : null
      ]));
    }

    function openWatchPanel() {
      var wl = [];
      try { wl = (opts.watchlist && opts.watchlist()) || []; } catch (e) { wl = []; }
      var recent = recall("cx.cv.recent", []) || [];
      var seen = {}, all = [];
      wl.concat(recent).forEach(function (s) {
        if (typeof s === "string" && s && !seen[s]) { seen[s] = 1; all.push(s); }
      });
      var body = el("div", { class: "cv-rpanel" });
      function paint() {
        body.innerHTML = "";
        rHead(body, "Watchlist");
        if (!all.length) rEmpty(body, "No symbols yet.");
        all.forEach(function (s) {
          var inWl = wl.indexOf(s) > -1;
          rRow(body,
            el("button", { class: "cv-rp-sym", text: s, title: "Open " + s,
                            onclick: function () { closeModal(); goToSymbol(s); } }),
            inWl ? "watchlist" : "recent",
            function () {
              all = all.filter(function (x) { return x !== s; });
              wl = wl.filter(function (x) { return x !== s; });
              try { if (window.App && window.App.state) window.App.state.watchlist = wl; } catch (e) { /* noop */ }
              fetch("/api/watchlist", { method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ symbols: wl }) }).catch(function () {});
              renderQuick();
              paint();
            },
            s === st.symbol ? "on" : "");
        });
      }
      paint();
      openModal("Watchlist", body, [
        el("button", { class: "cv-btn", text: "Close", onclick: closeModal })
      ], true);
    }

    function openAlertsPanel() {
      var body = el("div", { class: "cv-rpanel" });
      function paint(items, msg) {
        body.innerHTML = "";
        if (msg) rEmpty(body, msg);
        if (!items || !items.length) { if (!msg) rEmpty(body, "No alerts yet."); return; }
        items.forEach(function (a) {
          rRow(body,
            el("div", { class: "cv-rp-sym" }, [
              el("div", { class: "cv-rp-t", text: a.name || a.clause || "Alert" }),
              el("div", { class: "cv-rp-s", text: (a.clause || "") + "  ·  " + (a.interval || "") })
            ]),
            "",
            function () {
              fetch("/api/alerts/" + encodeURIComponent(a.id), { method: "DELETE" })
                .then(function () { return load(); })
                .catch(function () { paint([], "Could not delete the alert."); });
            },
            a.enabled === false ? "off" : "");
        });
      }
      function load() {
        body.innerHTML = "";
        rEmpty(body, "Loading…");
        fetch("/api/alerts").then(function (r) { return r.json(); })
          .then(function (j) { paint((j && j.alerts) || []); })
          .catch(function (e) { paint([], "Could not load alerts: " + e); });
      }
      load();
      openModal("Alerts", body, [
        el("button", { class: "cv-btn", text: "New alert", onclick: function () { closeModal(); openAlertDialog(); } }),
        el("button", { class: "cv-btn cv-btn-primary", text: "Close", onclick: closeModal })
      ], true);
    }

    function openNotifyPanel() {
      var body = el("div", { class: "cv-rpanel" });
      body.innerHTML = "";
      rEmpty(body, "Loading…");
      fetch("/api/alerts/pending").then(function (r) { return r.json(); })
        .then(function (j) {
          body.innerHTML = "";
          var items = (j && j.items) || [];
          rHead(body, "Notifications");
          if (!items.length) rEmpty(body, "Nothing new.");
          items.forEach(function (it) {
            var when = it.time ? stampFor(Math.floor(it.time)) : "";
            rRow(body,
              el("div", { class: "cv-rp-sym" }, [
                el("div", { class: "cv-rp-t", text: (it.symbol || "") + (it.price != null ? "  @ " + it.price : "") }),
                el("div", { class: "cv-rp-s", text: (it.alert || "") + (when ? "  ·  " + when : "") })
              ]), "", null, "");
          });
        })
        .catch(function (e) { body.innerHTML = ""; rEmpty(body, "Could not load notifications: " + e); });
      openModal("Notifications", body, [
        el("button", { class: "cv-btn", text: "Close", onclick: closeModal })
      ], true);
    }

    function openObjectTree() {
      var body = el("div", { class: "cv-rpanel" });
      rHead(body, "Indicators");
      if (!st.indicators.length) rEmpty(body, "No indicators.");
      st.indicators.slice().forEach(function (inst) {
        rRow(body,
          el("div", { class: "cv-rp-sym" }, [
            el("div", { class: "cv-rp-t", text: studyLabel(inst) }),
            el("div", { class: "cv-rp-s", text: (inst.params && inst.params.tf ? "Timeframe " + inst.params.tf : "") })
          ]),
          "", function () { removeIndicator(inst.uid); closeModal(); openObjectTree(); }, "");
      });
      rHead(body, "Drawings");
      if (!st.drawings.length) rEmpty(body, "No drawings on this chart.");
      st.drawings.slice().forEach(function (it) {
        var t = toolById(it.tool);
        rRow(body,
          el("div", { class: "cv-rp-sym" }, [
            el("div", { class: "cv-rp-t", text: (t && t.label) || it.tool }),
            el("div", { class: "cv-rp-s", text: it.text || (it.color || "") })
          ]),
          "", function () {
            st.drawings = st.drawings.filter(function (x) { return x !== it; });
            saveDrawings(); redrawOverlay(); closeModal(); openObjectTree();
          }, "");
      });
      openModal("Object tree", body, [
        el("button", { class: "cv-btn", text: "Close", onclick: closeModal })
      ], true);
    }

    function openHelpPanel() {
      var rows = [
        ["Space", "Play / pause bar replay"],
        ["Esc", "Close menu · deselect · back to the cursor tool"],
        ["Delete", "Delete the selected drawing"],
        ["Ctrl + Z", "Undo the last drawing change"],
        ["Ctrl + Y", "Redo"],
        ["+  /  −", "Zoom in / out"],
        ["0", "Reset the zoom"],
        ["←  →", "Pan eight bars"],
        ["V  T  R  H  M  E  Z", "Cursor · Trend · Ray · Horizontal · Measure · Eraser · Zoom"],
        ["Double-click", "Reset zoom, or finish a freeform path"]
      ];
      var body = el("div", { class: "cv-rpanel" });
      rHead(body, "Keyboard shortcuts");
      rows.forEach(function (r) {
        body.appendChild(el("div", { class: "cv-rp-kv" }, [
          el("span", { class: "k", text: r[0] }),
          el("span", { class: "v", text: r[1] })
        ]));
      });
      openModal("Help Center", body, [
        el("button", { class: "cv-btn cv-btn-primary", text: "Close", onclick: closeModal })
      ], true);
    }

    /* ------------------------------------------------------ pine editor ---
       TradingView docks the Pine Editor above the bottom toolbar: a header
       carrying the script's file controls, the code itself behind a
       line-number gutter, and a status strip that reports the first compile
       error against the line it came from.  This block is only chrome — the
       interpreter is `Pine` (static/pine.js) and a saved script becomes an
       ordinary study through addPineStudy(), so the legend, the Settings
       dialog and persistence all keep working with no second code path. */
    var pineWrap = el("div", { class: "cv-pine" });
    var pineEd = {
      built: false, id: null, name: "", errLine: false, dirty: false, timer: 0,
      file: null, gut: null, hl: null, ta: null, msg: null, pos: null, addBtn: null
    };
    /* What an empty file starts as. `//@version=5` has to lead because the
       lexer reads it before anything else; the rest compiles against the real
       `indicator()` prelude so a brand-new script is addable on first click. */
    var PINE_NEW = [
      "//@version=5",
      "indicator(\"My Script\", overlay=true)",
      "",
      "len = input.int(20, \"Length\")",
      "ma  = ta.sma(close, len)",
      "plot(ma, \"SMA\", color=color.orange)",
      ""
    ].join("\n");

    /* One-pass highlighter.  The output is HTML so every byte of the source is
       escaped before it is wrapped; the textarea underneath stays plain text
       and both layers share identical metrics so they cannot drift apart. */
    function pineHL(src) {
      var KW = /^(?:if|else|for|while|break|continue|var|varip|switch|true|false|na|and|or|not|in|to|by|import|export|type|method|as|return)$/;
      var NS = /^(?:ta|math|str|input|color|array|matrix|rt|strategy|line|label|box|table|linefill)$/;
      var out = "", i = 0, n = src.length;
      while (i < n) {
        var c = src.charAt(i), j, w, cls;
        if (c === "/" && src.charAt(i + 1) === "/") {
          j = src.indexOf("\n", i); if (j < 0) j = n;
          out += '<span class="c-cm">' + esc(src.slice(i, j)) + "</span>"; i = j; continue;
        }
        if (c === "\"" || c === "'") {
          j = i + 1;
          while (j < n && src.charAt(j) !== c) { if (src.charAt(j) === "\\") j++; j++; }
          j = Math.min(j + 1, n);
          out += '<span class="c-st">' + esc(src.slice(i, j)) + "</span>"; i = j; continue;
        }
        if (c === "#" && /[0-9a-fA-F]/.test(src.charAt(i + 1))) {
          j = i + 1; while (j < n && /[0-9a-fA-F]/.test(src.charAt(j))) j++;
          out += '<span class="c-cl">' + esc(src.slice(i, j)) + "</span>"; i = j; continue;
        }
        if (c >= "0" && c <= "9" && !/[A-Za-z0-9_]/.test(src.charAt(i - 1))) {
          j = i; while (j < n && /[0-9.]/.test(src.charAt(j))) j++;
          out += '<span class="c-nu">' + esc(src.slice(i, j)) + "</span>"; i = j; continue;
        }
        if (/[A-Za-z_]/.test(c)) {
          j = i; while (j < n && /[A-Za-z0-9_]/.test(src.charAt(j))) j++;
          w = src.slice(i, j);
          var k = j; while (k < n && (src.charAt(k) === " " || src.charAt(k) === "\t")) k++;
          cls = KW.test(w) ? "c-kw"
              : src.charAt(j) === "." ? "c-ns"
              : NS.test(w) && src.charAt(k) === "(" ? "c-ns"
              : src.charAt(k) === "(" ? "c-fn"
              : "";
          out += cls ? '<span class="' + cls + '">' + esc(w) + "</span>" : esc(w);
          i = j; continue;
        }
        out += esc(c); i++;
      }
      return out + "\n";
    }

    function pineSyncScroll() {
      pineEd.hl.scrollTop = pineEd.ta.scrollTop;
      pineEd.hl.scrollLeft = pineEd.ta.scrollLeft;
      pineEd.gut.scrollTop = pineEd.ta.scrollTop;
    }
    function pinePaint() {
      var src = pineEd.ta.value;
      pineEd.hl.innerHTML = pineHL(src);
      var n = src.split("\n").length, g = "", i;
      for (i = 1; i <= n; i++) {
        g += '<div class="ln' + (i === pineEd.errLine ? " err" : "") + '">' + i + "</div>";
      }
      pineEd.gut.innerHTML = g;
      pineSyncScroll();
    }
    function pinePos() {
      var v = pineEd.ta.value, p = pineEd.ta.selectionStart || 0;
      var a = v.slice(0, p).split("\n");
      pineEd.pos.textContent = "Ln " + a.length + ", Col " + (a[a.length - 1].length + 1);
    }
    /* Put the caret on the line the compiler complained about — the number
       arrives from pineCheck rather than being re-parsed out of the message. */
    function pineGoto() {
      var ln = pineEd.errLine;
      if (!ln) return;
      var rows = pineEd.ta.value.split("\n"), p = 0, i;
      for (i = 0; i < ln - 1 && i < rows.length; i++) p += rows[i].length + 1;
      pineEd.ta.focus();
      pineEd.ta.setSelectionRange(p, p + (rows[ln - 1] || "").length);
      pineEd.ta.scrollTop = Math.max(0, (ln - 4) * 20);
      pineSyncScroll();
      pinePos();
    }
    function pineCompile() {
      var src = pineEd.ta.value, r = null;
      try { r = window.ChartView.pineCheck(src); } catch (e) { r = { error: e.message }; }
      var m = pineEd.msg;
      m.className = "cv-pine-msg";
      if (!src.trim()) {
        pineEd.errLine = false; m.className += " ok";
        m.textContent = "Empty script"; m.title = "";
      } else if (r && r.error) {
        pineEd.errLine = r.line || false; m.className += " bad";
        m.textContent = (r.line ? "Line " + r.line + " — " : "") +
                        String(r.error).replace(/^line\s+\d+:\s*/i, "");
        m.title = "Click to jump to the error";
      } else {
        pineEd.errLine = false; m.className += " ok";
        m.textContent = "No errors"; m.title = "";
      }
      pinePaint();
    }

    function pineList() {
      try { return window.ChartView.pineList() || []; } catch (e) { return []; }
    }
    /* Is an instance of this id already drawing? Drives both the button label
       and whether "Add to chart" means a fresh instance or an in-place
       rebuild — re-adding a script that is on the chart must not stack a
       second copy of it. */
    function pineOnChart(id) {
      var api = window.ChartView.current;
      if (!api || !id) return false;
      return (api.indicators || []).some(function (it) { return it.id === id; });
    }
    function pineSyncFile() {
      pineEd.file.textContent = (pineEd.name || "Untitled") + (pineEd.dirty ? " \u2022" : "");
      pineEd.addBtn.textContent = pineOnChart(pineEd.id) ? "Update on chart" : "Add to chart";
    }

    function pineApply(add) {
      var src = pineEd.ta.value, res = null;
      try {
        res = (add && !pineOnChart(pineEd.id))
            ? window.ChartView.pineAdd(src, pineEd.id)
            : window.ChartView.pineSave(src, pineEd.id);
      } catch (e) { res = { error: e.message }; }
      if (!res || res.error) {
        toast("Pine Editor", (res && res.error) || "Could not save the script.", "err");
        if (res && res.line) { pineEd.errLine = res.line; pinePaint(); pineGoto(); }
        return false;
      }
      pineEd.id = res.id;
      pineEd.name = res.name || pineEd.name;
      pineEd.dirty = false;
      store("cx.cv.pine.last", res.id);
      pineSyncFile();
      pineCompile();
      if (add) toast("Added to chart", res.name || "", "ok", 2600);
      else toast("Saved", res.name || "", "", 2400);
      return true;
    }

    function pineOpen(id) {
      var list = pineList(), s = null, i;
      for (i = 0; i < list.length; i++) if (list[i].id === id) s = list[i];
      if (!s) { pineNew(); return; }
      pineEd.id = s.id;
      pineEd.name = s.name;
      pineEd.dirty = false;
      pineEd.ta.value = s.source || "";
      store("cx.cv.pine.last", s.id);
      pineSyncFile();
      pineCompile();
      pineEd.ta.scrollTop = 0;
      pineSyncScroll();
      pinePos();
    }
    function pineNew() {
      pineEd.id = null;
      pineEd.name = "Untitled";
      pineEd.dirty = false;
      pineEd.ta.value = PINE_NEW;
      pineSyncFile();
      pineCompile();
      pineEd.ta.focus();
      pineEd.ta.setSelectionRange(0, 0);
      pinePos();
    }
    function pineDelete() {
      var nm = pineEd.name;
      if (pineEd.id) {
        try { window.ChartView.pineRemove(pineEd.id); } catch (e) { /* already gone */ }
      }
      var list = pineList();
      if (list.length) pineOpen(list[0].id); else pineNew();
      toast("Script deleted", nm, "", 2200);
    }
    /* Renaming rewrites the indicator("…") title in the source rather than the
       id — the id is what an on-chart instance is attached to, so changing it
       would orphan the drawing and leave a duplicate behind. */
    function pineRename() {
      var inp = el("input", { type: "text", class: "cv-pe-input", value: pineEd.name || "Untitled" });
      var body = el("div", { class: "cv-pe-form" }, [
        el("label", { text: "Indicator title" }),
        inp,
        el("div", { class: "hint", text: "Shown on the chart legend and in the Indicators list." })
      ]);
      var close = openModal("Rename script", body, [
        el("button", { class: "cv-btn", text: "Cancel", onclick: function () { close(); } }),
        el("button", { class: "cv-btn cv-btn-primary", text: "Rename", onclick: function () {
          var nm = (inp.value || "").trim();
          if (!nm) { close(); return; }
          var src = pineEd.ta.value;
          /* The version pragma has to stay on line 1 — the lexer reads it
             before it parses anything — so both branches keep it in the lead
             rather than prepending the call over the top of it. */
          var re = /^(\s*(?:\/\/@version=\d+[^\n]*\n\s*)?(?:indicator|strategy|library)\s*\(\s*)(["'])(?:(?:\\.|[^\\])*?)\2/;
          if (re.test(src)) {
            src = src.replace(re, function (m, a, q) {
              return a + q + nm.replace(/(["'\\])/g, "\\$1") + q;
            });
          } else {
            var ver = "", rest = src;
            rest = src.replace(/^\s*\/\/@version=\d+[^\n]*\n?/, function (v) { ver = v; return ""; });
            if (ver && !/\n$/.test(ver)) ver += "\n";
            src = ver + "indicator(" + JSON.stringify(nm) + ", overlay=true)\n" + rest;
          }
          pineEd.ta.value = src;
          pineEd.name = nm;
          pineEd.dirty = false;
          close();
          pineCompile();
          if (pineEd.id) pineApply(false); else pineSyncFile();
        } })
      ], true);
      setTimeout(function () { inp.focus(); inp.select(); }, 0);
    }

    function pineFileMenu() {
      var list = pineList();
      var items = [{ header: "My scripts" }];
      if (!list.length) items.push({ label: "No saved scripts yet", onclick: pineNew });
      list.forEach(function (s) {
        items.push({
          label: s.name,
          hint: s.inputs ? s.inputs + (s.inputs === 1 ? " input" : " inputs") : "",
          on: s.id === pineEd.id,
          onclick: function () { pineOpen(s.id); }
        });
      });
      items.push({ sep: true });
      items.push({ label: "New script", onclick: pineNew });
      openMenu(pineEd.file, items);
    }

    function pineBuild() {
      if (pineEd.built) return;
      pineEd.built = true;

      var grip = el("div", { class: "cv-pine-grip", title: "Drag to resize" });
      var file = el("button", { class: "cv-pine-file", title: "Open a saved script" });
      var newB = el("button", { class: "cv-pe-btn", text: "+", title: "New script" });
      var renB = el("button", { class: "cv-pe-btn", text: "Rename", title: "Rename this script" });
      var delB = el("button", { class: "cv-pe-btn", text: "Delete", title: "Delete this script" });
      var savB = el("button", { class: "cv-pe-btn", text: "Save", title: "Save  \u00b7 Ctrl+S" });
      var addB = el("button", { class: "cv-pe-btn primary", text: "Add to chart", title: "Add to chart  \u00b7 Ctrl+Enter" });
      var clsB = el("button", { class: "cv-pe-btn icon", html: ICON.x, title: "Close the Pine Editor" });
      var gut  = el("div", { class: "cv-pine-gutter" });
      var hl   = el("pre", { class: "cv-pine-hl" });
      var ta   = el("textarea", { class: "cv-pine-ta", spellcheck: "false",
                                  autocapitalize: "off", autocomplete: "off", wrap: "off" });
      var pos  = el("span", { class: "cv-pine-pos", text: "Ln 1, Col 1" });
      var msg  = el("span", { class: "cv-pine-msg ok", text: "Ready" });

      pineEd.file = file; pineEd.gut = gut; pineEd.hl = hl; pineEd.ta = ta;
      pineEd.msg = msg; pineEd.pos = pos; pineEd.addBtn = addB;

      pineWrap.appendChild(grip);
      pineWrap.appendChild(el("div", { class: "cv-pine-head" }, [
        file, newB, renB, delB,
        el("span", { class: "spacer" }),
        savB, addB, clsB
      ]));
      pineWrap.appendChild(el("div", { class: "cv-pine-body" }, [
        gut, el("div", { class: "cv-pine-code" }, [hl, ta])
      ]));
      pineWrap.appendChild(el("div", { class: "cv-pine-status" }, [pos, el("span", { class: "spacer" }), msg]));

      file.onclick = pineFileMenu;
      newB.onclick = pineNew;
      renB.onclick = pineRename;
      delB.onclick = pineDelete;
      savB.onclick = function () { pineApply(false); };
      addB.onclick = function () { pineApply(true); };
      clsB.onclick = function () { pineToggle(false); };
      msg.onclick = pineGoto;

      ta.addEventListener("input", function () {
        if (pineEd.dirty !== true) { pineEd.dirty = true; pineSyncFile(); }
        pineCompile();
        pinePos();
      });
      ta.addEventListener("scroll", pineSyncScroll);
      ta.addEventListener("keyup", pinePos);
      ta.addEventListener("click", pinePos);
      ta.addEventListener("select", pinePos);
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Tab") {
          /* The lexer counts a tab as four columns (lex: ind += 4), so the
             editor writes four spaces and Shift+Tab peels back a tab's worth. */
          e.preventDefault();
          var v = ta.value, s = ta.selectionStart, t = ta.selectionEnd;
          if (e.shiftKey) {
            var ls = v.lastIndexOf("\n", s - 1) + 1;
            var m = /^(?: {1,4}|\t)/.exec(v.slice(ls, s));
            var cut = m ? m[0].length : 0;
            if (cut) { v = v.slice(0, ls) + v.slice(ls + cut); s -= cut; t -= cut; }
          } else {
            v = v.slice(0, s) + "    " + v.slice(t);
            s = t = s + 4;
          }
          ta.value = v;
          ta.setSelectionRange(s, t);
          pineEd.dirty = true; pineSyncFile();
          pineCompile(); pinePos();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); pineApply(true); return; }
        if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); pineApply(false); }
      });

      grip.addEventListener("mousedown", function (e) {
        e.preventDefault();
        var y0 = e.clientY, h0 = pineWrap.offsetHeight;
        function mv(ev) {
          var h = h0 + (y0 - ev.clientY);
          h = Math.max(140, Math.min(window.innerHeight - 240, h));
          pineWrap.style.height = h + "px";
          if (resizeHandler) resizeHandler();
        }
        function up() {
          window.removeEventListener("mousemove", mv);
          window.removeEventListener("mouseup", up);
          store("cx.cv.pine.h", pineWrap.offsetHeight);
        }
        window.addEventListener("mousemove", mv);
        window.addEventListener("mouseup", up);
      });
    }

    /* autoSize is driven by a ResizeObserver, whose callbacks ride the
       rendering pipeline — so nothing guarantees it has run by the time the
       rest of the layout has already moved, and with the window hidden it may
       not run at all. Opening this panel changes the chart's geometry in one
       step, so the size is written explicitly rather than waited on. LWC
       short-circuits a resize to the size it already has, which is why the
       option has to be dropped first: without that the write is a no-op. */
    var fitW = 0, fitH = 0;
    function fitChart() {
      if (!chart || !chartHost) return;
      var w = chartHost.clientWidth, h = chartHost.clientHeight;
      if (!w || !h || (w === fitW && h === fitH)) return;
      fitW = w; fitH = h;
      try {
        var as = !!(chart.options && chart.options().autoSize);
        if (as) chart.applyOptions({ autoSize: false });
        /* LWC ignores a resize to the size it already believes it has, and the
           panes keep whatever height they were first laid out at — the first
           layout runs before the flex row has settled, so that height can be
           wrong by the scrollbar's worth and clip the time scale. Stepping one
           pixel off the real height and straight back makes the pane maths run
           again; both calls are synchronous, so the intermediate size is
           never painted. */
        chart.resize(w, h - 1);
        chart.resize(w, h);
        if (as) chart.applyOptions({ autoSize: true });
      } catch (e) { /* mid-teardown — leave it for the observer */ }
    }

    /* The chart is auto-sized off `.cv-body`, so opening the panel only has to
       flip the class — but the overlay canvas and the pane heights are ours,
       and both need a pass once the flex row has actually re-laid out. */
    function pineToggle(force) {
      if (!pineEd.built) {
        pineBuild();
        pineWrap.style.height = (recall("cx.cv.pine.h", 340) || 340) + "px";
      }
      var on = force === undefined ? !pineWrap.classList.contains("on") : !!force;
      pineWrap.classList.toggle("on", on);
      if (on) {
        if (!pineEd.ta.value) {
          var last = recall("cx.cv.pine.last", "");
          var has = listHas(pineList(), last);
          if (last && has) pineOpen(last); else pineNew();
        }
        setTimeout(function () { pineEd.ta.focus(); pinePos(); }, 0);
      }
      fitChart();
      if (resizeHandler) resizeHandler();
      /* The flex row settles after this frame; re-run once it has so the pane
         factors are applied against the final height rather than the old one. */
      setTimeout(function () {
        fitChart();
        if (resizeHandler) resizeHandler();
      }, 60);
    }
    function listHas(list, id) {
      if (!id) return false;
      return list.some(function (s) { return s.id === id; });
    }
    function openPineEditor() { pineToggle(); }

    var prodBtn = rsBtn("products", "rtProducts", "Products", function () {
      openMenu(prodBtn, [
        { header: "Products" },
        { label: "Screener", onclick: function () { goRoute("#/screener"); } },
        { label: "Scans", onclick: function () { goRoute("#/scans"); } },
        { label: "Watchlist", onclick: function () { goRoute("#/watchlist"); } },
        { label: "Alerts", onclick: function () { goRoute("#/alerts"); } },
        { label: "API", onclick: function () { goRoute("#/api"); } }
      ]);
    });
    var rstrip = el("div", { class: "cv-rstrip" });
    [
      rsBtn("watch", "rtWatch", "Watchlist, details, and news", openWatchPanel),
      rsBtn("alerts", "rtAlerts", "Alerts", openAlertsPanel),
      rsBtn("tree", "rtTree", "Object tree and data window", openObjectTree),
      el("div", { class: "cv-rfill" }),
      rsBtn("copilot", "rtCopilot", "AI Copilot", function () { rsSoon("AI Copilot"); }),
      rsBtn("screener", "rtScreeners", "Screeners", function () { goRoute("#/screener"); }),
      rsBtn("pine", "rtPine", "Pine Editor", openPineEditor),
      rsBtn("calendar", "rtCalendar", "Calendars", function () { rsSoon("Calendars"); }),
      rsBtn("community", "rtCommunity", "Community", function () { rsSoon("Community"); }),
      rsBtn("notify", "rtBell", "Notifications", openNotifyPanel),
      rsBtn("chats", "rtChats", "Chats", function () { rsSoon("Chats"); }),
      prodBtn,
      el("hr", { class: "cv-rdiv" }),
      rsBtn("help", "rtHelp", "Help Center", openHelpPanel)
    ].forEach(function (n) { rstrip.appendChild(n); });

    var viewEl = el("div", { class: "cv" }, [
      el("div", { class: "cv-top" }, [
        backBtn,
        el("div", { class: "cv-search" }, [
          el("span", { class: "mag", html: ICON.search }),
          searchInput
        ]),
        dataTypeBtn,
        compareBtn,
        el("span", { class: "cv-sep" }),
        tfWrapBox,
        chartTypeBtn,
        el("span", { class: "cv-sep" }),
        indsBtn,
        tplBtn,
        el("span", { class: "cv-sep" }),
        alertBtn,
        replayBtn,
        el("span", { class: "cv-sep" }),
        undoBtn,
        redoBtn,
        el("span", { class: "cv-sep" }),
        layoutBtn,
        saveBtn,
        manageBtn,
        el("span", { class: "cv-sep" }),
        el("div", { class: "cv-group cv-tb-zoom" }, [zoomOut, zoomIn, zoomReset, refreshBtn]),
        el("span", { class: "spacer" }),
        quickBtn,
        settingsBtn,
        fsBtn,
        snapBtn,
        shareBtn,
        tradeBtn
      ]),
      quickRow,
      el("div", { class: "cv-body" }, [toolsWrap, mainWrap, rstrip]),
      pineWrap,
      el("div", { class: "cv-fbar" }, [
        dateRangeBtn,
        rangeTabs,
        gotoBtn,
        el("span", { class: "spacer" }),
        statusEl,
        barsWrap,
        tzBtn,
        adjBtn
      ])
    ]);

    view.appendChild(viewEl);

    /* --------------------------------------------------- build controls */
    TIMEFRAMES.forEach(function (tf) {
      var b = el("button", {
        text: tf, title: "Timeframe " + tf,
        onclick: function () {
          changeInterval(tf);
          if (tfOpen) toggleTfPop();
        }
      });
      if (tf === st.interval) b.classList.add("on");
      b.dataset.tf = tf;
      tfWrap.appendChild(b);
    });

    BAR_COUNTS.forEach(function (n) {
      var isAll = n === 0;
      var b = el("button", {
        text: isAll ? "ALL" : String(n),
        title: isAll ? "All history — every bar the exchange has, no time limit"
                     : "Load " + n + " bars",
        onclick: function () { changeLimit(n); }
      });
      if (n === st.limit) b.classList.add("on");
      b.dataset.bars = String(n);
      barsWrap.appendChild(b);
    });

    /* ------------------------------------------------- left drawing rail
       TradingView's rail is a column of *tool groups*: one button per group
       showing that group's last-used tool, a small triangle that opens a
       flyout of the rest. Click selects, press-and-hold (or the triangle)
       opens the flyout. */
    var groupBtns = {};
    var groupPick = {};
    var flyout = null;
    var magnetTool, keepTool, lockTool, hideTool, clearTool, favTool, favBarEl;

    function toolById(id) {
      for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].id === id) return TOOLS[i];
      return null;
    }

    function toolTip(id) {
      var t = toolById(id);
      if (!t) return id;
      return t.label + (t.key ? "  (" + t.key + ")" : "");
    }

    function closeFlyout() {
      if (!flyout) return;
      var f = flyout;
      flyout = null;
      if (f.node && f.node.parentNode) f.node.parentNode.removeChild(f.node);
      document.removeEventListener("mousedown", f.onDoc, true);
      window.removeEventListener("scroll", f.onDoc, true);
    }

    /* ------------------------------------------- favourites (TV "pin") */
    function isFav(id) { return st.favs.indexOf(id) >= 0; }

    function toggleFav(id) {
      var i = st.favs.indexOf(id);
      if (i >= 0) st.favs.splice(i, 1); else st.favs.push(id);
      store("cx.cv.favs", st.favs);
      syncFlyoutStars();
      syncFavBar();
    }

    /* The star sits inside a row that is itself a <button>; browsers close an
       outer <button> when a nested one is parsed, so the star is a span with
       button semantics. */
    function syncFlyoutStars() {
      if (!flyout || !flyout.node) return;
      $$(".cv-fly[data-tool]", flyout.node).forEach(function (row) {
        var s = row.querySelector(".cv-fstar");
        if (!s) return;
        var fav = isFav(row.dataset.tool);
        s.classList.toggle("on", fav);
        s.innerHTML = fav ? ICON.favStar : ICON.star;
        s.setAttribute("title", fav ? "Remove from favorites" : "Add to favorites");
        s.setAttribute("aria-label", fav ? "Remove from favorites" : "Add to favorites");
      });
    }

    function openFlyout(group, anchor) {
      if (flyout && flyout.group === group.id) { closeFlyout(); return; }
      closeFlyout();
      var node = el("div", { class: "cv-flyout cv-tools-menu" });
      group.sections.forEach(function (sec) {
        if (sec[0]) node.appendChild(el("div", { class: "cv-fhead", text: sec[0] }));
        sec[1].forEach(function (id) {
          var t = toolById(id);
          if (!t) return;
          var row = el("button", { class: "cv-fly" }, [el("span", { class: "i", html: ICON[id] || "" }), el("span", { class: "n" })]);
          row.querySelector(".n").textContent = t.label;
          row.dataset.tool = id;
          if (groupPick[group.id] === id) row.classList.add("on");
          if (t.key) {
            var k = el("span", { class: "k" });
            k.textContent = t.key;
            row.appendChild(k);
          }
          /* TradingView's own control: a star at the end of every flyout row
             that pins the tool onto the floating favourites bar. */
          var faved = isFav(id);
          var star = el("span", {
            class: "cv-fstar" + (faved ? " on" : ""), role: "button", tabindex: "-1",
            title: faved ? "Remove from favorites" : "Add to favorites",
            "aria-label": faved ? "Remove from favorites" : "Add to favorites",
            html: faved ? ICON.favStar : ICON.star
          });
          star.onclick = function (ev) {
            ev.stopPropagation();
            ev.preventDefault();
            toggleFav(id);
          };
          row.appendChild(star);
          row.onclick = function () { groupPick[group.id] = id; setTool(id); closeFlyout(); };
          node.appendChild(row);
        });
      });
      var r = anchor.getBoundingClientRect();
      node.style.position = "fixed";
      node.style.left = (r.right + 7) + "px";
      node.style.top = Math.max(6, Math.min(window.innerHeight - 40, r.top - 6)) + "px";
      document.body.appendChild(node);
      /* Keep the flyout on screen when the rail sits near the viewport edge. */
      var b = node.getBoundingClientRect();
      if (b.bottom > window.innerHeight - 6) node.style.top = Math.max(6, window.innerHeight - b.height - 6) + "px";
      var onDoc = function (ev) {
        if (node.contains(ev.target) || anchor.contains(ev.target)) return;
        closeFlyout();
      };
      flyout = { group: group.id, node: node, onDoc: onDoc };
      setTimeout(function () {
        document.addEventListener("mousedown", onDoc, true);
        window.addEventListener("scroll", onDoc, true);
      }, 0);
    }

    function mkGroupBtn(group) {
      /* Every TradingView rail group carries the corner triangle, even the
         ones holding a single tool — that is how the flyout stays reachable. */
      var b = el("button", { class: "cv-tool cv-grp" }, [
        el("span", { class: "ico" }),
        el("span", { class: "cv-tchev", html: ICON.chev })
      ]);
      b.dataset.group = group.id;
      b.setAttribute("aria-haspopup", "true");
      var chev = b.querySelector(".cv-tchev");
      var hold = 0, held = false;
      function cancel() { if (hold) { clearTimeout(hold); hold = 0; } }
      b.addEventListener("mousedown", function () {
        held = false; cancel();
        if (chev) hold = setTimeout(function () { hold = 0; held = true; openFlyout(group, b); }, 380);
      });
      b.addEventListener("mouseup", cancel);
      b.addEventListener("mouseleave", cancel);
      b.addEventListener("click", function () {
        if (held) { held = false; return; }
        setTool(groupPick[group.id] || groupTools(group)[0]);
      });
      if (chev) {
        chev.addEventListener("mousedown", function (e) { e.stopPropagation(); cancel(); });
        chev.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); openFlyout(group, b); });
      }
      groupBtns[group.id] = b;
      return b;
    }

    /* ------------------------------------------- favourites bar (TV pin) */
    function favButton(id) {
      var t = toolById(id);
      var b = el("button", {
        class: "cv-tool", html: ICON[id] || "", "data-tip": toolTip(id),
        title: t ? t.label : id, onclick: function () { setTool(id); }
      });
      b.dataset.tool = id;
      return b;
    }

    function syncFavBar() {
      /* TradingView keeps "Show Favorite Drawing Tools Toolbar" on the rail at
         all times, even before anything is starred. */
      if (favTool) {
        var has = st.favs.length > 0;
        favTool.hidden = false;
        favTool.classList.toggle("on", has && !!st.favBar);
        var tip = !has ? "Favorite drawing tools — star one in its menu"
          : st.favBar ? "Hide favorite drawing tools toolbar"
          : "Show favorite drawing tools toolbar";
        favTool.setAttribute("data-tip", tip);
        favTool.setAttribute("title", tip);
      }
      if (!favBarEl) return;
      favBarEl.textContent = "";
      if (!st.favs.length || !st.favBar) { favBarEl.style.display = "none"; return; }
      st.favs.forEach(function (id) { if (toolById(id)) favBarEl.appendChild(favButton(id)); });
      if (!favBarEl.childNodes.length) { favBarEl.style.display = "none"; return; }
      if (st.favPos) {
        favBarEl.style.left = st.favPos.left + "px";
        favBarEl.style.top = st.favPos.top + "px";
        favBarEl.style.right = "auto";
      }
      favBarEl.style.display = "flex";
    }

    /* TradingView's favourites toolbar is a floating, draggable strip pinned
       over the chart — dragging it once stores the spot it was dropped in. */
    function wireFavDrag() {
      favBarEl.addEventListener("mousedown", function (e) {
        var r = favBarEl.getBoundingClientRect();
        var host = mainWrap.getBoundingClientRect();
        var sx = e.clientX, sy = e.clientY;
        var ox = e.clientX - r.left, oy = e.clientY - r.top;
        var moved = false;
        function mv(ev) {
          if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
          moved = true;
          var x = clamp(ev.clientX - host.left - ox, 0, Math.max(0, host.width - r.width));
          var y = clamp(ev.clientY - host.top - oy, 0, Math.max(0, host.height - r.height));
          favBarEl.style.left = x + "px";
          favBarEl.style.top = y + "px";
          favBarEl.style.right = "auto";
          favBarEl.classList.add("drag");
        }
        function up() {
          document.removeEventListener("mousemove", mv, true);
          document.removeEventListener("mouseup", up, true);
          favBarEl.classList.remove("drag");
          if (moved) {
            st.favPos = { left: parseFloat(favBarEl.style.left) || 0, top: parseFloat(favBarEl.style.top) || 0 };
            store("cx.cv.favpos", st.favPos);
          }
        }
        document.addEventListener("mousemove", mv, true);
        document.addEventListener("mouseup", up, true);
        if (e.cancelable) e.preventDefault();
      });
    }

    function syncRail() {
      var act = activeToolId();
      TOOL_GROUPS.forEach(function (g) {
        var b = groupBtns[g.id];
        if (!b) return;
        var id = groupPick[g.id] || groupTools(g)[0];
        var ico = b.querySelector(".ico");
        if (ico) ico.innerHTML = ICON[id] || ICON[groupTools(g)[0]] || "";
        b.classList.toggle("on", act === id);
        b.setAttribute("data-tip", toolTip(id));
        b.setAttribute("title", toolById(id) ? toolById(id).label : id);
      });
      $$(".cv-tool[data-tool]", toolsWrap).forEach(function (b) {
        b.classList.toggle("on", b.dataset.tool === act);
      });
      if (magnetTool) magnetTool.classList.toggle("on", st.magnet);
      if (lockTool) lockTool.classList.toggle("on", st.locked);
      if (keepTool) keepTool.classList.toggle("on", !!st.sticky);
      if (hideTool) hideTool.classList.toggle("on", !!st.hideDrawings);
      syncFavBar();
    }

    TOOL_GROUPS.forEach(function (g) {
      var tools = groupTools(g);
      var pick = recall("cx.cv.toolgrp." + g.id, null);
      if (!pick || tools.indexOf(pick) < 0) pick = tools.indexOf(st.tool) >= 0 ? st.tool : tools[0];
      groupPick[g.id] = pick;
    });
    TOOL_GROUPS.forEach(function (g) { toolsWrap.appendChild(mkGroupBtn(g)); });
    toolsWrap.appendChild(el("div", { class: "cv-tsep" }));

    /* Measure + Zoom in sit in their own group on the live TradingView rail. */
    ["measure", "zoomregion"].forEach(function (id) {
      var b = el("button", {
        class: "cv-tool", html: ICON[id], "data-tip": toolTip(id),
        title: toolById(id).label, onclick: function () { setTool(id); }
      });
      b.dataset.tool = id;
      toolsWrap.appendChild(b);
    });
    toolsWrap.appendChild(el("div", { class: "cv-tsep" }));

    magnetTool = el("button", {
      class: "cv-tool" + (st.magnet ? " on" : ""), html: ICON.magnet,
      "data-tip": "Magnet mode — snap drawings to OHLC", title: "Magnet mode — snap drawings to OHLC", onclick: toggleMagnet
    });
    keepTool = el("button", {
      class: "cv-tool" + (st.sticky ? " on" : ""), html: ICON.keepdraw,
      "data-tip": "Keep drawing — stay in the tool after placing", title: "Keep drawing — stay in the tool after placing", onclick: toggleSticky
    });
    lockTool = el("button", {
      class: "cv-tool" + (st.locked ? " on" : ""), html: st.locked ? ICON.lock : ICON.unlock,
      "data-tip": "Lock drawings", title: "Lock drawings", onclick: toggleLock
    });
    hideTool = el("button", {
      class: "cv-tool" + (st.hideDrawings ? " on" : ""), html: st.hideDrawings ? ICON.eye : ICON.eyeOff,
      "data-tip": "Hide all drawings", title: "Hide all drawings", onclick: toggleHidden
    });
    toolsWrap.appendChild(magnetTool);
    toolsWrap.appendChild(keepTool);
    toolsWrap.appendChild(lockTool);
    toolsWrap.appendChild(hideTool);
    toolsWrap.appendChild(el("div", { class: "cv-tsep" }));

    clearTool = el("button", {
      class: "cv-tool danger", html: ICON.trashAll,
      "data-tip": "Remove objects", title: "Remove objects", onclick: clearDrawings
    });
    toolsWrap.appendChild(clearTool);

    /* TradingView parks the favourites toggle at the very bottom of the rail;
       it only appears once something has been starred. */
    favTool = el("button", {
      class: "cv-tool cv-favtoggle", html: ICON.star,
      "data-tip": "Favorite drawing tools — star one in its menu",
      title: "Favorite drawing tools — star one in its menu",
      onclick: function () {
        if (!st.favs.length) {
          toast("Star a tool in its menu to pin it here");
          return;
        }
        st.favBar = !st.favBar;
        store("cx.cv.favbar", st.favBar);
        syncFavBar();
      }
    });
    toolsWrap.appendChild(favTool);
    toolsWrap.appendChild(el("div", { class: "cv-tsep" }));

    /* Indicator presets live on the tools rail — save the current indicator
       set under a name, then load it back later with every setting intact. */
    toolsWrap.appendChild(el("button", {
      class: "cv-tool cv-presetbtn", html: ICON.templates,
      "data-tip": "Indicator presets — save this set & its settings, or load one",
      title: "Indicator presets — save this set of indicators & their settings, or load one",
      onclick: openPresetDialog
    }));
    toolsWrap.appendChild(el("div", { class: "cv-tspace" }));
    toolsWrap.appendChild(colorInput);

    /* The pinned toolbar itself floats over the plot, top-right by default. */
    favBarEl = el("div", { class: "cv-favbar", "aria-label": "Favorite drawing tools toolbar" });
    mainWrap.appendChild(favBarEl);
    wireFavDrag();
    syncRail();

    /* -------------------------------------------------------- chart */
    function chartHeight() {
      return Math.max(360, Math.min(760, (window.innerHeight || 800) - 330));
    }
    mainWrap.style.setProperty("--cv-h", chartHeight() + "px");

    chart = LW.createChart(chartHost, {
      autoSize: true,
      layout: {
        background: { type: LW.ColorType.Solid, color: TV.bg },
        textColor: TV.fg,
        fontSize: 12,
        fontFamily: TV.font,
        panes: { enableResize: true, separatorColor: TV.sep, separatorHoverColor: TV.sepHover }
      },
      /* TradingView always rules the canvas — the grid is a large part of why a
         chart reads as TV at a glance. TV.fg-grid composites to rgb(60,60,60)
         over the #0f0f0f canvas, which is exactly what tv.com draws. */
      grid: {
        vertLines: { color: TV.grid, visible: true },
        horzLines: { color: TV.grid, visible: true }
      },
      crosshair: {
        mode: LW.CrosshairMode.Normal,
        vertLine: { color: TV.cross, width: 1, style: 3, labelBackgroundColor: TV.crossLabel },
        horzLine: { color: TV.cross, width: 1, style: 3, labelBackgroundColor: TV.crossLabel }
      },
      watermark: {
        visible: true,
        text: (st.symbol || "").replace(/USDT$/, ""),
        color: TV.watermark,
        fontSize: 74,
        horzAlign: "center",
        vertAlign: "center"
      },
      /* tv.com leaves 8% top and bottom on the price scale. The bottom margin
         used to be 0.24 to make room for volume, back when the histogram
         shared this pane as a pane-height strip; volume is an overlay on the
         unnamed scale again and buys its own band with scaleMargins, so the
         price scale no longer needs to reserve anything. */
      rightPriceScale: { borderColor: TV.scale, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: {
        borderColor: TV.scale,
        timeVisible: st.interval === "15m" || st.interval === "1h" || st.interval === "4h",
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 8,
        /* 0.5 stopped "fit all" at ~2200 bars, so a full history could never
           be seen in one screen.  0.1 lets the whole thing on the page. */
        minBarSpacing: 0.1
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } }
    });

    candleSeries = chart.addSeries(seriesClassFor(st.chartType), seriesOptionsFor(st.chartType));
    applyTz();

    /* ------------------------------------------------------ indicators */
    /* Custom formatters keep the price axis in the app's own number style;
       minMove is pinned so tick stepping stays identical to the LW default. */
    function pf(fn) { return { type: "custom", formatter: fn, minMove: 0.01 }; }
    var PF_PRICE = pf(fmtPrice);
    var PF_VOL = pf(fmtCompact);

    function pfFixed(n) {
      return {
        type: "custom",
        formatter: function (v) { return Number(v).toFixed(n); },
        minMove: Math.pow(10, -n)
      };
    }
    /* TradingView's Area style fades its fill from the line down to the baseline,
     so the bottom colour keeps the hue but drops the alpha to `k`. */
  function fadeColour(c, k) {
    if (typeof c !== "string") return c;
    var m = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (m) {
      var a = m[4] === undefined ? 1 : parseFloat(m[4]);
      return "rgba(" + m[1] + ", " + m[2] + ", " + m[3] + ", " + (a * k) + ")";
    }
    if (c.charAt(0) === "#") {
      var h = c.slice(1);
      if (h.length === 3) h = h.replace(/./g, function (g) { return g + g; });
      if (h.length >= 6) {
        return "rgba(" + parseInt(h.slice(0, 2), 16) + ", " + parseInt(h.slice(2, 4), 16) +
               ", " + parseInt(h.slice(4, 6), 16) + ", " + k + ")";
      }
    }
    return c;
  }

  function mkSeries(host, p) {
      var s;
      var n = (p.precision === undefined || p.precision === "" || p.precision === "Default")
        ? -1 : parseInt(p.precision, 10);
      var fmt = p.volume ? PF_VOL : (isNum(n) && n >= 0 ? pfFixed(n) : PF_PRICE);
      var kind = p.style ? plotStyleKind(p.style)
        : p.type === "hist" ? "hist"
          : p.type === "area" ? "area" : "line";
      /* Volume rides the unnamed overlay scale (""), which LWC keeps off the
         price axis entirely — its ~1e9 numbers would otherwise blow the candle
         scale to pieces. The floor/ceiling comes from the study's own
         autoscale block, not from the data range, so bar 0 always sits on the
         pane edge. */
      var extra = {};
      if (p.overlayScale) extra.priceScaleId = "";
      /* A bgcolor() wash lives on a scale of its own. Pinned to the candle
         scale its numbers would stretch the axis past recognition; pinned to
         the unnamed overlay scale it would squash volume, which shares that
         scale. A private id keeps both untouched. */
      if (p.bgScale) extra.priceScaleId = "cvbg";
      if (p.autoscale) {
        var ac = p.autoscale;
        extra.autoscaleInfoProvider = function () {
          return { priceRange: { minValue: ac.minValue, maxValue: ac.maxValue } };
        };
      }
      if (kind === "hist") {
        s = host.addSeries(LW.HistogramSeries, Object.assign({
          color: p.color || "#3b82f6",
          priceFormat: fmt,
          priceLineVisible: false,
          lastValueVisible: false
        }, extra));
      } else if (kind === "area") {
        /* TradingView's pane background fills are an area pinned between two
           levels; a plain Area plot style keeps its line and the zero baseline. */
        var band = p.type === "area" && p.base != null;
        var tc = p.color2 || p.color || "#3b82f6", bc = p.color || p.color2 || "#3b82f6";
        s = host.addSeries(LW.AreaSeries, Object.assign({
          lineVisible: !band,
          lineColor: band ? "transparent" : (p.color || "#3b82f6"),
          lineWidth: p.width || 1,
          lineStyle: p.lineStyle || 0,
          baseValue: { type: "price", price: p.base != null ? p.base : 0 },
          /* Lightweight Charts paints an area with `topColor` / `bottomColor`.
             The v3 names `topFillColor` / `bottomFillColor` are still accepted
             by options() but are not what the renderer reads — leaving them
             alone made every fill here come out LWC green instead. A band is
             flat, while a plain Area fades out towards its baseline. */
          topColor: tc,
          bottomColor: band ? bc : fadeColour(bc, 0),
          priceFormat: fmt,
          priceLineVisible: false,
          lastValueVisible: band ? false : p.lastValue !== false,
          crosshairMarkerVisible: false
        }, extra));
      } else {
        s = host.addSeries(LW.LineSeries, Object.assign({
          color: p.color || "#3b82f6",
          lineWidth: p.width || 2,
          lineStyle: p.lineStyle || 0,
          priceLineVisible: false,
          lastValueVisible: p.lastValue !== false,
          crosshairMarkerVisible: false,
          priceFormat: fmt
        }, extra));
      }
      s.setData(p.data || []);
      return s;
    }

    /* Volume is an overlay on the main pane, so the scale it shares with
       nothing else gets squeezed into the bottom quarter: TradingView's strip
       is 194px on a 777px chart. The scale margins are what buy the band back,
       and the series has to be pushed to order 0 or the histogram paints over
       the candles. The scale only exists once a series is on it, hence being
       called after mkSeries rather than at chart creation. */
    function pinVolumeStrip(list) {
      try { chart.priceScale("").applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } }); }
      catch (e) { /* scale not live yet — the strip just takes the full pane */ }
      (list || []).forEach(function (s, i) {
        try { s.setSeriesOrder(i); } catch (e) { /* older LWC */ }
      });
    }

    function buildInstance(inst) {
      var study = STUDY_MAP[inst.id];
      if (!study || !data) return;
      /* Layouts saved before a field existed pick up the new default here. */
      inst.params = Object.assign(clone(study.defaults), inst.params);
      /* An earlier build shipped the histogram fades as 35%-alpha tints of the
         dark colours; TradingView's are pale, opaque greens/reds. */
      if (inst.id === "macd") {
        if (/^rgba\(38,\s*166,\s*154/.test(inst.params.histUpFade || "")) inst.params.histUpFade = "#b2dfdb";
        if (/^rgba\(255,\s*82,\s*82/.test(inst.params.histDnFade || "")) inst.params.histDnFade = "#ffcdd2";
      }
      /* Volume's bars used to be stored pre-composited over the #0f0f0f
         canvas; they are real 50%-alpha colours now, so a layout saved under
         the old scheme would be darkened a second time. Lift the two legacy
         defaults back to TradingView's own hues. */
      if (inst.id === "volume") {
        if (inst.params.color === "#1a5a54") inst.params.color = "#26a69a";
        if (inst.params.color2 === "#7f312f") inst.params.color2 = "#ef5350";
      }
      /* The Visibility tab can switch an indicator off for this interval. */
      inst.hidden = !intervalVisible(inst.params.vis, st.interval);
      if (inst.hidden) {
        inst.series = []; inst.bgSeries = []; inst.pane = null; inst.markers = null;
        return;
      }
      var res;
      /* An indicator pinned to its own timeframe builds off that history. */
      var inj = null, tfv = inst.params.tf;
      if (tfv && tfv !== "Chart") {
        var wantSym = st.symbol;
        var got = offTfBars(st.symbol, tfv, data.time[0], function () {
          if (alive && st.symbol === wantSym) rebuildIndicators();
        });
        if (got) inj = { calc: got, map: offTfMap(data, got) };
      }
      try { res = study.build(data, inst.params, inj); }
      catch (e) { console.warn("[chartview] " + inst.id + " failed", e); return; }
      /* ---- TradingView Style tab: colour, thickness, line style, plot style,
         precision, axis labels and the show/hide checkbox, per plot. */
      var rows = study.srows || [];
      var rowFor = {}, rowByPl = {};
      rows.forEach(function (r) {
        if (r.p != null && rowFor[r.p] === undefined) rowFor[r.p] = r;
        if (r.pl != null) rowByPl[r.pl] = r;
      });
      (res.plots || []).forEach(function (plot, i) {
        var row = rowFor[i], prm = inst.params;
        plot.precision = prm.precision;
        if (prm.lblScale === false) plot.lastValue = false;
        if (!row) return;
        var col = colourOf(prm, row.c, row.cfb);
        if (col) plot.color = col;
        if (row.w && isNum(prm[row.w])) plot.width = prm[row.w];
        if (row.ls && prm[row.ls] != null) plot.lineStyle = prm[row.ls];
        if (row.ps && prm[row.ps]) plot.style = prm[row.ps];
        if (row.on && prm[row.on] === false) plot.data = [];
      });
      /* Last printed value of every visible plot — TradingView's status line. */
      inst.plotVals = (res.plots || []).map(function (plot, i) {
        var row = rowFor[i];
        if (row && row.on && inst.params[row.on] === false) return null;
        if (plot.type === "area") return null;
        var dd = plot.data;
        return dd && dd.length && isNum(dd[dd.length - 1].value) ? dd[dd.length - 1].value : null;
      });
      inst.series = [];
      inst.pane = null;
      inst.markers = res.markers || null;
      var mrow = rows.filter(function (r) { return r.markers; })[0];
      if (mrow && inst.params[mrow.on] === false) inst.markers = null;
      try {
        var pane = null;
        if (study.kind !== "overlay") {
          pane = chart.addPane();
          pane.setHeight(inst.params.paneHeight || study.defaults.paneHeight || 110);
          inst.pane = pane;
        }
        /* A bgcolor() wash belongs behind the candles and plots, and
           Lightweight Charts draws series in insertion order — so its bands go
           in first, and stay off `inst.series`, which holds the plots the
           legend and the status line speak for. */
        inst.bgSeries = (res.bgRuns || []).map(function (R) {
          return mkSeries(pane || chart, {
            type: "area", base: -1, color: R.color, color2: R.color,
            lastValue: false, bgScale: true,
            autoscale: { minValue: -1, maxValue: 1 }, data: R.data
          });
        });
        if (study.kind === "overlay") {
          (res.plots || []).forEach(function (p) { inst.series.push(mkSeries(chart, p)); });
          if (study.overlayScale) pinVolumeStrip(inst.series);
        } else {
          (res.plots || []).forEach(function (p) { inst.series.push(mkSeries(pane, p)); });
        }
        /* Every level line hangs off the study's main plot, so hiding a plot
           never detaches the remaining ones. */
        (res.priceLines || []).forEach(function (pl, i) {
          var row = rowByPl[i], prm = inst.params;
          if (row) {
            if (row.v != null && isNum(parseFloat(prm[row.v]))) pl.price = parseFloat(prm[row.v]);
            var c = colourOf(prm, row.c, row.cfb);
            if (c) pl.color = c;
            if (row.w && isNum(prm[row.w])) pl.lineWidth = prm[row.w];
            if (row.ls && prm[row.ls] != null) pl.lineStyle = prm[row.ls];
            if (row.on && prm[row.on] === false) return;
          }
          var host = inst.series[0];
          if (!host || !isNum(pl.price)) return;
          try {
            host.createPriceLine({
              price: pl.price, color: pl.color, lineWidth: pl.lineWidth || 1,
              lineStyle: pl.lineStyle != null ? pl.lineStyle : 2,
              lineVisible: true, axisLabelVisible: true, title: ""
            });
          } catch (e) { /* noop */ }
        });
      } catch (e) {
        console.warn("[chartview] could not build " + inst.id, e);
      }
      applyMarkers();
    }

    function destroyInstance(inst) {
      if (inst.pane) {
        try { chart.removePane(inst.pane.paneIndex()); }
        catch (e) { /* pane may already be gone */ }
        inst.pane = null;
      }
      (inst.series || []).forEach(function (s) {
        try { chart.removeSeries(s); } catch (e) { /* already removed with pane */ }
      });
      inst.series = [];
      (inst.bgSeries || []).forEach(function (s) {
        try { chart.removeSeries(s); } catch (e) { /* already removed with pane */ }
      });
      inst.bgSeries = [];
      inst.markers = null;
      applyMarkers();
    }

    function applyMarkers() {
      var all = [];
      st.indicators.forEach(function (inst) {
        (inst.markers || []).forEach(function (m) { all.push(m); });
      });
      all.sort(function (a, b) { return a.time - b.time; });
      try {
        if (!markerApi) {
          if (all.length) markerApi = LW.createSeriesMarkers(candleSeries, all);
        } else {
          markerApi.setMarkers(all);
        }
      } catch (e) { console.warn("[chartview] markers", e); }
    }

    /* Pane heights.
       Lightweight Charts derives pane pixel heights from *stretch factors*,
       and `setHeight()` on one pane quietly resets every other indicator pane
       back to its default, so only the last call ever sticks. Setting the
       factors directly — scaled so they sum to the space actually available —
       lands every pane on the height the settings dialog promised. */
    function paneTargetList() {
      var out = [];
      st.indicators.forEach(function (inst) {
        var study = STUDY_MAP[inst.id];
        if (!study || study.kind === "overlay" || inst.hidden) return;
        out.push(inst.params.paneHeight || study.defaults.paneHeight || 110);
      });
      return out;
    }

    /* Vertical space the panes share: host height − time axis − separators.
       Read from the DOM on purpose — summing getHeight() is only trustworthy
       once LWC has laid out against the *current* viewport, and a viewport
       that is resized and restored without a follow-up resize event otherwise
       pins the wrong proportions (the main pane collapsed to 143px once). */
    function paneSpace(ps) {
      var hostH = chartHost && chartHost.clientHeight ? chartHost.clientHeight : 0;
      if (hostH > 60) {
        var rows = chartHost.querySelectorAll(".tv-lightweight-charts table tr");
        if (rows.length >= 2 * ps.length) {
          var axis = rows[rows.length - 1].getBoundingClientRect().height;
          var expect = hostH - axis - (ps.length - 1);
          if (expect > 60) return expect;
        }
      }
      var P = 0, i;
      for (i = 0; i < ps.length; i++) {
        var h = 0;
        try { h = ps[i].getHeight(); } catch (e) { h = 0; }
        if (isNum(h)) P += h;
      }
      return P;
    }

    /* Stretch factors for the current panes — they sum to P, so LWC gives
       every pane exactly the pixel height written here. */
    function paneFactors(ps) {
      var P = paneSpace(ps);
      if (!(P > 60)) return null;
      var want = paneTargetList(), sum = 0, i;
      while (want.length < ps.length - 1) want.push(110);
      want.length = ps.length - 1;
      for (i = 0; i < want.length; i++) {
        want[i] = clamp(Math.round(want[i] || 110), 32, 360);
        sum += want[i];
      }
      /* Too many panes for this chart — shrink them all proportionally. */
      if (sum > P - 56) {
        var k = Math.max(0.05, (P - 56) / sum);
        sum = 0;
        for (i = 0; i < want.length; i++) {
          want[i] = Math.max(32, Math.round(want[i] * k));
          sum += want[i];
        }
      }
      return [Math.max(40, P - sum)].concat(want);
    }

    function applyPaneSizes() {
      var ps;
      try { ps = chart.panes(); } catch (e) { return; }
      if (!ps || ps.length < 2) return;
      var factors = paneFactors(ps);
      if (!factors) return;
      for (var i = 0; i < ps.length && i < factors.length; i++) {
        try { ps[i].setStretchFactor(factors[i]); } catch (e) { /* noop */ }
      }
      schedulePaneVerify();
    }

    /* Layout can settle after we have already written the factors, so the
       panes land on the wrong proportions with nothing left to re-run us.
       Check once things are quiet and correct while we are still off-target. */
    var paneVerifyTimer = 0, paneVerifyN = 0;
    function schedulePaneVerify() {
      if (paneVerifyTimer) clearTimeout(paneVerifyTimer);
      paneVerifyTimer = setTimeout(function () {
        paneVerifyTimer = 0;
        var ps;
        try { ps = chart.panes(); } catch (e) { return; }
        if (!ps || ps.length < 2) return;
        var want = paneFactors(ps);
        if (!want) return;
        var bad = false;
        for (var j = 0; j < ps.length && j < want.length; j++) {
          var hh = 0;
          try { hh = ps[j].getHeight(); } catch (e) { hh = -1; }
          if (!isNum(hh) || Math.abs(hh - want[j]) > 6) { bad = true; break; }
        }
        if (!bad) { paneVerifyN = 0; return; }
        if (paneVerifyN++ >= 6) { paneVerifyN = 0; return; }
        applyPaneSizes();
      }, 200);
    }

    var paneSizesTimer = 0;
    function schedulePaneSizes() {
      paneVerifyN = 0;
      applyPaneSizes();
      if (paneSizesTimer) clearTimeout(paneSizesTimer);
      paneSizesTimer = setTimeout(function () {
        paneSizesTimer = 0;
        applyPaneSizes();
      }, 80);
    }

    /* TradingView's Timeframe row (Inputs ▸ Calculation): an indicator can run
       on its own interval while the chart shows another one. Deriving those
       bars from the chart's bars only works as a warm-up — 16 days of 15m bars
       give 16 daily bars, nowhere near enough for MACD to print anything — so
       the indicator pulls its own history once per symbol/timeframe and reuses
       it. Falls back to the derived bars whenever it is still loading. */
    var offTfCache = {};
    var offTfBusy = {};
    var offTfWant = {};

    /* One value per chart bar: the newest indicator bar at or before it. */
    function offTfMap(chart, bars) {
      var map = new Array(chart.n), j = -1, i;
      for (i = 0; i < chart.n; i++) {
        while (j + 1 < bars.n && bars.time[j + 1] <= chart.time[i]) j++;
        map[i] = j;
      }
      return map;
    }

    function offTfBars(sym, tf, oldest, onReady) {
      var key = sym + "|" + tf, hit = offTfCache[key];
      var sec = tfSeconds(tf);
      if (!sec) return hit || null;
      var short = hit && oldest != null && hit.time[0] > oldest;
      if (hit && !short) return hit;
      if (offTfBusy[key]) return hit || null;
      /* Enough bars to cover the chart's span plus room to warm up. */
      var limit = 500;
      if (oldest != null) {
        limit = Math.max(500, Math.ceil((Date.now() / 1000 - oldest) / sec) + 400);
        limit = Math.min(limit, 40000);
      }
      /* Already asked for at least this much and the venue gave all it has —
         stop, or every rebuild would refetch forever. */
      if (hit && (offTfWant[key] || 0) >= limit) return hit;
      offTfWant[key] = limit;
      offTfBusy[key] = true;
      api("/api/chart/" + encodeURIComponent(sym) + "?interval=" + encodeURIComponent(tf) + "&limit=" + limit)
        .then(function (k) {
          offTfBusy[key] = false;
          var d = normalize(k);
          if (d.n) offTfCache[key] = d;
          onReady();
        })
        .catch(function () { offTfBusy[key] = false; });
      return hit || null;
    }

    function rebuildIndicators() {
      st.indicators.slice().forEach(destroyInstance);
      st.indicators.forEach(buildInstance);
      renderLegend();
      schedulePaneSizes();
      scheduleRedraw();
    }

    function addIndicator(id, params) {
      var study = STUDY_MAP[id];
      if (!study) return null;
      var inst = { uid: uid("ind"), id: id, params: Object.assign(clone(study.defaults), params || {}) };
      st.indicators.push(inst);
      buildInstance(inst);
      saveIndicators();
      renderLegend();
      schedulePaneSizes();
      scheduleRedraw();
      return inst;
    }

    function removeIndicator(uidv) {
      var i = st.indicators.findIndex(function (x) { return x.uid === uidv; });
      if (i < 0) return;
      var inst = st.indicators[i];
      destroyInstance(inst);
      st.indicators.splice(i, 1);
      saveIndicators();
      renderLegend();
      schedulePaneSizes();
      scheduleRedraw();
      toast("Indicator removed", studyLabel(inst), "", 2200);
    }

    function updateIndicator(uidv, params) {
      var inst = st.indicators.find(function (x) { return x.uid === uidv; });
      if (!inst) return;
      Object.assign(inst.params, params);
      rebuildIndicators();
      saveIndicators();
    }

    function renderLegend() {
      legend.innerHTML = "";
      /* tv.com draws nothing when a chart has no studies — the Indicators
         button in the toolbar is the affordance. An old hint line used to
         render here and clip, ghost-like, under the OHLC strip. */
      if (!st.indicators.length) return;
      st.indicators.forEach(function (inst) {
        var study = STUDY_MAP[inst.id];
        if (!study) return;
        var color = inst.params.color || inst.params.color2 || "#3b82f6";
        legend.appendChild(el("div", {
          class: "cv-chip" + (inst.hidden ? " off" : ""),
          /* The series colour travels with the chip so the readout can take
             it, the way tv.com draws a study's value in its own line colour. */
          style: "--series:" + color,
          title: study.name + (inst.hidden ? " — hidden on this interval by Visibility" : " — click to edit"),
          onclick: function () { openSettings(inst.uid); }
        }, [
          el("span", { class: "dot", style: "background:" + color }),
          el("span", { class: "lab", text: studyLabel(inst) }),
          (function () {
            var v = statusValues(inst);
            return v ? el("span", { class: "vals", text: v }) : null;
          })(),
          el("span", {
            class: "act", html: ICON.gear, title: "Settings",
            onclick: function (e) { e.stopPropagation(); openSettings(inst.uid); }
          }),
          el("span", {
            class: "act del", html: ICON.x, title: "Remove",
            onclick: function (e) { e.stopPropagation(); removeIndicator(inst.uid); }
          })
        ]));
      });
    }

    /* ------------------------------------------------------- drawings */
    /* Largest index whose bar opens at or before `t` — 0 before the first bar,
       n-1 past the last. This is what keeps a drawing on *its candle* when the
       chart is showing a timeframe the anchor time does not occur on. */
    function barIndexAt(t) {
      if (!data || !data.n || !isNum(t)) return -1;
      var lo = 0, hi = data.n - 1, ans = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (data.time[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans < 0 ? 0 : ans;
    }

    function pxOf(time, price) {
      var x = xOf(time);
      var y = candleSeries.priceToCoordinate(price);
      return (x == null || y == null) ? null : { x: x, y: y };
    }

    function xOf(time) {
      if (!chart) return null;
      var ts = chart.timeScale();
      var x = ts.timeToCoordinate(time);
      if (x != null) return x;
      /* Beyond the bars we hold? TradingView draws nothing there either —
         scroll back far enough and the drawing reappears on its candle. */
      if (!data || !data.n) return null;
      if (time < data.time[0] || time > data.time[data.n - 1]) return null;
      /* Inside the window but not on this timeframe's grid (it was placed on a
         finer one) — land on the candle that contains it, exactly the way
         TradingView keeps a drawing glued to its bar across every timeframe. */
      var i = barIndexAt(time);
      if (i < 0) return null;
      return ts.timeToCoordinate(data.time[i]);
    }
    function yOf(price) { return candleSeries.priceToCoordinate(price); }

    function snapPoint(pt) {
      if (!st.magnet || !data || !data.n) return { time: pt.time, price: pt.price };
      var idx = data.time.indexOf(pt.time);
      if (idx < 0) return { time: pt.time, price: pt.price };
      var y = yOf(pt.price);
      if (y == null) return { time: pt.time, price: pt.price };
      var best = pt.price, bestDy = 1e9;
      [data.open[idx], data.high[idx], data.low[idx], data.close[idx]].forEach(function (c) {
        var yc = yOf(c);
        if (yc == null) return;
        var dy = Math.abs(yc - y);
        if (dy < bestDy) { bestDy = dy; best = c; }
      });
      return { time: pt.time, price: bestDy <= 14 ? best : pt.price };
    }

    function pointFromEvent(e) {
      var rect = chartHost.getBoundingClientRect();
      var x = e.clientX - rect.left, y = e.clientY - rect.top;
      var ts = chart.timeScale();
      var time = ts.coordinateToTime ? ts.coordinateToTime(x) : null;
      /* The empty margin right of the last bar resolves to null — snap to the
         nearest real bar so drawing works anywhere over the canvas. */
      if (time == null && data && data.n && ts.coordinateToLogical) {
        var lg = ts.coordinateToLogical(x);
        if (isNum(lg)) time = data.time[clamp(Math.round(lg), 0, data.n - 1)];
      }
      /* Anchor every point to a real candle. Whatever sub-bar instant the
         coordinate resolved to becomes that candle's own open time, so a
         vertical line placed here lands on the same candle on 1d, 1h or 5m. */
      if (data && data.n && isNum(time)) {
        var bi = barIndexAt(time);
        if (bi >= 0) time = data.time[bi];
      }
      var price = candleSeries.coordinateToPrice(y);
      if (time == null || !isNum(price)) return null;
      var snapped = snapPoint({ time: time, price: price });
      return { time: snapped.time, price: snapped.price, x: x, y: y };
    }

    function geom(d) {
      var pts = d.points || [];
      var xs = [], ys = [];
      for (var i = 0; i < pts.length; i++) {
        var x = pts.length === 1 && d.tool === "hline" ? 0 : xOf(pts[i].time);
        var y = pts.length === 1 && d.tool === "vline" ? 0 : yOf(pts[i].price);
        xs.push(x); ys.push(y);
      }
      return { xs: xs, ys: ys, pts: pts };
    }

    function visible(d) {
      var g = geom(d);
      if (d.tool === "hline") return g.ys[0] != null;
      if (d.tool === "vline") return g.xs[0] != null;
      return g.xs.some(function (v) { return v != null; }) && g.ys.some(function (v) { return v != null; });
    }

    function distToSeg(px1, py1, x2, y2, x, y) {
      var dx = x2 - px1, dy = y2 - py1;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? ((x - px1) * dx + (y - py1) * dy) / len2 : 0;
      t = clamp(t, 0, 1);
      var qx = px1 + t * dx, qy = py1 + t * dy;
      return Math.hypot(x - qx, y - qy);
    }

    function hitTest(x, y) {
      for (var i = st.drawings.length - 1; i >= 0; i--) {
        var d = st.drawings[i];
        if (st.locked) continue;
        var r = hitOne(d, x, y);
        if (r) return { drawing: d, anchor: r };
      }
      return null;
    }

    function hitOne(d, x, y) {
      var g = geom(d), xs = g.xs, ys = g.ys, i, tol = 7;
      var anchors = [];
      for (i = 0; i < xs.length; i++) if (xs[i] != null && ys[i] != null) anchors.push(i);
      for (i = 0; i < anchors.length; i++) {
        if (Math.abs(xs[anchors[i]] - x) <= tol && Math.abs(ys[anchors[i]] - y) <= tol) return anchors[i];
      }
      var w = chartHost.clientWidth, h = chartHost.clientHeight;
      switch (d.tool) {
        case "hline": return ys[0] != null && Math.abs(ys[0] - y) <= tol ? -1 : null;
        case "vline": return xs[0] != null && Math.abs(xs[0] - x) <= tol ? -1 : null;
        case "hray": return ys[0] != null && Math.abs(ys[0] - y) <= tol && x >= xs[0] - tol ? -1 : null;
        case "brush":
        case "highlighter":
          for (i = 1; i < xs.length; i++) {
            if (xs[i] == null || xs[i - 1] == null || ys[i] == null || ys[i - 1] == null) continue;
            if (distToSeg(xs[i - 1], ys[i - 1], xs[i], ys[i], x, y) <= tol) return -1;
          }
          return null;
        case "xabcd":
        case "headshoulders":
          for (i = 1; i < xs.length; i++) {
            if (xs[i] == null || xs[i - 1] == null || ys[i] == null || ys[i - 1] == null) continue;
            if (distToSeg(xs[i - 1], ys[i - 1], xs[i], ys[i], x, y) <= tol) return -1;
          }
          return null;
        case "rect":
        case "ellipse":
        case "fib":
        case "fibext":
        case "longpos":
        case "shortpos": {
          if (xs.length < 2 || xs[0] == null || xs[1] == null) return null;
          var x0 = Math.min(xs[0], xs[1]), x1 = Math.max(xs[0], xs[1]);
          var y0 = Math.min(ys[0], ys[1]), y1 = Math.max(ys[0], ys[1]);
          var pad = (d.tool === "fib" || d.tool === "fibext") ? 16 : 8;
          if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) return null;
          if (d.tool === "fib") {
            var lv = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            for (i = 0; i < lv.length; i++) {
              if (Math.abs((ys[0] + (ys[1] - ys[0]) * lv[i]) - y) <= 7) return -1;
            }
            return null;
          }
          return -1;
        }
        case "pricerange": {
          if (ys[0] == null || ys[1] == null) return null;
          return Math.min(Math.abs(ys[0] - y), Math.abs(ys[1] - y)) <= tol ? -1 : null;
        }
        case "daterange": {
          if (xs[0] == null || xs[1] == null) return null;
          return Math.min(Math.abs(xs[0] - x), Math.abs(xs[1] - x)) <= tol ? -1 : null;
        }
        case "channel": {
          if (xs.length < 2 || xs[0] == null || xs[1] == null) return null;
          if (distToSeg(xs[0], ys[0], xs[1], ys[1], x, y) <= tol) return -1;
          if (xs.length > 2 && xs[2] != null) {
            var bx = xs[1] + (xs[2] - xs[0]), by = ys[1] + (ys[2] - ys[0]);
            if (distToSeg(xs[2], ys[2], bx, by, x, y) <= tol) return -1;
          }
          return null;
        }
        case "extline": {
          if (xs[0] == null || xs[1] == null) return null;
          var e = extendSeg(xs[0], ys[0], xs[1], ys[1], w, h);
          if (distToSeg(e[0], e[1], e[2], e[3], x, y) <= tol) return -1;
          return null;
        }
        case "arrow":
        case "ray":
        case "measure":
        case "trend": {
          if (xs.length < 2 || xs[0] == null || xs[1] == null) return null;
          if (distToSeg(xs[0], ys[0], xs[1], ys[1], x, y) <= tol) return -1;
          return null;
        }
        case "marker": {
          if (xs[0] == null || ys[0] == null) return null;
          return Math.abs(ys[0] - y) <= 14 && Math.abs(xs[0] - x) <= 12 ? -1 : null;
        }
        case "note":
        case "pricelabel":
        case "sticker":
        case "text": {
          if (xs[0] == null || ys[0] == null) return null;
          var tw = Math.max(40, (d.text || "").length * 7);
          return x >= xs[0] - 4 && x <= xs[0] + tw + 4 && y >= ys[0] - 16 && y <= ys[0] + 6 ? -1 : null;
        }
      }
      /* Declarative tools (SHAPE registry) fall back to a polyline hit. */
      if (SHAPE[d.tool]) {
        if (SHAPE[d.tool].hit) {
          return SHAPE[d.tool].hit({ xs: xs, ys: ys, pts: d.points }, x, y, tol,
            { w: w, h: h, distToSeg: distToSeg, extendSeg: extendSeg });
        }
        for (i = 1; i < xs.length; i++) {
          if (xs[i] == null || xs[i - 1] == null || ys[i] == null || ys[i - 1] == null) continue;
          if (distToSeg(xs[i - 1], ys[i - 1], xs[i], ys[i], x, y) <= tol) return -1;
        }
        return null;
      }
      return null;
    }

    /* Liang–Barsky: stretch the segment until it leaves the canvas, so an
       "extended line" runs edge to edge in both directions. */
    function extendSeg(x1, y1, x2, y2, w, h) {
      var dx = x2 - x1, dy = y2 - y1;
      if (!dx && !dy) return [x1, y1, x1, y1];
      var t0 = -1e9, t1 = 1e9;
      var pairs = [[-dx, x1], [dx, w - x1], [-dy, y1], [dy, h - y1]];
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i][0], q = pairs[i][1];
        if (p === 0) { if (q < 0) return [x1, y1, x1, y1]; continue; }
        var r = q / p;
        if (p < 0) { if (r > t1) return [x1, y1, x1, y1]; if (r > t0) t0 = r; }
        else { if (r < t0) return [x1, y1, x1, y1]; if (r < t1) t1 = r; }
      }
      if (t0 > t1) return [x1, y1, x1, y1];
      return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
    }

    function shapeText(d) {
      if (d.tool === "text") return d.text || "Text";
      return null;
    }

    function durTxt(sec) {
      if (sec >= 86400 * 365) return (sec / (86400 * 365)).toFixed(1) + "y";
      if (sec >= 86400 * 30) return Math.round(sec / (86400 * 30)) + "mo";
      if (sec >= 86400) return Math.round(sec / 86400) + "d";
      if (sec >= 3600) return Math.round(sec / 3600) + "h";
      if (sec >= 60) return Math.round(sec / 60) + "m";
      return Math.round(sec) + "s";
    }

    function drawShape(ctx, d, opts) {
      opts = opts || {};
      var g = geom(d), xs = g.xs, ys = g.ys, w = chartHost.clientWidth, h = chartHost.clientHeight;
      var col = d.color || "#3b82f6";
      ctx.save();
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = d.width || 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (opts.dash) ctx.setLineDash([5, 4]);

      function arrowHead(x2, y2, x1, y1) {
        var a = Math.atan2(y2 - y1, x2 - x1), s = 9;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - s * Math.cos(a - 0.42), y2 - s * Math.sin(a - 0.42));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - s * Math.cos(a + 0.42), y2 - s * Math.sin(a + 0.42));
        ctx.stroke();
      }

      /* Small dark label box — the shape TradingView puts on ranges,
         positions and patterns. `lines` is [[text, color], …]. */
      function labelBox(lines, x, y, o) {
        o = o || {};
        ctx.save();
        ctx.font = o.font || '600 11px ui-monospace, Menlo, Consolas, monospace';
        var lw = 14, i;
        for (i = 0; i < lines.length; i++) lw = Math.max(lw, ctx.measureText(lines[i][0]).width + 14);
        var lh = lines.length * 14 + 8;
        var lx = clamp(x, 2, Math.max(2, w - lw - 2));
        var ly = clamp(y, 2, Math.max(2, h - lh - 2));
        ctx.fillStyle = o.bg || "#131722";
        ctx.globalAlpha = o.alpha == null ? 0.95 : o.alpha;
        ctx.fillRect(lx, ly, lw, lh);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = o.border || col;
        ctx.lineWidth = 1;
        ctx.strokeRect(lx + 0.5, ly + 0.5, lw - 1, lh - 1);
        for (i = 0; i < lines.length; i++) {
          ctx.fillStyle = lines[i][1] || "#dbdbdb";
          ctx.fillText(lines[i][0], lx + 7, ly + 15 + i * 14);
        }
        ctx.restore();
        return { x: lx, y: ly, w: lw, h: lh };
      }

      /* Declarative tools from the SHAPE registry render here; everything
         else falls through to the classic switch below. */
      var sp = SHAPE[d.tool];
      if (sp && sp.draw) {
        sp.draw(ctx, {
          d: d, xs: xs, ys: ys, pts: g.pts, w: w, h: h, col: col,
          arrowHead: arrowHead, labelBox: labelBox, extendSeg: extendSeg,
          durTxt: durTxt, data: data, lw: d.width || 2,
          xOf: xOf, yOf: yOf, barIndexAt: barIndexAt,
          fmtPrice: fmtPrice, clamp: clamp
        });
        ctx.restore();
        return;
      }

      switch (d.tool) {
        case "hline": {
          if (ys[0] == null) break;
          ctx.beginPath(); ctx.moveTo(0, ys[0]); ctx.lineTo(w, ys[0]); ctx.stroke();
          ctx.fillStyle = col;
          ctx.fillRect(0, ys[0] - 8, 4, 16);
          break;
        }
        case "vline": {
          if (xs[0] == null) break;
          ctx.beginPath(); ctx.moveTo(xs[0], 0); ctx.lineTo(xs[0], h); ctx.stroke();
          break;
        }
        case "hray": {
          if (xs[0] == null || ys[0] == null) break;
          ctx.beginPath(); ctx.moveTo(xs[0], ys[0]); ctx.lineTo(w, ys[0]); ctx.stroke();
          arrowHead(w, ys[0], w - 12, ys[0]);
          break;
        }
        case "trend":
        case "arrow":
        case "ray": {
          if (xs[0] == null || xs[1] == null) break;
          var x1 = xs[0], y1 = ys[0], x2 = xs[1], y2 = ys[1];
          if (d.tool === "ray" && x2 !== x1) {
            var slope = (y2 - y1) / (x2 - x1);
            x2 = w; y2 = y1 + slope * (w - x1);
          }
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          if (d.tool === "arrow") arrowHead(xs[1], ys[1], x1, y1);
          [ [x1, y1], [xs[1], ys[1]] ].forEach(function (p) {
            ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill();
          });
          break;
        }
        case "extline": {
          if (xs[0] == null || xs[1] == null) break;
          var ex = extendSeg(xs[0], ys[0], xs[1], ys[1], w, h);
          ctx.beginPath(); ctx.moveTo(ex[0], ex[1]); ctx.lineTo(ex[2], ex[3]); ctx.stroke();
          [[xs[0], ys[0]], [xs[1], ys[1]]].forEach(function (p) {
            ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill();
          });
          break;
        }
        case "highlighter": {
          if (xs.length < 2) break;
          ctx.save();
          ctx.globalAlpha = 0.36;
          ctx.lineWidth = Math.max(7, (d.width || 2) * 4);
          ctx.lineJoin = "round"; ctx.lineCap = "round";
          ctx.beginPath();
          var hi0 = false, j2;
          for (j2 = 0; j2 < xs.length; j2++) {
            if (xs[j2] == null || ys[j2] == null) continue;
            if (!hi0) { ctx.moveTo(xs[j2], ys[j2]); hi0 = true; }
            else ctx.lineTo(xs[j2], ys[j2]);
          }
          ctx.stroke();
          ctx.restore();
          break;
        }
        case "marker": {
          if (xs[0] == null) break;
          ctx.beginPath();
          ctx.moveTo(xs[0], ys[0] - 16);
          ctx.lineTo(xs[0] + 10, ys[0] - 2);
          ctx.lineTo(xs[0] - 10, ys[0] - 2);
          ctx.closePath();
          ctx.fill();
          ctx.save();
          ctx.globalAlpha = 0.55;
          ctx.fillRect(xs[0] - 10, ys[0], 20, 3);
          ctx.restore();
          break;
        }
        case "ellipse": {
          if (xs[0] == null || xs[1] == null) break;
          ctx.save();
          ctx.beginPath();
          ctx.ellipse((xs[0] + xs[1]) / 2, (ys[0] + ys[1]) / 2,
            Math.max(1, Math.abs(xs[1] - xs[0]) / 2), Math.max(1, Math.abs(ys[1] - ys[0]) / 2),
            0, 0, Math.PI * 2);
          ctx.globalAlpha = 0.13; ctx.fill();
          ctx.globalAlpha = 1; ctx.stroke();
          ctx.restore();
          break;
        }
        case "pricerange": {
          if (ys[0] == null || ys[1] == null) break;
          var py0 = Math.min(ys[0], ys[1]), py1 = Math.max(ys[0], ys[1]);
          ctx.save();
          ctx.globalAlpha = 0.10; ctx.fillRect(0, py0, w, py1 - py0);
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.moveTo(0, py0); ctx.lineTo(w, py0);
          ctx.moveTo(0, py1); ctx.lineTo(w, py1);
          ctx.stroke();
          if (d.points[0] && d.points[1]) {
            var prA = d.points[0].price, prB = d.points[1].price;
            var prD = prB - prA, prP = prA ? (prD / prA) * 100 : 0;
            var prS = prD >= 0 ? "+" : "−";
            labelBox([
              [prS + fmtPrice(Math.abs(prD)), prD >= 0 ? "#26a69a" : "#f23645"],
              [prS + Math.abs(prP).toFixed(2) + "%", "#b8b8b8"]
            ], w / 2 - 34, (py0 + py1) / 2 - 18);
          }
          ctx.restore();
          break;
        }
        case "daterange": {
          if (xs[0] == null || xs[1] == null) break;
          var dx0 = Math.min(xs[0], xs[1]), dx1 = Math.max(xs[0], xs[1]);
          ctx.save();
          ctx.globalAlpha = 0.10; ctx.fillRect(dx0, 0, dx1 - dx0, h);
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.moveTo(dx0, 0); ctx.lineTo(dx0, h);
          ctx.moveTo(dx1, 0); ctx.lineTo(dx1, h);
          ctx.stroke();
          if (d.points[0] && d.points[1]) {
            var dA = d.points[0], dB = d.points[1];
            var iA = data ? data.time.indexOf(dA.time) : -1;
            var iB = data ? data.time.indexOf(dB.time) : -1;
            var nb2 = (iA >= 0 && iB >= 0) ? Math.abs(iB - iA) : 0;
            labelBox([
              [nb2 + " bar" + (nb2 === 1 ? "" : "s"), "#dbdbdb"],
              [durTxt(Math.abs((dB.time - dA.time) || 0)), "#b8b8b8"]
            ], dx0 + 6, h / 2 - 18);
          }
          ctx.restore();
          break;
        }
        case "longpos":
        case "shortpos": {
          if (xs[0] == null || xs[1] == null || !d.points[0] || !d.points[1]) break;
          var lx0 = Math.min(xs[0], xs[1]), lx1 = Math.max(xs[0], xs[1]);
          var eY = ys[0], tY = ys[1], sY = 2 * ys[0] - ys[1];
          ctx.save();
          ctx.lineWidth = 1;
          ctx.fillStyle = "#26a69a"; ctx.globalAlpha = 0.2;
          ctx.fillRect(lx0, Math.min(eY, tY), lx1 - lx0, Math.abs(tY - eY));
          ctx.fillStyle = "#f23645";
          ctx.fillRect(lx0, Math.min(eY, sY), lx1 - lx0, Math.abs(sY - eY));
          ctx.globalAlpha = 1;
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = "#26a69a";
          ctx.strokeRect(lx0 + 0.5, Math.min(eY, tY) + 0.5, lx1 - lx0 - 1, Math.abs(tY - eY));
          ctx.strokeStyle = "#f23645";
          ctx.strokeRect(lx0 + 0.5, Math.min(eY, sY) + 0.5, lx1 - lx0 - 1, Math.abs(sY - eY));
          ctx.setLineDash([]);
          ctx.strokeStyle = "#dbdbdb";
          ctx.beginPath(); ctx.moveTo(lx0, eY); ctx.lineTo(lx1, eY); ctx.stroke();
          var entP = d.points[0].price, tgtP = d.points[1].price;
          var stpP = 2 * entP - tgtP;
          var tPct = entP ? ((tgtP - entP) / entP) * 100 : 0;
          var sPct = entP ? ((stpP - entP) / entP) * 100 : 0;
          ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
          ctx.textAlign = "right";
          ctx.fillStyle = "#26a69a";
          ctx.fillText(fmtPrice(tgtP) + "  " + (tPct >= 0 ? "+" : "−") + Math.abs(tPct).toFixed(2) + "%", lx1 - 5, Math.min(eY, tY) + 14);
          ctx.fillStyle = "#f23645";
          ctx.fillText(fmtPrice(stpP) + "  " + (sPct >= 0 ? "+" : "−") + Math.abs(sPct).toFixed(2) + "%", lx1 - 5, Math.max(eY, sY) - 6);
          ctx.fillStyle = "#dbdbdb";
          ctx.fillText(fmtPrice(entP), lx1 - 5, eY - 5);
          ctx.textAlign = "left";
          ctx.restore();
          break;
        }
        case "xabcd": {
          if (xs.length < 5) break;
          var okX = true, qx;
          for (qx = 0; qx < 5; qx++) if (xs[qx] == null || ys[qx] == null) okX = false;
          if (!okX) break;
          ctx.beginPath();
          ctx.moveTo(xs[0], ys[0]);
          for (qx = 1; qx < 5; qx++) ctx.lineTo(xs[qx], ys[qx]);
          ctx.stroke();
          var lxA = Math.abs(ys[1] - ys[0]) || 1;
          var lAB = Math.abs(ys[2] - ys[1]), lBC = Math.abs(ys[3] - ys[2]), lCD = Math.abs(ys[4] - ys[3]);
          ctx.font = '10.5px ui-monospace, Menlo, Consolas, monospace';
          [[1, 2, lAB / lxA], [2, 3, lBC / (lAB || 1)], [3, 4, lCD / (lBC || 1)]].forEach(function (sg) {
            ctx.fillStyle = "#b8b8b8";
            ctx.fillText(sg[2].toFixed(3), (xs[sg[0]] + xs[sg[1]]) / 2 + 6, (ys[sg[0]] + ys[sg[1]]) / 2 + 4);
          });
          ctx.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
          ["X", "A", "B", "C", "D"].forEach(function (L, i) {
            ctx.beginPath(); ctx.arc(xs[i], ys[i], 3, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#b8b8b8";
            ctx.fillText(L, xs[i] + 5, ys[i] - 5);
            ctx.fillStyle = col;
          });
          break;
        }
        case "headshoulders": {
          if (xs.length < 5) break;
          var okH = true, qh;
          for (qh = 0; qh < 5; qh++) if (xs[qh] == null || ys[qh] == null) okH = false;
          if (!okH) break;
          ctx.beginPath();
          ctx.moveTo(xs[0], ys[0]);
          for (qh = 1; qh < 5; qh++) ctx.lineTo(xs[qh], ys[qh]);
          ctx.stroke();
          ctx.save();
          ctx.setLineDash([5, 4]);
          ctx.globalAlpha = 0.85;
          ctx.beginPath(); ctx.moveTo(xs[1], ys[1]); ctx.lineTo(xs[3], ys[3]); ctx.stroke();
          ctx.restore();
          ctx.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
          [[0, "LSh"], [2, "H"], [4, "RSh"]].forEach(function (p) {
            ctx.beginPath(); ctx.arc(xs[p[0]], ys[p[0]], 3, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#b8b8b8";
            ctx.fillText(p[1], xs[p[0]] + 5, ys[p[0]] - 5);
            ctx.fillStyle = col;
          });
          ctx.font = '10.5px ui-monospace, Menlo, Consolas, monospace';
          ctx.fillStyle = "#b8b8b8";
          ctx.fillText("Neckline", (xs[1] + xs[3]) / 2 + 6, (ys[1] + ys[3]) / 2 + 4);
          break;
        }
        case "fibext": {
          if (xs[0] == null || xs[1] == null || xs[2] == null || !d.points[2]) break;
          var base = d.points[1].price - d.points[0].price;
          var anch = d.points[2].price;
          var fx = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618];
          ctx.font = '10.5px ui-monospace, Menlo, Consolas, monospace';
          fx.forEach(function (lv, i) {
            var yy = yOf(anch + base * lv);
            if (yy == null) return;
            ctx.globalAlpha = i % 2 === 0 ? 0.95 : 0.6;
            ctx.beginPath(); ctx.moveTo(xs[2], yy); ctx.lineTo(w, yy); ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = col;
            ctx.fillText(String(lv), xs[2] + 4, yy - 3);
          });
          break;
        }
        case "note": {
          if (xs[0] == null) break;
          var nTxt = d.text || "Note";
          ctx.save();
          ctx.beginPath(); ctx.arc(xs[0], ys[0] - 7, 7, 0, Math.PI * 2);
          ctx.fillStyle = col; ctx.fill();
          ctx.strokeStyle = "#131722"; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.font = '600 12.5px system-ui, -apple-system, "Segoe UI", sans-serif';
          var nw2 = ctx.measureText(nTxt).width;
          ctx.fillStyle = "#131722"; ctx.globalAlpha = 0.95;
          ctx.fillRect(xs[0] + 12, ys[0] - 16, nw2 + 12, 19);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = col; ctx.lineWidth = 1;
          ctx.strokeRect(xs[0] + 12.5, ys[0] - 15.5, nw2 + 11, 18);
          ctx.fillStyle = col;
          ctx.fillText(nTxt, xs[0] + 18, ys[0] - 2);
          ctx.restore();
          break;
        }
        case "pricelabel": {
          if (ys[0] == null || !d.points[0]) break;
          var lbTxt = d.text && d.text.length ? d.text : fmtPrice(d.points[0].price);
          ctx.save();
          ctx.font = '600 11.5px ui-monospace, Menlo, Consolas, monospace';
          var lbW = ctx.measureText(lbTxt).width + 14;
          ctx.fillStyle = col;
          ctx.fillRect(xs[0], ys[0] - 9, lbW, 18);
          ctx.beginPath();
          ctx.moveTo(xs[0] + lbW, ys[0] - 6);
          ctx.lineTo(xs[0] + lbW + 8, ys[0]);
          ctx.lineTo(xs[0] + lbW, ys[0] + 6);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = "#0f0f0f";
          ctx.fillText(lbTxt, xs[0] + 7, ys[0] + 4);
          ctx.restore();
          break;
        }
        case "sticker": {
          if (xs[0] == null) break;
          ctx.save();
          ctx.font = '22px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui, sans-serif';
          ctx.fillText(d.text || "🙂", xs[0], ys[0]);
          ctx.restore();
          break;
        }
        case "measure": {
          if (xs[0] == null || xs[1] == null) break;
          var ax = xs[0], ay = ys[0], bx2 = xs[1], by2 = ys[1];
          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx2, by2); ctx.stroke();
          ctx.restore();
          [[ax, ay], [bx2, by2]].forEach(function (p) {
            ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill();
          });
          /* TradingView's ruler label: signed move, signed percent, bar count
             and elapsed time, in a box that follows the line's midpoint. */
          var p0 = d.points[0], p1 = d.points[1];
          if (p0 && p1) {
            var dPrice = p1.price - p0.price;
            var dPct = p0.price ? (dPrice / p0.price) * 100 : 0;
            var i0 = data && data.time ? data.time.indexOf(p0.time) : -1;
            var i1 = data && data.time ? data.time.indexOf(p1.time) : -1;
            var nBars = (i0 >= 0 && i1 >= 0) ? Math.abs(i1 - i0) : 0;
            var dSec = Math.abs((p1.time - p0.time) || 0);
            var dur = dSec >= 86400 ? Math.round(dSec / 86400) + "d"
              : dSec >= 3600 ? Math.round(dSec / 3600) + "h"
                : dSec >= 60 ? Math.round(dSec / 60) + "m"
                  : Math.round(dSec) + "s";
            var sign = dPrice >= 0 ? "+" : "−";
            var mag = Math.abs(dPrice);
            var magTxt = mag >= 1000 ? mag.toLocaleString(undefined, { maximumFractionDigits: 2 })
              : mag.toFixed(mag < 1 ? 4 : 2);
            var l1 = sign + magTxt + " (" + sign + Math.abs(dPct).toFixed(2) + "%)";
            var l2 = nBars + " bar" + (nBars === 1 ? "" : "s") + " · " + dur;
            ctx.save();
            ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
            var lw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 14;
            var lx = Math.min(w - lw - 4, (ax + bx2) / 2 - lw / 2);
            var ly = Math.min(h - 42, Math.max(2, (ay + by2) / 2 - 20));
            ctx.fillStyle = "#131722";
            ctx.globalAlpha = 0.94;
            ctx.fillRect(lx, ly, lw, 36);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = col; ctx.lineWidth = 1;
            ctx.strokeRect(lx + 0.5, ly + 0.5, lw - 1, 35);
            ctx.fillStyle = dPrice >= 0 ? "#26a69a" : "#f23645";
            ctx.fillText(l1, lx + 7, ly + 15);
            ctx.fillStyle = "#b8b8b8";
            ctx.fillText(l2, lx + 7, ly + 29);
            ctx.restore();
          }
          break;
        }
        case "rect": {
          if (xs[0] == null || xs[1] == null) break;
          var rx = Math.min(xs[0], xs[1]), ry = Math.min(ys[0], ys[1]);
          var rw = Math.abs(xs[1] - xs[0]), rh = Math.abs(ys[1] - ys[0]);
          ctx.save();
          ctx.globalAlpha = 0.13; ctx.fillStyle = col;
          ctx.fillRect(rx, ry, rw, rh);
          ctx.restore();
          ctx.strokeRect(rx, ry, rw, rh);
          break;
        }
        case "channel": {
          if (xs[0] == null || xs[1] == null) break;
          ctx.beginPath(); ctx.moveTo(xs[0], ys[0]); ctx.lineTo(xs[1], ys[1]); ctx.stroke();
          var offX = xs.length > 2 && xs[2] != null ? xs[2] - xs[0] : 0;
          var offY = ys.length > 2 && ys[2] != null ? ys[2] - ys[0] : 0;
          ctx.save(); ctx.globalAlpha = 0.75;
          ctx.beginPath(); ctx.moveTo(xs[0] + offX, ys[0] + offY); ctx.lineTo(xs[1] + offX, ys[1] + offY); ctx.stroke();
          ctx.restore();
          ctx.globalAlpha = 0.08;
          ctx.beginPath();
          ctx.moveTo(xs[0], ys[0]); ctx.lineTo(xs[1], ys[1]);
          ctx.lineTo(xs[1] + offX, ys[1] + offY); ctx.lineTo(xs[0] + offX, ys[0] + offY);
          ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
          break;
        }
        case "fib": {
          if (xs[0] == null || xs[1] == null) break;
          var fx0 = Math.min(xs[0], xs[1]), fx1 = Math.max(xs[0], xs[1]);
          var hi = Math.max(ys[0], ys[1]), lo = Math.min(ys[0], ys[1]);
          var levels = [[0, "0"], [0.236, "0.236"], [0.382, "0.382"], [0.5, "0.5"], [0.618, "0.618"], [0.786, "0.786"], [1, "1"]];
          ctx.font = '10.5px ui-monospace, Menlo, Consolas, monospace';
          levels.forEach(function (lv, i) {
            var y = hi + (lo - hi) * lv[0];
            ctx.globalAlpha = i % 2 === 0 ? 0.95 : 0.6;
            ctx.beginPath(); ctx.moveTo(fx0, y); ctx.lineTo(fx1, y); ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillText(lv[1], fx1 + 5, y + 3);
            ctx.save();
            ctx.globalAlpha = 0.12;
            ctx.fillRect(fx0, Math.min(y, hi + (lo - hi) * (levels[i + 1] ? levels[i + 1][0] : 1)), fx1 - fx0, Math.abs((lo - hi) / 6));
            ctx.restore();
          });
          ctx.globalAlpha = 1;
          ctx.fillText("0 → 1", fx0 + 4, hi - 5);
          break;
        }
        case "text": {
          if (xs[0] == null) break;
          var txt = d.text || "Text";
          ctx.font = '600 12.5px system-ui, -apple-system, "Segoe UI", sans-serif';
          var tw = ctx.measureText(txt).width;
          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = "#0e141c";
          ctx.fillRect(xs[0] - 3, ys[0] - 14, tw + 8, 19);
          ctx.strokeStyle = col; ctx.lineWidth = 1;
          ctx.strokeRect(xs[0] - 3, ys[0] - 14, tw + 8, 19);
          ctx.restore();
          ctx.fillStyle = col;
          ctx.fillText(txt, xs[0] + 1, ys[0]);
          break;
        }
        case "brush": {
          if (xs.length < 2) break;
          ctx.beginPath();
          var started = false;
          for (var i = 0; i < xs.length; i++) {
            if (xs[i] == null || ys[i] == null) continue;
            if (!started) { ctx.moveTo(xs[i], ys[i]); started = true; }
            else ctx.lineTo(xs[i], ys[i]);
          }
          ctx.stroke();
          break;
        }
      }
      ctx.restore();

      if (opts.selected && !st.locked) {
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.fillStyle = "#0e141c";
        ctx.lineWidth = 1;
        var pts = [];
        if (d.tool === "hline") pts = [[0, ys[0]], [w - 4, ys[0]]];
        else if (d.tool === "vline") pts = [[xs[0], 0], [xs[0], h - 24]];
        else for (i = 0; i < xs.length; i++) if (xs[i] != null && ys[i] != null) pts.push([xs[i], ys[i]]);
        pts.forEach(function (p) {
          ctx.beginPath(); ctx.rect(p[0] - 4, p[1] - 4, 8, 8);
          ctx.fill(); ctx.stroke();
        });
        ctx.restore();
      }
    }

    function redrawOverlay() {
      if (!alive || !chart || !overlay.isConnected) return;
      var rect = chartHost.getBoundingClientRect();
      var w = Math.max(1, Math.round(rect.width));
      var h = Math.max(1, Math.round(rect.height));
      var dpr = window.devicePixelRatio || 1;
      var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (overlay.width !== bw || overlay.height !== bh) {
        overlay.width = bw; overlay.height = bh;
        overlay.style.width = w + "px"; overlay.style.height = h + "px";
      }
      var ctx = overlay.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var box = overlay.getBoundingClientRect();
      var dx = rect.left - box.left, dy = rect.top - box.top;
      if (dx || dy) ctx.translate(dx, dy);

      if (!st.hideDrawings) {
        st.drawings.forEach(function (d) {
          if (!visible(d)) return;
          drawShape(ctx, d, { selected: d.id === st.selected });
        });
      }
      var preview = st.pending && st.pending.points.length ? pendingPreview() : null;
      if (preview) drawShape(ctx, preview, { dash: true });
      if (st.zoomRect) {
        var zr = st.zoomRect;
        var zx = Math.min(zr.x0, zr.x1), zy = Math.min(zr.y0, zr.y1);
        var zw = Math.abs(zr.x1 - zr.x0), zh = Math.abs(zr.y1 - zr.y0);
        ctx.save();
        ctx.fillStyle = "rgba(59,130,246,0.14)";
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeRect(zx + 0.5, zy + 0.5, zw, zh);
        ctx.restore();
      }
      if (st.hover && st.tool === "cursor" && !st.selected) {
        var hit = hitTest(st.hover.x, st.hover.y);
        if (hit && hit.drawing) drawShape(ctx, hit.drawing, { selected: false, dash: false });
      }

      /* Bar replay. Armed parks the marker on the bar being picked — solid,
         so it reads as "waiting for you" against the dashed frontier of a
         replay already under way. Running parks it on the last bar played. */
      if (replay.on && replay.full && replay.full.n) {
        var pick = replay.armed
            ? clamp(replay.startIdx, 0, replay.full.n - 1)
            : clamp(replay.idx, 0, replay.full.n - 1);
        var rx = xOf(replay.full.time[pick]);
        if (rx != null && rx > -3 && rx < w + 3) {
          ctx.save();
          ctx.strokeStyle = "#2962ff";
          ctx.lineWidth = 1.5;
          ctx.setLineDash(replay.armed ? [] : [5, 4]);
          ctx.beginPath();
          ctx.moveTo(rx + 0.5, 0);
          ctx.lineTo(rx + 0.5, h);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#2962ff";
          ctx.beginPath();
          ctx.arc(rx + 0.5, 15, 3.5, 0, Math.PI * 2);
          ctx.fill();
          if (replay.armed) {
            ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
            ctx.textAlign = "left";
            ctx.fillText("start", rx + 7, 22);
          }
          ctx.restore();
        }
      }
    }

    function scheduleRedraw() {
      if (!alive) return;
      if (redrawRaf) return;
      redrawRaf = requestAnimationFrame(function () {
        redrawRaf = null;
        redrawOverlay();
      });
    }

    function minPoints(tool) {
      if (SHAPE[tool] && SHAPE[tool].n) return SHAPE[tool].n;
      if (tool === "brush" || tool === "highlighter") return 2;
      if (tool === "channel") return 3;
      if (tool === "fibext") return 3;
      if (tool === "xabcd" || tool === "headshoulders") return 5;
      if (ONE_POINT[tool]) return 1;
      return 2;
    }

    function toolLabel(id) {
      for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].id === id) return TOOLS[i].label;
      return id;
    }

    function newDrawing(tool, pt) {
      var txt = "";
      if (tool === "text") txt = "Text";
      else if (tool === "note") txt = "Note";
      else if (tool === "sticker") txt = "🙂";
      return { id: uid("dw"), tool: tool, color: st.color, width: 2, text: txt, points: [pt] };
    }

    function pendingPreview() {
      var d = st.pending;
      if (!d) return null;
      if (d.cursor) {
        return { id: d.id, tool: d.tool, color: d.color, width: d.width, text: d.text,
          points: d.points.concat([d.cursor]) };
      }
      return d;
    }

    function finishDrawing(what) {
      var d = what || st.pending;
      if (what === st.pending || !what) st.pending = null;
      if (!d) return;
      if (d.points.length < minPoints(d.tool)) { scheduleRedraw(); return; }
      d.cursor = null;
      st.drawings.push(d);
      saveDrawings();
      scheduleRedraw();
      toast("Drawing added", toolLabel(d.tool), "", 1600);
      if (TEXTY[d.tool]) editText(d);
      /* "Keep drawing" holds the tool instead of snapping back to the cursor. */
      if (st.sticky) setTool(d.tool);
      else setTool("cursor");
    }

    /* --------------------------------------------------- pointer input */
    var pDown = null;

    function overlayPointer() {
      return st.tool === "cursor" ? "none" : "auto";
    }

    function syncOverlay() {
      overlay.classList.toggle("draw", st.tool !== "cursor");
      overlay.classList.toggle("pick", st.tool !== "cursor" && st.tool !== "delete");
      overlay.style.pointerEvents = overlayPointer();
    }

    function setTool(id) {
      if (id !== "cursor" && id !== "delete" && id !== "zoomregion" && !toolById(id)) return;
      var pick = id;                       // what the rail lights up
      if (CURSOR_MODE[id]) { st.cursorMode = id; id = "cursor"; }
      else if (id === "cursor") st.cursorMode = "cursor";
      st.tool = id;
      st.pending = null;   // abandon any shape that was still in progress
      st.zoomRect = null;
      TOOL_GROUPS.forEach(function (g) {
        if (groupTools(g).indexOf(pick) >= 0) { groupPick[g.id] = pick; store("cx.cv.toolgrp." + g.id, pick); }
      });
      syncRail();
      if (id !== "cursor") { st.selected = null; }
      syncOverlay();
      scheduleRedraw();
    }

    /* The rail row that should read as selected right now. */
    function activeToolId() {
      return st.tool === "cursor" ? (st.cursorMode || "cursor") : st.tool;
    }

    function toggleMagnet() {
      st.magnet = !st.magnet;
      store("cx.cv.magnet", st.magnet);
      magnetBtn.classList.toggle("on", st.magnet);
      syncRail();
      toast(st.magnet ? "Magnet mode on" : "Magnet mode off", "Drawings snap to OHLC", "", 1800);
    }

    /* "Keep drawing" — TradingView's stay-in-tool mode: without it the rail
       falls back to the cursor once a drawing is placed. */
    function toggleSticky() {
      st.sticky = !st.sticky;
      store("cx.cv.sticky", st.sticky);
      syncRail();
      toast(st.sticky ? "Keep drawing on" : "Keep drawing off", "", "", 1600);
    }

    /* "Hide all drawings" — hides every drawing without deleting it. */
    function toggleHidden() {
      st.hideDrawings = !st.hideDrawings;
      store("cx.cv.hidedraw", st.hideDrawings);
      syncRail();
      scheduleRedraw();
      toast(st.hideDrawings ? "Drawings hidden" : "Drawings shown", "", "", 1600);
    }

    function toggleLock() {
      st.locked = !st.locked;
      store("cx.cv.lock", st.locked);
      lockBtn.innerHTML = st.locked ? ICON.lock : ICON.unlock;
      lockTool.innerHTML = st.locked ? ICON.lock : ICON.unlock;
      lockBtn.classList.toggle("on", st.locked);
      lockTool.classList.toggle("on", st.locked);
      if (st.locked) st.selected = null;
      toast(st.locked ? "Drawings locked" : "Drawings unlocked", "", "", 1800);
      scheduleRedraw();
    }

    function clearDrawings() {
      if (!st.drawings.length) { toast("Nothing to delete", "No drawings on this chart"); return; }
      var n = st.drawings.length;
      st.drawings = [];
      st.selected = null;
      saveDrawings();
      scheduleRedraw();
      toast("Drawings cleared", n + " removed", "ok", 2200);
    }

    function deleteDrawing(idv) {
      var i = st.drawings.findIndex(function (d) { return d.id === idv; });
      if (i < 0) return;
      st.drawings.splice(i, 1);
      if (st.selected === idv) st.selected = null;
      saveDrawings();
      scheduleRedraw();
    }

    /* Drawing gestures:
         · one-click tools (hline / hray / vline / text) finish on the press;
         · multi-point tools accept drag-to-place *or* click-click: a press
           over an unfinished shape anchors its next point and a drag then
           slides that anchor, a press on an empty canvas starts the shape;
         · brush accumulates points while the pointer is down. */
    /* Zoom in: fit the view to the rectangle the user just dragged out. */
    function applyZoomRect(r) {
      st.zoomRect = null;
      var ok = r && Math.abs(r.x1 - r.x0) >= 14 && Math.abs(r.y1 - r.y0) >= 14;
      if (ok) {
        var x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
        var y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
        try {
          var ts = chart.timeScale();
          var f = ts.coordinateToLogical(x0), t = ts.coordinateToLogical(x1);
          if (isNum(f) && isNum(t) && t - f > 2) ts.setVisibleLogicalRange({ from: f, to: t });
          var pb = candleSeries.coordinateToPrice(y1), pt2 = candleSeries.coordinateToPrice(y0);
          if (isNum(pb) && isNum(pt2) && pt2 > pb) candleSeries.priceScale().setVisibleRange({ from: pb, to: pt2 });
        } catch (e) { /* noop */ }
      }
      setTool("cursor");
      scheduleRedraw();
    }

    function onOverlayDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      var pt = pointFromEvent(e);
      if (!pt) return;
      e.preventDefault();

      if (st.tool === "delete") {
        var hitD = hitTest(pt.x, pt.y);
        if (hitD) { deleteDrawing(hitD.drawing.id); toast("Drawing deleted", "", "", 1400); }
        return;
      }
      /* Zoom in: drag out a rectangle, the chart re-fits to it on release. */
      if (st.tool === "zoomregion") {
        st.zoomRect = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
        pDown = { x: pt.x, y: pt.y, moved: false, fresh: true, zoom: true };
        try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
        scheduleRedraw();
        return;
      }
      if (st.tool === "cursor") return;

      var fresh = false;
      if (!st.pending) {
        st.pending = newDrawing(st.tool, { time: pt.time, price: pt.price });
        fresh = true;
        if (minPoints(st.tool) === 1) { finishDrawing(); pDown = null; return; }
      } else {
        st.pending.points.push({ time: pt.time, price: pt.price });
        st.pending.cursor = null;
      }
      pDown = { x: pt.x, y: pt.y, moved: false, fresh: fresh };
      try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      scheduleRedraw();
    }

    function onOverlayMove(e) {
      if (st.tool === "zoomregion") {
        if (!st.zoomRect || !pDown) return;
        var zp = pointFromEvent(e);
        if (zp) { st.zoomRect.x1 = zp.x; st.zoomRect.y1 = zp.y; scheduleRedraw(); }
        return;
      }
      var P = st.pending;
      if (P) {
        var pt = pointFromEvent(e);
        if (!pt) return;
        if (pDown && (Math.abs(pt.x - pDown.x) > 4 || Math.abs(pt.y - pDown.y) > 4)) pDown.moved = true;
        if (P.tool === "brush" || P.tool === "highlighter") {
          var last = P.points[P.points.length - 1];
          if (!last || last.time !== pt.time || last.price !== pt.price) {
            P.points.push({ time: pt.time, price: pt.price });
          }
        } else if (pDown && pDown.fresh) {
          P.cursor = { time: pt.time, price: pt.price };              // live preview of the next anchor
        } else if (pDown && pDown.moved) {
          P.points[P.points.length - 1] = { time: pt.time, price: pt.price };  // slide the anchor
        } else if (!pDown) {
          P.cursor = { time: pt.time, price: pt.price };              // hover preview while waiting
        }
        scheduleRedraw();
        return;
      }
      if (st.tool === "cursor") return;
      var h = hitTestAt(e);
      overlay.classList.toggle("grab", !!(h && h.drawing));
    }

    function hitTestAt(e) {
      var rect = chartHost.getBoundingClientRect();
      return hitTest(e.clientX - rect.left, e.clientY - rect.top);
    }

    function onOverlayUp() {
      var P = st.pending;
      var was = pDown;
      pDown = null;
      if (st.tool === "zoomregion") { applyZoomRect(st.zoomRect); return; }
      if (!P) return;
      if (P.tool === "brush" || P.tool === "highlighter") {
        if (P.points.length >= minPoints(P.tool)) finishDrawing();
        else { st.pending = null; scheduleRedraw(); }   // a bare click is not a stroke
        return;
      }
      if (was && was.fresh && was.moved && P.cursor) {
        P.points.push(P.cursor);                        // the drag placed this point
      }
      P.cursor = null;
      if (P.points.length >= minPoints(P.tool) && !VARLEN[P.tool]) finishDrawing();
      scheduleRedraw();
    }

    overlay.addEventListener("pointerdown", onOverlayDown);
    overlay.addEventListener("pointermove", onOverlayMove);
    overlay.addEventListener("pointerup", onOverlayUp);
    overlay.addEventListener("pointercancel", function () { st.pending = null; pDown = null; scheduleRedraw(); });
    overlay.addEventListener("dblclick", function () {
      var P = st.pending;
      if (!P) return;
      if (VARLEN[P.tool] && P.points.length >= minPoints(P.tool)) {
        /* The two clicks of a double-click land on one bar; keep only one. */
        while (P.points.length > 1 &&
          P.points[P.points.length - 1].time === P.points[P.points.length - 2].time) P.points.pop();
        finishDrawing();
      } else {
        st.pending = null;
        scheduleRedraw();
      }
    });
    overlay.addEventListener("wheel", function (e) {
      e.preventDefault();
      var rect = chartHost.getBoundingClientRect();
      var factor = Math.pow(1.0016, -e.deltaY);
      zoomBy(factor, e.clientX - rect.left);
    }, { passive: false });

    /* ------------------------- cursor-mode select / drag via chart events */
    function onWinMouseDown(e) {
      if (!alive) return;
      if (!chartHost.contains(e.target)) return;
      /* Armed replay: this click means one thing — "start here" — so it is
         taken before the cursor tool can read it as a drawing select. It rides
         the window-capture path the drawing tools themselves use, so it sees
         the click whichever chart element ends up owning it. */
      if (replay.on && replay.armed && replay.full) {
        var pr = chartHost.getBoundingClientRect();
        var at = replayPickAt(e.clientX - pr.left);
        if (at >= 0) { replayPause(); replayConfirm(at); return; }
      }
      if (st.tool !== "cursor" || st.locked) return;
      var rect = chartHost.getBoundingClientRect();
      var hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) {
        st.selected = hit.drawing.id;
        st.dragging = { id: hit.drawing.id, anchor: hit.anchor, start: { x: e.clientX, y: e.clientY },
          original: clone(hit.drawing.points), moved: false };
        try {
          chart.applyOptions({ handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false } });
        } catch (err) { /* noop */ }
        scheduleRedraw();
      } else if (st.selected) {
        st.selected = null;
        scheduleRedraw();
      }
    }

    function onWinMouseMove(e) {
      if (!alive) return;
      if (st.tool === "cursor") {
        if (st.dragging) {
          var d = st.drawings.find(function (x) { return x.id === st.dragging.id; });
          if (!d) { st.dragging = null; return; }
          var dx = e.clientX - st.dragging.start.x;
          var dy = e.clientY - st.dragging.start.y;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) st.dragging.moved = true;
          var ts = chart.timeScale();
          var rect = chartHost.getBoundingClientRect();
          st.dragging.original.forEach(function (orig, i) {
            if (i >= d.points.length) return;
            var cx = ts.timeToCoordinate(orig.time);
            var cy = candleSeries.priceToCoordinate(orig.price);
            if (cx == null || cy == null) return;
            var nx = cx + dx, ny = cy + dy;
            var nt = ts.coordinateToTime(nx);
            var np = candleSeries.coordinateToPrice(ny);
            if (nt != null && isNum(np)) d.points[i] = { time: nt, price: np };
          });
          scheduleRedraw();
          return;
        }
        var rect2 = chartHost.getBoundingClientRect();
        st.hover = { x: e.clientX - rect2.left, y: e.clientY - rect2.top };
        if (hitTest(st.hover.x, st.hover.y)) scheduleRedraw();
      }
    }

    function onWinMouseUp() {
      if (!alive) return;
      if (st.dragging) {
        if (st.dragging.moved) saveDrawings();
        st.dragging = null;
        try {
          chart.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
        } catch (e) { /* noop */ }
      }
    }

    window.addEventListener("mousedown", onWinMouseDown, true);
    window.addEventListener("mousemove", onWinMouseMove, false);
    window.addEventListener("mouseup", onWinMouseUp, false);

    /* ------------------------------------------------------- text notes */
    function editText(d) {
      var rect = chartHost.getBoundingClientRect();
      var g = geom(d);
      if (g.xs[0] == null) return;
      var dflt = d.text || (d.tool === "sticker" ? "🙂"
        : d.tool === "pricelabel" ? (d.points[0] ? fmtPrice(d.points[0].price) : "0")
          : d.tool === "note" ? "Note" : "Text");
      var input = el("input", {
        type: "text", value: dflt,
        style: "position:absolute;z-index:20;font-size:12.5px;padding:4px 7px;width:150px;left:" +
          Math.max(2, g.xs[0]) + "px;top:" + Math.max(2, g.ys[0] - 16) + "px"
      });
      mainWrap.appendChild(input);
      var done = function (save) {
        if (!input.parentNode) return;
        if (save && input.value.trim()) d.text = input.value.trim();
        input.remove();
        saveDrawings();
        scheduleRedraw();
      };
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); done(true); }
        if (e.key === "Escape") { e.preventDefault(); done(false); }
        e.stopPropagation();
      });
      input.addEventListener("blur", function () { done(true); });
      input.focus();
      input.select();
    }

    /* ------------------------------------------------------- navigation */
    function currentEntry() {
      return { symbol: st.symbol, interval: st.interval, limit: st.limit };
    }

    function goBack() {
      var entry = null;
      while (navStack.length) {
        var cand = navStack.pop();
        if (cand.symbol !== st.symbol || cand.interval !== st.interval || cand.limit !== st.limit) { entry = cand; break; }
      }
      if (!entry) { toast("Nothing to go back to", "No earlier symbol or timeframe in this session"); updateBack(); return; }
      pendingPrefer = entry.symbol === st.symbol ? "carry" : "switch";
      if (entry.symbol !== st.symbol) {
        layoutCarry = st.indicators.map(function (i) { return { uid: i.uid, id: i.id, params: clone(i.params) }; });
        if (opts.onNavigate) opts.onNavigate(entry);
        else { st.symbol = entry.symbol; st.interval = entry.interval; st.limit = entry.limit; boot(); }
        return;
      }
      st.interval = entry.interval;
      st.limit = entry.limit;
      notifyState();
      syncControls();
      boot();
      updateBack();
    }

    function updateBack() {
      backBtn.disabled = navStack.length === 0;
      backBtn.title = navStack.length
        ? "Back to " + navStack[navStack.length - 1].symbol + " · " + navStack[navStack.length - 1].interval
        : "Nothing to go back to yet";
    }

    function changeInterval(tf) {
      if (tf === st.interval) return;
      compareClear();
      pushNav(currentEntry());
      st.interval = tf;
      pendingPrefer = "carry";
      notifyState();
      syncControls();
      boot();
      updateBack();
    }

    function changeLimit(n) {
      if (n === st.limit) return;
      pushNav(currentEntry());
      st.limit = n;
      pendingPrefer = "carry";
      notifyState();
      syncControls();
      boot();
      updateBack();
    }

    function goToSymbol(sym) {
      sym = (sym || "").toUpperCase();
      if (!sym || sym === st.symbol) { closeSuggest(); return; }
      compareClear();
      pushNav(currentEntry());
      pendingPrefer = "switch";
      layoutCarry = st.indicators.map(function (i) { return { uid: i.uid, id: i.id, params: clone(i.params) }; });
      searchInput.value = sym;
      closeSuggest();
      if (opts.onNavigate) opts.onNavigate({ symbol: sym, interval: st.interval, limit: st.limit });
      else { st.symbol = sym; boot(); }   /* no router: switch in place */
      updateBack();
    }

    /* tv.com's legend title is one line: `Apple Inc · 1D · NASDAQ`, 16px/400,
       every part the same colour. The venue only arrives with the bars, so the
       title is re-synced after the load as well as on symbol/interval change. */
    function syncLegendTitle() {
      symEl.innerHTML = esc(st.symbol.replace(/USDT$/, "")) + ' <span class="q">/ USDT</span>';
      nameEl.textContent = " · " + tfLabel(st.interval) +
        (dataSource ? " · " + dataSource.toUpperCase() : "");
    }

    function syncControls() {
      $$(".tf button", tfWrap).forEach(function (b) { b.classList.toggle("on", b.dataset.tf === st.interval); });
      $$(".tf button", barsWrap).forEach(function (b) { b.classList.toggle("on", b.dataset.bars === String(st.limit)); });
      /* tv.com prints day/week/month uppercase (`1D`, `1W`, `1M`) and leaves
         intraday alone (`15m`, `4h`). A flat lowercase `1d` was a small but
         constant tell against the live site. */
      if (tfBtn) { var lab = tfBtn.querySelector(".cv-tf-lab"); if (lab) lab.textContent = tfLabel(st.interval); }
      syncRangeTabs();
      syncUndo();
      syncLegendTitle();
      searchInput.value = st.symbol;
      var ts = chart.timeScale();
      try {
        ts.applyOptions({ timeVisible: st.interval === "15m" || st.interval === "1h" || st.interval === "4h" });
      } catch (e) { /* noop */ }
      renderQuick();
    }

    /* ---------------------------------------------------------- zooming */
    function zoomBy(factor, anchorX) {
      if (!chart) return;
      var ts = chart.timeScale();
      var r = ts.getVisibleLogicalRange();
      if (!r) return;
      var span = Math.max(2, r.to - r.from);
      var maxSpan = Math.max(60, (data ? data.n : 500) * 6);
      var newSpan = clamp(span / factor, 8, maxSpan);
      var anchor = anchorX == null ? (r.from + r.to) / 2 : ts.coordinateToLogical(anchorX);
      if (!isNum(anchor)) anchor = (r.from + r.to) / 2;
      var ratio = (anchor - r.from) / span;
      ts.setVisibleLogicalRange({ from: anchor - newSpan * ratio, to: anchor + newSpan * (1 - ratio) });
    }

    function resetZoom() {
      if (!chart) return;
      /* LWC's fitContent() sometimes reports a phantom extent and leaves the
         plot with a few hundred empty bars on the left.  Computing the fit
         from the bars we actually hold is exact and cannot drift. */
      var off = 4;
      if (data && data.n) {
        try { off = chart.timeScale().options().rightOffset || 0; } catch (e) { /* noop */ }
        try {
          chart.timeScale().setVisibleLogicalRange({ from: 0, to: data.n - 1 + off });
        } catch (e) { /* noop */ }
      } else {
        try { chart.timeScale().fitContent(); } catch (e) { /* noop */ }
      }
      scheduleRedraw();
    }

    /* ----------------------------------------------------------- refresh
       The live TradingView rail has no reset button of its own (its "Auto"
       toggle only re-scales the axis), so ours is the explicit reset asked
       for: re-fit the plot — the chart zooms itself in or out until every
       loaded bar fits — and re-arm each price scale. */
    function refreshChart() {
      if (!chart) return;
      try { chart.timeScale().applyOptions({ rightOffset: 4 }); } catch (e) { /* noop */ }
      resetZoom();
      var list = [];
      if (candleSeries) list.push(candleSeries);
      (st.indicators || []).forEach(function (x) {
        (x.series || []).forEach(function (s) { if (s) list.push(s); });
      });
      list.forEach(function (s) {
        try { s.priceScale().applyOptions({ autoScale: true }); } catch (e) { /* odd pane */ }
      });
      scheduleRedraw();
      if (refreshBtn) {
        refreshBtn.classList.remove("cv-spin");
        void refreshBtn.offsetWidth;          /* restart the animation */
        refreshBtn.classList.add("cv-spin");
        setTimeout(function () { refreshBtn.classList.remove("cv-spin"); }, 750);
      }
      toast("Chart refreshed");
    }

    /* ------------------------------------------------------------ replay
       TradingView's Bar Replay. The bars in play are a prefix of the dataset
       we already hold, so indicators, drawings, the magnet and the OHLC strip
       all keep behaving exactly as they do live — there is no second data
       path to keep in sync. */

    function replaySlice(k) {
      var f = replay.full;
      if (!f) return null;
      k = clamp(Math.round(k), 1, f.n);
      return {
        time: f.time.slice(0, k), open: f.open.slice(0, k), high: f.high.slice(0, k),
        low: f.low.slice(0, k), close: f.close.slice(0, k), volume: f.volume.slice(0, k),
        n: k, meta: f.meta
      };
    }

    function replayApply() {
      if (!replay.on || !chart || !replay.full) return;
      var f = replay.full;
      /* Armed keeps the whole series on screen — a candle you cannot see is a
         candle you cannot click — and only slices down once a start is picked. */
      data = replaySlice(replay.armed ? f.n : replay.idx + 1);
      if (!data || !data.n) return;
      candleSeries.setData(candleData());
      drawnN = data.n;
      rebuildIndicators();
      /* Hold the frontier near the right edge — that is where replay reads. */
      try {
        var span = clamp(Math.round(data.n * 0.6), 40, 220);
        chart.timeScale().setVisibleLogicalRange({ from: data.n - 1 - span, to: data.n - 1 + 6 });
      } catch (e) { /* noop */ }
      showBar(replay.armed ? clamp(replay.startIdx, 0, data.n - 1) : data.n - 1);
      if (replay.armed) {
        setStatus("Starts " + stampFor(f.time[clamp(replay.startIdx, 0, f.n - 1)]) +
                  " — click a candle to move it");
      } else {
        setStatus("replay " + (replay.idx + 1) + "/" + replay.full.n +
                  " · " + stampFor(data.time[data.n - 1]));
      }
      syncReplayBar();
      scheduleRedraw();
    }

    function replayClearTimer() {
      if (replay.timer) { clearInterval(replay.timer); replay.timer = 0; }
    }

    function replaySchedule() {
      replayClearTimer();
      if (!replay.on || !replay.playing) return;
      replay.timer = setInterval(replayTick, Math.max(70, Math.round(850 / replay.speed)));
    }

    function replayTick() {
      if (!replay.on || !replay.full) return;
      if (replay.idx >= replay.full.n - 1) { replayPause(); return; }
      replay.idx++;
      replayApply();
    }

    function replayPlay() {
      if (!replay.on || !replay.full) return;
      if (replay.armed) replayConfirm(replay.startIdx);   // lock the marker in
      if (replay.idx >= replay.full.n - 1) {              // at the frontier — rewind first
        replay.idx = replay.startIdx;
        replayApply();
      }
      replay.playing = true;
      replaySchedule();
      syncReplayBar();
    }

    function replayPause() {
      replay.playing = false;
      replayClearTimer();
      syncReplayBar();
    }

    function replayStep() {
      if (!replay.on || !replay.full) return;
      replayPause();
      if (replay.idx >= replay.full.n - 1) return;
      replay.idx++;
      replayApply();
    }

    function replayRestart() {
      if (!replay.on || !replay.full) return;
      replayPause();
      replay.idx = replay.startIdx;
      replayApply();
    }

    function exitReplay(silent) {
      if (!replay.on) return;
      replayPause();
      replay.on = false;
      replay.armed = false;
      var full = replay.full;
      replay.full = null;
      if (full && full.n) {
        data = full;
        candleSeries.setData(candleData());
        drawnN = data.n;
        rebuildIndicators();
        resetZoom();
        setStatus(data.n + " bars · " + st.interval);
        scheduleRedraw();
      }
      histEager = false;
      histReadyAt = Date.now() + 700;
      syncReplayBar();
      if (!silent && full) toast("Replay ended", full.n + " bars restored", "", 1800);
    }

    function toggleReplay() {
      if (replay.on) { exitReplay(); return; }
      if (data.n < 6) { toast("Nothing to replay yet", "Load some bars first", "err"); return; }
      /* TradingView never picks the start for you — it arms the chart and
         leaves a marker on the bar you choose. The old "hide a fifth of the
         series" heuristic still parks that marker somewhere sensible, so
         there is something to refine rather than nothing to aim at. */
      var keep = clamp(Math.round(data.n * 0.2), 40, 300);
      if (keep > data.n - 2) keep = data.n - 2;
      var start = clamp(data.n - 1 - keep, 1, data.n - 2);
      replay.full = data;
      replay.startIdx = start;
      replay.idx = start;
      replay.on = true;
      replay.armed = true;
      replay.playing = false;
      histEager = true;                 // never backfill history through a replay
      if (replayBar) replayBar.style.display = "flex";
      replayApply();
      syncReplayBar();
      toast("Bar replay", "Click a candle — or drag the scrubber — to set where it starts", "", 4200);
    }

    /* Lock the marker in and start from there. */
    function replayConfirm(idx) {
      if (!replay.on || !replay.full) return;
      /* One bar either side so there is always something to play into and
         something already played to read. */
      idx = clamp(Math.round(idx), 1, replay.full.n - 2);
      replay.armed = false;
      replay.startIdx = idx;
      replay.idx = idx;
      replayApply();
      syncReplayBar();
    }

    /* Jump to reads and writes a clock reading, so it needs the pair of
       conversions. Everything is UTC: the bars are, and mixing a local
       timezone into a bar index would drop the replay on the wrong day for
       anyone west of Greenwich. */
    function stampInput(t) {
      var d = new Date(t * 1000);
      return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") +
             "-" + String(d.getUTCDate()).padStart(2, "0") +
             "T" + String(d.getUTCHours()).padStart(2, "0") + ":" +
             String(d.getUTCMinutes()).padStart(2, "0");
    }
    function inputToTime(v) {
      var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v || ""));
      if (!m) return 0;
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) / 1000;
    }
    /* The bar a chosen moment falls *inside*, not the one after it — picking
       14:30 on a 1h chart should start on the 14:00 candle. */
    function replayIndexAt(t) {
      var f = replay.full;
      if (!f || !f.n) return -1;
      var lo = 0, hi = f.n - 1, best = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (f.time[mid] <= t) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best;
    }

    /* Which bar a click at chart-x is asking for. The logical index is the
       direct mapping — bar i sits at logical i while armed, since every bar is
       on screen — with a time round-trip as the fallback for the off-scale
       edges where LWC hands back null. */
    function replayPickAt(x) {
      var f = replay.full;
      if (!f || !f.n || !chart) return -1;
      var l = null;
      try { l = chart.timeScale().coordinateToLogical(x); } catch (e) { l = null; }
      if (l != null && !isNaN(l)) return clamp(Math.round(l), 0, f.n - 1);
      var t = null;
      try { t = chart.timeScale().coordinateToTime(x); } catch (e2) { t = null; }
      if (t == null) return -1;
      var at = f.time.indexOf(t);
      return at >= 0 ? at : replayIndexAt(t);
    }

    function syncReplayBar() {
      if (replayPlayBtn) replayPlayBtn.innerHTML = replay.playing ? ICON.pause : ICON.play;
      if (replayRead && replay.on && replay.full) {
        replayRead.textContent = (replay.idx + 1) + " / " + replay.full.n;
      }
      if (replaySpeedBtn) replaySpeedBtn.textContent = replay.speed + "x";
      if (replayBtn) replayBtn.classList.toggle("on", !!replay.on);
      if (replayBar) replayBar.style.display = replay.on ? "flex" : "none";
      if (replayScrub && replay.on && replay.full && !replay.dragging) {
        /* max stops one short: replayConfirm clamps to n-2 so there is always
           a bar to play into. */
        replayScrub.max = String(Math.max(1, replay.full.n - 2));
        replayScrub.value = String(clamp(replay.startIdx, 1, replay.full.n - 2));
        replayScrub.title = replay.armed
          ? "Drag to choose where replay starts"
          : "Drag to replay from another bar";
      }
      if (replayJump && replay.on && replay.full) {
        var f = replay.full;
        replayJump.max = stampInput(f.time[f.n - 1]);
        replayJump.min = stampInput(f.time[0]);
        replayJump.value = stampInput(f.time[clamp(replay.startIdx, 0, f.n - 1)]);
        replayJump.title = replay.armed
          ? "Jump to — set the start moment (UTC)"
          : "Jump to — restart the replay at this moment (UTC)";
      }
      if (replayHint) replayHint.textContent = replay.armed ? "Click a candle to start" : "";
    }

    /* TradingView docks replay transport under the plot: restart, play/pause,
       step, speed and exit, with a live bar counter. */
    function buildReplayBar() {
      var speeds = [0.5, 1, 2, 3, 5];
      replaySpeedBtn = el("button", {
        class: "cv-rbtn speed", text: "1x",
        title: "Replay speed",
        onclick: function () {
          var i = speeds.indexOf(replay.speed);
          replay.speed = speeds[(i + 1) % speeds.length];
          replaySpeedBtn.textContent = replay.speed + "x";
          replaySchedule();
        }
      });
      replayPlayBtn = el("button", {
        class: "cv-rbtn primary", html: ICON.play,
        title: "Play / pause (space)",
        onclick: function () { if (replay.playing) replayPause(); else replayPlay(); }
      });
      replayRead = el("span", { class: "cv-rread", text: "" });
      /* Dragging repositions the marker only; re-slicing the whole series per
         pixel would stutter, so the commit is left to the release. */
      replayScrub = el("input", {
        class: "cv-rscrub", type: "range", min: "1", max: "100", value: "1", step: "1",
        title: "Drag to choose where replay starts",
        oninput: function () {
          if (!replay.on || !replay.full) return;
          /* Read the drag position BEFORE replayPause(): pausing calls
             syncReplayBar(), which writes scrub.value straight back from the
             old startIdx and would erase the bar being dragged onto. */
          var v = clamp(Number(replayScrub.value), 1, replay.full.n - 2);
          replay.dragging = true;      // …and keep pause from snapping it back
          replayPause();
          replay.dragging = false;
          replay.startIdx = v;
          replay.idx = v;
          if (replayRead) replayRead.textContent = (v + 1) + " / " + replay.full.n;
          setStatus("Starts " + stampFor(replay.full.time[v]) + " — release to start there");
          scheduleRedraw();
        },
        onchange: function () {
          if (!replay.on || !replay.full) return;
          var v = Number(replayScrub.value);
          replayPause();
          replayConfirm(v);
        }
      });
      replayJump = el("input", {
        class: "cv-rjump", type: "datetime-local",
        title: "Jump to — set the start moment (UTC)",
        onchange: function () {
          if (!replay.on || !replay.full) return;
          var at = replayIndexAt(inputToTime(replayJump.value));
          if (at >= 0) { replayPause(); replayConfirm(at); }
        }
      });
      replayHint = el("span", { class: "cv-rhint", text: "" });
      replayBar = el("div", { class: "cv-replay", style: "display:none" }, [
        el("span", { class: "cv-rlab", text: "REPLAY" }),
        el("button", { class: "cv-rbtn", html: ICON.restart, title: "Back to the start bar", onclick: replayRestart }),
        replayPlayBtn,
        el("button", { class: "cv-rbtn", html: ICON.step, title: "Step one candle forward", onclick: replayStep }),
        replaySpeedBtn,
        replayScrub,
        replayJump,
        replayHint,
        replayRead,
        el("button", { class: "cv-rbtn exit", html: ICON.x, title: "Exit replay", onclick: function () { exitReplay(); } })
      ]);
      mainWrap.appendChild(replayBar);
    }

    /* -------------------------------------------------------- OHLC bar */
    function showBar(i) {
      if (!data || !data.n) return;
      i = clamp(i, 0, data.n - 1);
      var up = data.close[i] >= data.open[i];
      var diff = data.close[i] - data.open[i];
      var pct = data.open[i] ? (data.close[i] / data.open[i] - 1) * 100 : 0;
      ohlc.o.textContent = fmtPrice(data.open[i]);
      ohlc.h.textContent = fmtPrice(data.high[i]);
      ohlc.l.textContent = fmtPrice(data.low[i]);
      ohlc.c.textContent = fmtPrice(data.close[i]);
      /* signed absolute change plus its percentage — only Chg carries colour */
      ohlc.chg.textContent = (diff >= 0 ? "+" : "") + fmtPrice(diff) + " (" + fmtPct(pct) + ")";
      ohlc.vol.textContent = fmtCompact(data.volume[i]);
      /* tv.com colours the whole strip by the bar's direction, not just the
         change — on the AAPL sample O/H/L/C and the change were all
         rgb(8,153,129) while the change itself was negative, because the bar
         closed above its open. Volume stays neutral: it belongs to the study
         legend, not the quote strip. */
      var dir = "v " + (up ? "pos" : "neg");
      [ohlc.o, ohlc.h, ohlc.l, ohlc.c].forEach(function (n) { n.className = dir; });
      ohlc.vol.className = "v";
      ohlc.chg.className = dir;
      ohlc.stamp.textContent = stampFor(data.time[i]);
    }

    function stampFor(t) {
      var d0 = new Date(t * 1000);
      var date = d0.getUTCFullYear() + "-" + String(d0.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d0.getUTCDate()).padStart(2, "0");
      if (st.interval === "1d" || st.interval === "1w") return date + " UTC";
      return date + " " + String(d0.getUTCHours()).padStart(2, "0") + ":" + String(d0.getUTCMinutes()).padStart(2, "0") + " UTC";
    }

    function onCrosshair(param) {
      if (!param || !param.time || !data) { if (data) showBar(data.n - 1); return; }
      var idx = data.time.indexOf(param.time);
      if (idx < 0) {
        // fall back to the values the chart itself resolved
        var cs = param.seriesData && param.seriesData.get(candleSeries);
        if (cs && isNum(cs.open)) {
          ohlc.o.textContent = fmtPrice(cs.open);
          ohlc.h.textContent = fmtPrice(cs.high);
          ohlc.l.textContent = fmtPrice(cs.low);
          ohlc.c.textContent = fmtPrice(cs.close);
          var abs = cs.close - cs.open;
          var p = cs.open ? (cs.close / cs.open - 1) * 100 : 0;
          ohlc.chg.textContent = (abs >= 0 ? "+" : "") + fmtPrice(abs) + " (" + fmtPct(p) + ")";
          var up = cs.close >= cs.open;
          var dir = "v " + (up ? "pos" : "neg");
          [ohlc.o, ohlc.h, ohlc.l, ohlc.c].forEach(function (n) { n.className = dir; });
          ohlc.vol.className = "v";
          ohlc.chg.className = dir;
          ohlc.stamp.textContent = stampFor(param.time);
        }
        return;
      }
      showBar(idx);
    }

    function onQuoteBar() {
      var q = st.quote;
      if (q && isNum(q.price)) {
        var absChg = q.price * q.change_pct / 100;   // keeps its own sign
        lastEl.textContent = fmtPrice(q.price);
        chgEl.textContent = (absChg >= 0 ? "+" : "") + fmtPrice(absChg) + "  " + fmtPct(q.change_pct);
        chgEl.className = "cv-chg " + (q.change_pct > 0 ? "pos" : q.change_pct < 0 ? "neg" : "");
      } else if (data && data.n) {
        lastEl.textContent = fmtPrice(data.close[data.n - 1]);
        chgEl.textContent = "";
      }
      if (data && data.n) showBar(data.n - 1);
    }

    /* ------------------------------------------------------ data loads */
    function setStatus(txt, isErr) {
      statusEl.textContent = txt || "";
      statusEl.classList.toggle("err", !!isErr);
    }

    function normalize(k) {
      var n = (k.time || []).length;
      var out = { time: [], open: [], high: [], low: [], close: [], volume: [], n: 0, meta: k };
      for (var i = 0; i < n; i++) {
        var t = k.time[i];
        if (!isNum(t) || !isNum(k.close[i])) continue;
        if (out.time.length && t <= out.time[out.time.length - 1]) continue;
        out.time.push(t);
        out.open.push(k.open[i]);
        out.high.push(k.high[i]);
        out.low.push(k.low[i]);
        out.close.push(k.close[i]);
        out.volume.push(k.volume[i] || 0);
      }
      out.n = out.time.length;
      return out;
    }

    /* The chart-type menu swaps the main series for another LWC series type,
       so the payload has to match: OHLC for the candle/bar styles, `value`
       alone for line/area/baseline, and a Heikin-Ashi rebuild for that menu
       entry. Every setData() call site goes through here. */
    function candleData() {
      var t = st.chartType;
      var i;
      if (t === "line" || t === "area" || t === "baseline") {
        var lv = new Array(data.n);
        for (i = 0; i < data.n; i++) lv[i] = { time: data.time[i], value: data.close[i] };
        return lv;
      }
      if (t === "heikinashi") {
        var ha = new Array(data.n), ho = 0, hc = 0;
        for (i = 0; i < data.n; i++) {
          hc = (data.open[i] + data.high[i] + data.low[i] + data.close[i]) / 4;
          ho = i === 0 ? (data.open[0] + data.close[0]) / 2 : (ho + hc) / 2;
          ha[i] = {
            time: data.time[i], open: ho, close: hc,
            high: Math.max(data.high[i], ho, hc),
            low: Math.min(data.low[i], ho, hc)
          };
        }
        return ha;
      }
      var out = new Array(data.n);
      for (i = 0; i < data.n; i++) {
        out[i] = {
          time: data.time[i], open: data.open[i], high: data.high[i],
          low: data.low[i], close: data.close[i]
        };
      }
      return out;
    }

    function seriesKindFor(type) {
      if (type === "bars") return "bar";
      if (type === "line") return "line";
      if (type === "area") return "area";
      if (type === "baseline") return "baseline";
      return "candle";
    }

    function seriesOptionsFor(type) {
      var base = { priceFormat: pf(fmtPrice), priceLineVisible: true, priceLineStyle: 2, lastValueVisible: true };
      if (type === "bars") {
        return Object.assign(base, { upColor: TV.up, downColor: TV.down, thinBars: false });
      }
      if (type === "line") {
        return Object.assign(base, { color: "#2962ff", lineWidth: 2, crosshairMarkerVisible: true, crosshairMarkerRadius: 3 });
      }
      if (type === "area") {
        return Object.assign(base, {
          lineColor: "#2962ff", lineWidth: 2,
          topFillColor: "rgba(41,98,255,0.30)", bottomFillColor: "rgba(41,98,255,0.03)",
          crosshairMarkerVisible: true, crosshairMarkerRadius: 3
        });
      }
      if (type === "baseline") {
        return Object.assign(base, {
          baseValue: { type: "price", price: baselinePrice() },
          topLineColor: TV.up, topFillColor1: "rgba(8,153,129,0.28)", topFillColor2: "rgba(8,153,129,0.02)",
          bottomLineColor: TV.down, bottomFillColor1: "rgba(242,54,69,0.02)", bottomFillColor2: "rgba(242,54,69,0.28)",
          lineWidth: 2, crosshairMarkerVisible: true, crosshairMarkerRadius: 3
        });
      }
      if (type === "hollow") {
        return Object.assign(base, {
          upColor: "rgba(0,0,0,0)", borderUpColor: TV.up, wickUpColor: TV.up,
          downColor: TV.down, borderDownColor: TV.down, wickDownColor: TV.down
        });
      }
      return Object.assign(base, {
        upColor: TV.up, downColor: TV.down,
        borderUpColor: TV.up, borderDownColor: TV.down,
        wickUpColor: TV.up, wickDownColor: TV.down
      });
    }

    function seriesClassFor(type) {
      var k = seriesKindFor(type);
      return k === "bar" ? LW.BarSeries
        : k === "line" ? LW.LineSeries
          : k === "area" ? LW.AreaSeries
            : k === "baseline" ? LW.BaselineSeries
              : LW.CandlestickSeries;
    }

    function baselinePrice() {
      if (!data || !data.n) return 0;
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < data.n; i++) {
        if (data.low[i] < lo) lo = data.low[i];
        if (data.high[i] > hi) hi = data.high[i];
      }
      if (!isNum(lo) || !isNum(hi)) return data.close[data.n - 1];
      return (lo + hi) / 2;
    }

    function applyChartType(type) {
      if (!CHART_TYPES[type]) type = "candles";
      st.chartType = type;
      store("cx.cv.ctype", type);
      if (chartTypeBtn) {
        chartTypeBtn.title = "Chart type — " + CHART_TYPES[type].label;
        chartTypeBtn.classList.toggle("on", type !== "candles");
      }
      if (!chart || !candleSeries) return;
      /* Add the replacement FIRST: LWC tears down a pane the moment its last
         series goes, which would silently fold the price pane into the first
         indicator pane and take the candles with it.  The main pane is only
         empty in between if we remove first — so never do that. */
      var old = candleSeries;
      markerApi = null;
      try {
        candleSeries = chart.addSeries(seriesClassFor(type), seriesOptionsFor(type));
      } catch (e) {
        console.warn("[chartview] add", e);
        candleSeries = old;
        return;
      }
      try { candleSeries.setData(candleData()); } catch (e) { console.warn("[chartview] setData", e); }
      try { chart.removeSeries(old); } catch (e) { console.warn("[chartview] swap", e); }
      applyMarkers();
      scheduleRedraw();
    }
    function setChartType(type) {
      if (type === st.chartType) return;
      applyChartType(type);
      toast("Chart type", CHART_TYPES[type].label, "ok", 1800);
    }

    /* ---------------------------------------------------- history backfill
       Every venue answers with at most 1000 bars a request, so "all of it" is
       a walk backwards: each page ends just before the oldest bar we hold,
       until the exchange says there is nothing older.  The ALL button drives
       that walk up front; scrolling past the left edge keeps it going, so the
       chart never runs out of the past. */
    var HISTORY_PAGE = 1000;
    var HISTORY_EAGER = 60000;     // bars ALL loads before it hands over
    var HISTORY_MAX = 200000;      // ceiling so a 1m chart cannot eat the tab
    var hasMoreBars = false;
    var histBusy = false;
    var histEager = false;
    var histMisses = 0;
    var histReadyAt = 0;
    var drawnN = 0;                // bars the chart itself is currently drawing
    var applyTimer = 0;

    function historyUrl(endTime) {
      var u = "/api/chart/" + encodeURIComponent(st.symbol) + "?interval=" + st.interval +
              "&limit=" + HISTORY_PAGE;
      if (endTime) u += "&end_time=" + endTime;
      /* Stay on the exchange the chart came from — one history, one venue. */
      var src = data && data.meta && data.meta.source;
      if (src) u += "&source=" + encodeURIComponent(src);
      return u;
    }

    /* Fold an older page in front of what we hold.  Returns false when nothing
       moved — that is how a venue with no range API says "there is no more". */
    function mergeOlder(k) {
      if (!k || !data || !data.n) return false;
      var older = normalize(k);
      if (!older.n) return false;
      var first = data.time[0];
      var t = [], o = [], h = [], l = [], c = [], v = [];
      for (var i = 0; i < older.n; i++) {
        if (older.time[i] >= first) continue;
        t.push(older.time[i]); o.push(older.open[i]); h.push(older.high[i]);
        l.push(older.low[i]); c.push(older.close[i]); v.push(older.volume[i]);
      }
      if (!t.length) return false;
      data.time = t.concat(data.time);
      data.open = o.concat(data.open);
      data.high = h.concat(data.high);
      data.low = l.concat(data.low);
      data.close = c.concat(data.close);
      data.volume = v.concat(data.volume);
      data.n = data.time.length;
      return true;
    }

    /* Redraw on the bars we have, keeping the window where you were looking.
       Swapping in older bars shifts every logical index by `added`, so the
       same window simply lands that much further along — restoring by time
       instead lets LWC clamp it onto the oldest bars when the range is
       momentarily degenerate during a swap. */
    function applyHistory() {
      if (!alive || !chart || !data || !data.n) return;
      var vis = chart.timeScale().getVisibleLogicalRange();
      var added = data.n - drawnN;
      candleSeries.setData(candleData());
      rebuildIndicators();
      if (vis && isNum(vis.from) && isNum(vis.to)) {
        try {
          chart.timeScale().setVisibleLogicalRange(
            added > 0 ? { from: vis.from + added, to: vis.to + added } : vis);
        } catch (e) { /* noop */ }
      }
      drawnN = data.n;
      scheduleRedraw();
      setStatus(data.n + " bars · " + st.interval + " · from " + stampFor(data.time[0]));
    }

    /* Chained backfill can outrun the renderer, so batch the redraws. */
    function applyHistorySoon() {
      if (applyTimer) return;
      applyTimer = setTimeout(function () { applyTimer = 0; applyHistory(); }, 250);
    }

    function loadOlderPage(seqNo) {
      if (!alive || seqNo !== loadSeq || !hasMoreBars || histBusy || replay.on) return Promise.resolve(false);
      if (!data || !data.n) return Promise.resolve(false);
      if (data.n >= HISTORY_MAX) { hasMoreBars = false; return Promise.resolve(false); }
      histBusy = true;
      return api(historyUrl(data.time[0] - 1)).then(function (k) {
        histBusy = false;
        if (!alive || seqNo !== loadSeq) return false;
        var moved = mergeOlder(k);
        hasMoreBars = !!(k && k.has_more) && moved;
        histMisses = 0;
        return moved;
      }).catch(function () {
        histBusy = false;
        /* a blip must not kill the walk, but three in a row means we are done */
        if (++histMisses >= 3) hasMoreBars = false;
        return false;
      });
    }

    /* ALL: keep walking backwards until the exchange runs dry. */
    function startFullHistory(seqNo) {
      (function step() {
        if (!alive || seqNo !== loadSeq) return;
        setStatus(data.n + " bars · " + st.interval + " · loading full history…");
        loadOlderPage(seqNo).then(function (moved) {
          if (!alive || seqNo !== loadSeq) return;
          if (moved && data.n < HISTORY_EAGER) { step(); return; }
          histEager = false;
          histReadyAt = Date.now() + 700;
          applyHistory();
          resetZoom();
          scheduleRedraw();
          toast("Full history loaded",
                data.n + " bars back to " + stampFor(data.time[0]) +
                (hasMoreBars ? " · scroll left for more" : ""), "", 4000);
        });
      })();
    }

    function boot() {
      var seqNo = ++loadSeq;
      /* A replay is pinned to the bars we were showing — leave it before the
         symbol or timeframe changes underneath it. */
      if (replay.on) {
        replay.on = false;
        replayClearTimer();
        replay.full = null;
        syncReplayBar();
      }
      setStatus("loading…");
      /* histEager doubles as "ignore the left edge for now": setData fires the
         range callback with the *previous* view's range, and that negative
         from would start a backfill the moment the chart mounts. */
      hasMoreBars = false; histBusy = false; histEager = true; histMisses = 0;
      clearTimeout(applyTimer); applyTimer = 0;
      /* 0 = ALL: grab the newest page first so the chart paints immediately,
         then walk backwards below. */
      var want = st.limit === 0 ? HISTORY_PAGE : Math.min(st.limit, HISTORY_PAGE);
      var chartUrl = "/api/chart/" + encodeURIComponent(st.symbol) + "?interval=" + st.interval + "&limit=" + want;
      Promise.all([
        api(chartUrl),
        api("/api/ticker?symbols=" + encodeURIComponent(st.symbol)).catch(function () { return null; })
      ]).then(function (res) {
        if (!alive || seqNo !== loadSeq) return;
        var k = res[0], tk = res[1];
        data = normalize(k);
        hasMoreBars = !!(k && k.has_more);
        st.quote = (tk && tk.rows && tk.rows[st.symbol]) || null;
        if (!data.n) {
          setStatus("no data", true);
          toast("No data", st.symbol + " on " + st.interval, "err");
          return;
        }
        candleSeries.setData(candleData());
        drawnN = data.n;
        // indicators + drawings follow the symbol/timeframe
        if (seqNo === loadSeq) {
          // Tear down the layout we are leaving BEFORE swapping st.indicators:
          // the old instances hold the LW panes, so replacing the array first
          // would leak them (empty panes piling up on every timeframe switch).
          st.indicators.slice().forEach(destroyInstance);
          var saved = recall(iKey(), null) || recall(legacyIKey(), null);
          /* An empty array is not a layout, it is the residue of a partial
             save — a stale tab still running older code can write one over a
             perfectly good set. Treat it as "nothing stored" so the layout
             (carry, then defaults) comes back instead of sticking empty. */
          if (saved && (!Array.isArray(saved) || !saved.length)) saved = null;
          var inds;
          if (pendingPrefer === "carry" && layoutCarry) inds = clone(layoutCarry);
          else if (saved) inds = saved;
          else if (pendingPrefer !== "carry" && layoutCarry) inds = clone(layoutCarry);
          else inds = defaultIndicators();
          st.indicators = inds.map(function (i) {
            var study = STUDY_MAP[i.id];
            return study
              ? { uid: i.uid || uid("ind"), id: i.id, params: Object.assign(clone(study.defaults), i.params || {}) }
              : null;
          }).filter(Boolean);
          st.drawings = resolveDrawings();
          pendingPrefer = "switch";   // consumed — later switches decide on their own
          st.selected = null;
          rebuildIndicators();
          layoutReady = true;
          saveIndicators();
          saveDrawings();
          resetZoom();
        }
        onQuoteBar();
        rememberRecent();
        renderQuick();
        var src = data.meta && data.meta.source ? " · " + data.meta.source : "";
        if (data.meta && data.meta.source) { dataSource = data.meta.source; syncLegendTitle(); }
        setStatus(data.n + " bars · " + tfLabel(st.interval) + src);
        if (seqNo !== loadSeq) return;
        if (st.limit === 0) startFullHistory(seqNo);
        else { histEager = false; histReadyAt = Date.now() + 700; }  // laid out — the left edge may load more in a moment
      }).catch(function (e) {
        if (!alive || seqNo !== loadSeq) return;
        setStatus("load failed", true);
        toast("Could not load chart", (e && e.message) || String(e), "err");
      });
    }

    /* -------------------------------------------------- symbol search */
    function universe() {
      if (!universeCache) {
        universeCache = api("/api/universe?size=600").then(function (r) {
          return (r && r.rows) || [];
        }).catch(function () { universeCache = null; return []; });
      }
      return universeCache;
    }

    function closeSuggest() {
      if (suggestBox) { suggestBox.classList.remove("on"); }
    }

    function onSearchInput() {
      clearTimeout(searchTimer);
      var q = searchInput.value.trim().toUpperCase();
      if (!q) { closeSuggest(); return; }
      searchTimer = setTimeout(function () {
        universe().then(function (rows) {
          if (!alive) return;
          var hits = rows.filter(function (r) {
            return r.symbol.indexOf(q) === 0 || r.symbol.indexOf(q) > -1 || (r.base || "").indexOf(q) === 0;
          }).slice(0, 12);
          showSuggest(hits, q);
        });
      }, 220);
    }

    function showSuggest(rows, q) {
      if (!suggestBox) {
        suggestBox = el("div", { class: "cv-suggest" });
        searchInput.parentNode.appendChild(suggestBox);
      }
      suggestBox.innerHTML = "";
      if (!rows.length) {
        suggestBox.appendChild(el("div", { class: "cv-sg" }, [el("div", { class: "empty", text: "No symbol matches “" + esc(q) + "”" })]));
      }
      rows.forEach(function (r, i) {
        suggestBox.appendChild(el("div", {
          class: "cv-sg" + (i === 0 ? " on" : ""),
          onclick: function () { goToSymbol(r.symbol); }
        }, [
          el("span", { class: "b", text: r.base || r.symbol.replace(/USDT$/, "") }),
          el("span", { class: "s", text: r.symbol }),
          el("span", { class: "p", text: fmtPrice(r.price) }),
          el("span", { class: "c " + (r.change_pct >= 0 ? "pos" : "neg"), text: fmtPct(r.change_pct) })
        ]));
      });
      suggestBox.classList.add("on");
    }

    function onSearchKey(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        var v = searchInput.value.trim().toUpperCase();
        if (!v) return;
        if (suggestBox && suggestBox.classList.contains("on")) {
          var first = suggestBox.querySelector(".cv-sg");
          if (first && !first.querySelector(".empty")) { first.click(); return; }
        }
        goToSymbol(/USDT$/.test(v) ? v : v + "USDT");
      } else if (e.key === "Escape") {
        closeSuggest();
        searchInput.value = st.symbol;
        searchInput.blur();
      }
    }

    var onDocClick = function (e) {
      if (suggestBox && !searchInput.parentNode.contains(e.target)) closeSuggest();
    };
    document.addEventListener("click", onDocClick);

    /* ------------------------------------------------------- dialogs */
    function closeModal() {
      if (dialog && dialog.parentNode) dialog.remove();
      dialog = null;
    }

    /* `mid` is optional chrome slotted between the title bar and the body —
       TradingView puts the Inputs / Style / Visibility tab strip there. */
    function openModal(title, body, foot, small, mid) {
      closeModal();
      var kids = [
        el("div", { class: "cv-mhead" }, [el("span", { text: title }), el("span", { class: "spacer" }),
          el("button", { class: "cv-ibtn", html: ICON.x, title: "Close", onclick: closeModal })]),
        el("div", { class: "cv-mbody" }, [body]),
        el("div", { class: "cv-mfoot" }, foot || [])
      ];
      if (mid) kids.splice(1, 0, mid);
      var box = el("div", { class: "cv-modal" + (small ? " small" : "") }, kids);
      dialog = el("div", {
        class: "cv-modal-bg",
        onclick: function (e) { if (e.target.classList.contains("cv-modal-bg")) closeModal(); }
      }, [box]);
      viewEl.appendChild(dialog);
      return closeModal;
    }

    function fieldRow(field, value, onChange) {
      var lab = el("div", { class: "lab" }, [el("span", { text: field.label })]);
      var input;
      if (field.type === "number") {
        input = el("input", { type: "number", min: field.min, max: field.max, step: field.step || "any", value: value });
        input.addEventListener("change", function () {
          var v = parseFloat(input.value);
          if (!isNum(v)) v = field.dflt;
          v = clamp(v, field.min != null ? field.min : -1e9, field.max != null ? field.max : 1e9);
          input.value = v;
          onChange(v);
        });
      } else if (field.type === "range") {
        input = el("input", { type: "range", min: field.min, max: field.max, step: field.step || 1, value: value });
        lab.appendChild(el("span", { class: "val", text: String(value) }));
        input.addEventListener("input", function () {
          lab.querySelector(".val").textContent = input.value;
          onChange(parseFloat(input.value));
        });
      } else if (field.type === "checkbox") {
        input = el("input", { type: "checkbox", class: "cv-cb" });
        input.checked = !!value;
        input.addEventListener("change", function () { onChange(input.checked); });
      } else if (field.type === "select") {
        input = el("select", {}, (field.options || []).map(function (o) {
          /* An option may carry a label of its own — a timeframe is stored as
             Pine's "60" but read as "1 hour". Plain strings still work. */
          var isPair = o && typeof o === "object";
          var val = isPair ? o.v : o, txt = isPair ? o.t : o;
          var opt = el("option", { value: val, text: txt });
          if (String(val) === String(value)) opt.selected = true;
          return opt;
        }));
        input.addEventListener("change", function () { onChange(input.value); });
      } else if (field.type === "color") {
        input = el("div", { class: "cv-swatches" });
        var picker = el("input", { type: "color", class: "cv-color", value: value });
        picker.addEventListener("input", function () { onChange(picker.value); syncSwatches(picker.value); });
        input.appendChild(picker);
        ["#3b82f6", "#f59e0b", "#22c55e", "#ef4444", "#a78bfa", "#22d3ee", "#f472b6", "#14b8a6", "#eab308", "#ffffff"].forEach(function (c) {
          var sw = el("button", { class: "cv-sw" + (c.toLowerCase() === String(value).toLowerCase() ? " on" : ""), style: "background:" + c,
            onclick: function () { picker.value = c; onChange(c); syncSwatches(c); } });
          input.appendChild(sw);
        });
        function syncSwatches(c) {
          $$(".cv-sw", input).forEach(function (b) {
            b.classList.toggle("on", b.style.backgroundColor === hexToRgb(c));
          });
        }
      } else {
        input = el("input", { type: "text", value: value });
        input.addEventListener("change", function () { onChange(input.value); });
      }
      return el("div", { class: "cv-field" }, [lab, input]);
    }

    function hexToRgb(hex) {
      var h = String(hex || "").replace("#", "");
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      if (!isNum(n)) return "";
      return "rgb(" + ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255) + ")";
    }

    /* TradingView's Visibility tab: one row per interval unit, each with an
       enable checkbox, a from/to pair and a slider between them. */
    var VIS_ROWS = [
      { key: "sec", label: "Seconds", min: 1, max: 59 },
      { key: "min", label: "Minutes", min: 1, max: 59 },
      { key: "hour", label: "Hours", min: 1, max: 24 },
      { key: "day", label: "Days", min: 1, max: 31 },
      { key: "week", label: "Weeks", min: 1, max: 52 },
      { key: "month", label: "Months", min: 1, max: 12 },
      { key: "range", label: "Ranges", min: null, max: null }
    ];

    function openSettings(uidv) {
      var inst = st.indicators.find(function (x) { return x.uid === uidv; });
      if (!inst) return;
      var study = STUDY_MAP[inst.id];
      var original = clone(inst.params);
      var draft = Object.assign(clone(study.defaults), clone(inst.params));
      if (!draft.vis) draft.vis = defaultVis();

      function apply() { updateIndicator(inst.uid, clone(draft)); }

      /* A Style row now owns its colour, width and level. Anything the Style
         table does not cover — pane height, ADX's DI colours — stays on
         Inputs rather than disappearing from the dialog. */
      var styledKeys = {};
      (study.srows || []).forEach(function (r) {
        if (r.c) styledKeys[r.c] = true;
        if (r.w) styledKeys[r.w] = true;
      });
      function tabOf(f) {
        var t = fieldTab(f);
        if (t === "style" && f.type !== "section" && study.srows && !styledKeys[f.key]) return "inputs";
        return t;
      }

      function fieldsPane(tab) {
        var pane = el("div", { class: "cv-tabpane" });
        /* A section header is only printed once one of its fields lands here,
           so groups whose controls all live on Style don't leave a bare title. */
        var pending = null;
        study.fields.forEach(function (f) {
          if (tabOf(f) !== tab) return;
          if (f.type === "section") { pending = f.label; return; }
          if (pending != null) {
            pane.appendChild(el("div", { class: "cv-sec", text: pending }));
            pending = null;
          }
          var current = draft[f.key] !== undefined ? draft[f.key] : study.defaults[f.key];
          pane.appendChild(fieldRow(f, current, function (v) {
            draft[f.key] = v;
            if (f.type === "range" || f.type === "color" || f.type === "select" || f.type === "checkbox") apply();
          }));
        });
        if (!pane.childNodes.length) pane.appendChild(el("div", { class: "hint", text: "Nothing to configure here." }));
        return pane;
      }

      function visibilityPane() {
        var pane = el("div", { class: "cv-tabpane" });
        VIS_ROWS.forEach(function (row) {
          var v = draft.vis[row.key] || { on: true, from: 1, to: 1 };
          var cb = el("input", { type: "checkbox", class: "cv-cb" });
          cb.checked = v.on !== false;
          var kids = [cb, el("span", { class: "cv-vlab", text: row.label })];
          var from = null, to = null, sl = null;
          if (row.min != null) {
            from = el("input", { type: "number", class: "cv-vnum", value: v.from, min: row.min, max: row.max });
            to = el("input", { type: "number", class: "cv-vnum", value: v.to, min: row.min, max: row.max });
            sl = el("input", { type: "range", class: "cv-vsl", min: row.min, max: row.max, value: v.to });
            kids.push(from, sl, to);
          }
          function sync() {
            var on = cb.checked;
            var lo = from ? clamp(parseInt(from.value, 10) || row.min, row.min, row.max) : 1;
            var hi = to ? clamp(parseInt(to.value, 10) || row.max, row.min, row.max) : 1;
            if (from && lo > hi) lo = hi;
            if (to && hi < lo) hi = lo;
            if (from) { from.value = lo; from.disabled = !on; }
            if (to) { to.value = hi; to.disabled = !on; }
            if (sl) { sl.value = hi; sl.disabled = !on; }
            draft.vis[row.key] = { on: on, from: lo, to: hi };
            apply();
          }
          cb.addEventListener("change", sync);
          if (from) from.addEventListener("change", sync);
          if (to) to.addEventListener("change", sync);
          if (sl) sl.addEventListener("input", function () { if (to) to.value = sl.value; sync(); });
          pane.appendChild(el("div", { class: "cv-vis" + (cb.checked ? "" : " off") }, kids));
        });
        return pane;
      }

      /* ------------------------------------------------- TradingView Style */
      var swatchPainters = [], pop = null, popDoc = null;

      function closePop() {
        if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
        pop = null;
        if (popDoc) { document.removeEventListener("mousedown", popDoc, true); popDoc = null; }
      }
      function repaintSwatches() {
        swatchPainters.forEach(function (fn) { try { fn(); } catch (e) { /* noop */ } });
      }
      function curCol(key) {
        var v = draft[key];
        if (v === undefined || v === "") v = study.defaults[key];
        return v || "#3b82f6";
      }
      function setCol(key, c, defer) {
        draft[key] = c;
        repaintSwatches();
        if (!defer) apply();
      }

      function makeSwatch(keys) {
        var key = keys.c;
        var sw = el("i", {});
        function paint() {
          var c = curCol(key), a = alphaOf(c);
          sw.style.backgroundColor = c;
          if (a < 1) {
            sw.style.backgroundImage =
              "linear-gradient(45deg,rgba(255,255,255,.6) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.6) 75%)," +
              "linear-gradient(45deg,rgba(255,255,255,.6) 25%,transparent 25%,transparent 75%,rgba(255,255,255,.6) 75%)";
            sw.style.backgroundSize = "8px 8px";
            sw.style.backgroundPosition = "0 0, 4px 4px";
          } else {
            sw.style.backgroundImage = "none";
            sw.style.backgroundSize = "";
            sw.style.backgroundPosition = "";
          }
        }
        paint();
        swatchPainters.push(paint);
        var btn = el("button", { class: "cv-swatch", type: "button", title: "Colour" }, [sw]);
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          openPop(btn, keys);
        });
        return btn;
      }

      /* TradingView's colour popover: palette, Opacity, Thickness, Line style. */
      function openPop(anchor, keys) {
        closePop();
        if (!dialog) return;
        pop = el("div", { class: "cv-cpop" });
        var cKey = keys.c, wKey = keys.w, lsKey = keys.ls;

        var pal = el("div", { class: "cv-cp-pal" });
        TV_PALETTE.forEach(function (rowCols) {
          var row = el("div", { class: "cv-cp-row" });
          rowCols.forEach(function (h) {
            var b = el("button", { class: "cv-cp-sw", type: "button", style: "background:" + h });
            if (String(curCol(cKey)).toLowerCase() === h.toLowerCase()) b.classList.add("on");
            b.onclick = function () { setCol(cKey, withAlpha(h, alphaOf(curCol(cKey)))); };
            row.appendChild(b);
          });
          pal.appendChild(row);
        });
        pop.appendChild(pal);

        var opa = Math.round(alphaOf(curCol(cKey)) * 100);
        var opSec = el("div", { class: "cv-cp-sec" }, [el("div", { class: "cv-cp-t", text: "Opacity" })]);
        var opRange = el("input", { type: "range", min: 0, max: 100, step: 1, value: opa, class: "cv-cp-sl" });
        var opNum = el("input", { type: "number", min: 0, max: 100, step: 1, value: opa, class: "cv-cp-num" });
        function pushOpa(v, defer) {
          v = clamp(parseInt(v, 10) || 0, 0, 100);
          opRange.value = v; opNum.value = v;
          setCol(cKey, withAlpha(curCol(cKey), v / 100), defer);
        }
        opRange.addEventListener("input", function () { pushOpa(opRange.value, true); });
        opRange.addEventListener("change", function () { apply(); });
        opNum.addEventListener("change", function () { pushOpa(opNum.value, false); });
        opSec.appendChild(el("div", { class: "cv-cp-op" }, [opRange, opNum, el("span", { class: "cv-cp-pct", text: "%" })]));
        pop.appendChild(opSec);

        if (wKey) {
          var thSec = el("div", { class: "cv-cp-sec" }, [el("div", { class: "cv-cp-t", text: "Thickness" })]);
          var thRow = el("div", { class: "cv-cp-th" });
          var curW = draft[wKey] !== undefined ? draft[wKey] : study.defaults[wKey];
          THICKNESS.forEach(function (n) {
            var b = el("button", { class: "cv-cp-thi" + (n === curW ? " on" : ""), type: "button", title: n + "px" },
              [el("i", { style: "border-top-width:" + n + "px" })]);
            b.onclick = function () {
              draft[wKey] = n;
              Array.prototype.forEach.call(thRow.children, function (c) { c.classList.remove("on"); });
              b.classList.add("on");
              apply();
            };
            thRow.appendChild(b);
          });
          thSec.appendChild(thRow);
          pop.appendChild(thSec);
        }

        if (lsKey) {
          var lsSec = el("div", { class: "cv-cp-sec" }, [el("div", { class: "cv-cp-t", text: "Line style" })]);
          var lsRow = el("div", { class: "cv-cp-ls" });
          var curLs = draft[lsKey] !== undefined ? draft[lsKey] : study.defaults[lsKey];
          LINE_STYLES.forEach(function (o) {
            var b = el("button", { class: "cv-cp-lsi" + (o.v === curLs ? " on" : ""), type: "button", title: o.label },
              [el("div", { class: "cv-cp-seg s" + o.v })]);
            b.onclick = function () {
              draft[lsKey] = o.v;
              Array.prototype.forEach.call(lsRow.children, function (c) { c.classList.remove("on"); });
              b.classList.add("on");
              apply();
            };
            lsRow.appendChild(b);
          });
          lsSec.appendChild(lsRow);
          pop.appendChild(lsSec);
        }

        dialog.appendChild(pop);
        var ar = anchor.getBoundingClientRect();
        pop.style.top = (ar.bottom + 6) + "px";
        pop.style.left = ar.left + "px";
        var pr = pop.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8) pop.style.left = Math.max(8, window.innerWidth - pr.width - 8) + "px";
        if (pr.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, ar.top - pr.height - 6) + "px";
        popDoc = function (e) {
          if (!pop || !pop.isConnected) { closePop(); return; }
          if (!pop.contains(e.target)) closePop();
        };
        document.addEventListener("mousedown", popDoc, true);
      }

      function stylePane() {
        var pane = el("div", { class: "cv-tabpane cv-style" });
        if (!study.srows) return fieldsPane("style");

        function labCell(text, row, cls) {
          if (row && row.on) {
            var cb = el("input", { type: "checkbox", class: "cv-cb" });
            cb.checked = draft[row.on] !== false;
            cb.addEventListener("change", function () { draft[row.on] = cb.checked; apply(); });
            return el("div", { class: "cv-scell lab " + (cls || "") },
              [el("label", { class: "cv-slab" }, [cb, el("span", { text: text })])]);
          }
          return el("div", { class: "cv-scell lab " + (cls || ""), text: text });
        }

        function options(key, opts, value, cls) {
          var sel = el("select", { class: cls || "cv-sps" });
          opts.forEach(function (o) {
            var opt = el("option", { value: o, text: o });
            if (String(o) === String(value)) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.addEventListener("change", function () { draft[key] = sel.value; apply(); });
          return sel;
        }

        function lineStyleSelect(key) {
          var sel = el("select", { class: "cv-sps cv-sls" });
          var cur = draft[key] !== undefined ? draft[key] : study.defaults[key];
          LINE_STYLES.forEach(function (o) {
            var opt = el("option", { value: String(o.v), text: o.label });
            if (String(o.v) === String(cur)) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.addEventListener("change", function () { draft[key] = parseInt(sel.value, 10); apply(); });
          return sel;
        }

        function numberCtl(key) {
          var inp = el("input", { type: "number", class: "cv-snum", value: draft[key] });
          inp.addEventListener("change", function () {
            var v = parseFloat(inp.value);
            if (!isNum(v)) v = study.defaults[key];
            inp.value = v;
            draft[key] = v;
            apply();
          });
          return inp;
        }

        function checkRow(text, key) {
          var cb = el("input", { type: "checkbox", class: "cv-cb" });
          cb.checked = draft[key] !== false;
          cb.addEventListener("change", function () { draft[key] = cb.checked; apply(); });
          return el("div", { class: "cv-srow fill" }, [
            el("div", { class: "cv-scell fill" }, [el("label", { class: "cv-slab" }, [cb, el("span", { text: text })])])
          ]);
        }

        function sectionRow(text) {
          return el("div", { class: "cv-srow fill sec" }, [el("div", { class: "cv-scell fill", text: text })]);
        }

        function addRow(row) {
          if (row.k === "sep") { pane.appendChild(el("div", { class: "cv-ssep" })); return; }
          if (row.k === "grp") { pane.appendChild(el("div", { class: "cv-srow fill" }, [labCell(row.lab, row, "fill")])); return; }
          var kids = [labCell(row.lab, row, row.k === "kid" ? "first grouped" : "first")];
          var flat = row.k === "fill";
          var ctl = el("div", { class: "cv-scell ctl" + (row.k === "kid" ? " grouped" : "") });
          if (row.c) ctl.appendChild(makeSwatch({
            c: row.c, w: flat ? null : (row.w || null), ls: flat ? null : (row.ls || null)
          }));
          if (row.c2) ctl.appendChild(makeSwatch({ c: row.c2, w: null, ls: null }));
          if (!flat) {
            if (row.pl != null && row.ls) ctl.appendChild(lineStyleSelect(row.ls));
            else if (row.ps) ctl.appendChild(options(row.ps, PLOT_STYLES, study.defaults[row.ps]));
          }
          if (row.v) ctl.appendChild(numberCtl(row.v));
          pane.appendChild(el("div", { class: "cv-srow" + (row.k === "kid" ? " grouped" : "") }, kids.concat([ctl])));
        }

        study.srows.forEach(addRow);
        pane.appendChild(el("div", { class: "cv-ssep big" }));
        pane.appendChild(sectionRow("OUTPUT VALUES"));
        pane.appendChild(el("div", { class: "cv-srow" }, [
          el("div", { class: "cv-scell lab first", text: "Precision" }),
          el("div", { class: "cv-scell ctl" },
            [options("precision", ["Default", "0", "1", "2", "3", "4", "5", "6", "7", "8"], draft.precision || "Default")])
        ]));
        pane.appendChild(checkRow("Labels on price scale", "lblScale"));
        pane.appendChild(checkRow("Values in status line", "lblStatus"));
        pane.appendChild(sectionRow("INPUT VALUES"));
        pane.appendChild(checkRow("Inputs in status line", "inpStatus"));
        return pane;
      }

      var panes = { inputs: fieldsPane("inputs"), style: stylePane(), visibility: visibilityPane() };
      var body = el("div", { class: "cv-tabsbody" });
      Object.keys(panes).forEach(function (k) { body.appendChild(panes[k]); });

      var TABS = [["inputs", "Inputs"], ["style", "Style"], ["visibility", "Visibility"]];
      var strip = el("div", { class: "cv-tabs" });
      function setActive(id) {
        $$(".cv-tab", strip).forEach(function (b) { b.classList.toggle("on", b.dataset.tab === id); });
        Object.keys(panes).forEach(function (k) { panes[k].style.display = k === id ? "" : "none"; });
      }
      TABS.forEach(function (t) {
        var b = el("button", { class: "cv-tab", text: t[1] });
        b.dataset.tab = t[0];
        b.onclick = function () { setActive(t[0]); };
        strip.appendChild(b);
      });

      /* Footer: TradingView's Defaults split button, then Cancel / Ok. */
      var menu = null, menuDoc = null;
      function closeMenu() {
        if (menu && menu.parentNode) menu.remove();
        menu = null;
        if (menuDoc) { document.removeEventListener("click", menuDoc); menuDoc = null; }
      }
      var defaultsBtn = el("button", { class: "cv-btn cv-btn-def", text: "Defaults ▾",
        onclick: function (e) {
          e.stopPropagation();
          if (menu) { closeMenu(); return; }
          menu = el("div", { class: "cv-menu" }, [
            el("button", { text: "Reset settings", onclick: function () {
              closeMenu();
              var reset = clone(study.defaults);
              if (!reset.vis) reset.vis = defaultVis();
              draft = reset;
              closeModal();
              updateIndicator(inst.uid, clone(draft));
            } }),
            el("button", { text: "Remove indicator", class: "danger", onclick: function () {
              closeMenu(); closeModal(); removeIndicator(inst.uid);
            } })
          ]);
          dialog.querySelector(".cv-modal").appendChild(menu);
          menuDoc = function () { closeMenu(); };
          document.addEventListener("click", menuDoc);
        } });

      openModal(study.name, body, [
        el("span", { class: "spacer" }),
        defaultsBtn,
        el("button", { class: "cv-btn", text: "Cancel", onclick: function () {
          updateIndicator(inst.uid, original); closeModal();
        } }),
        el("button", { class: "cv-btn cv-btn-primary", text: "Ok", onclick: function () {
          apply(); closeModal();
        } })
      ], true, strip);
      setActive("inputs");
    }

    /* Indicator templates: save the current set under a name, load it back
       later — TradingView's "Indicator templates" button. */
    /* --------------------------------------------------- header actions */
    function tfSec(iv) {
      var m = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
                "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200,
                "1d": 86400, "3d": 259200, "1w": 604800, "1M": 2592000 };
      return m[iv] || 86400;
    }

    /* --- compare ----------------------------------------------------- */
    function compareClear() {
      if (compareSeries && chart) { try { chart.removeSeries(compareSeries); } catch (e) { /* noop */ } }
      compareSeries = null; compareSym = null;
      scheduleRedraw();
    }
    function compareAdd(sym) {
      if (!chart) return;
      if (compareSym === sym) { compareClear(); toast("Comparison removed", sym, ""); return; }
      var epoch = ++compareEpoch;
      var url = "/api/chart/" + encodeURIComponent(sym) + "?interval=" + encodeURIComponent(st.interval) +
                "&limit=" + Math.max(300, Math.min(st.limit || 300, 5000));
      toast("Comparing…", sym, "", 1400);
      api(url).then(function (k) {
        if (!alive || epoch !== compareEpoch) return;
        var d = normalize(k);
        if (!d || !d.n) { toast("No data", sym + " on " + st.interval, "err"); return; }
        if (compareSeries && chart) { try { chart.removeSeries(compareSeries); } catch (e) { /* noop */ } compareSeries = null; }
        var pts = new Array(d.n);
        for (var i = 0; i < d.n; i++) pts[i] = { time: d.time[i], value: d.close[i] };
        try {
          compareSeries = chart.addSeries(LW.LineSeries, {
            priceScaleId: "cmp-" + sym,
            color: "#ff6d00", lineWidth: 2,
            priceLineVisible: false, lastValueVisible: false,
            crosshairMarkerVisible: false
          });
          compareSeries.setData(pts);
          compareSym = sym;
          toast("Comparison added", st.symbol + "  vs  " + sym, "ok");
          scheduleRedraw();
        } catch (e) {
          console.warn("[chartview] compare", e);
          toast("Compare failed", String((e && e.message) || e), "err");
        }
      }).catch(function (e) { toast("Compare failed", String((e && e.message) || e), "err"); });
    }

    /* --- undo / redo -------------------------------------------------
       A 700ms watcher diffs the drawing list, so every edit route (drag,
       delete, colour change, text edit) is captured without hooking each
       call site separately. */
    undoTimer = setInterval(function () {
      if (!alive) { clearInterval(undoTimer); return; }
      var j = JSON.stringify(st.drawings || []);
      if (j === undoLast) return;
      if (undoLast !== null) {
        undoStack.push(undoLast);
        if (undoStack.length > 60) undoStack.shift();
        redoStack.length = 0;
      }
      undoLast = j;
      syncUndo();
    }, 700);

    function syncUndo() {
      if (undoBtn) undoBtn.disabled = !undoStack.length;
      if (redoBtn) redoBtn.disabled = !redoStack.length;
      if (undoBtn) undoBtn.title = undoStack.length ? "Undo the last drawing change" : "Nothing to undo yet";
      if (redoBtn) redoBtn.title = redoStack.length ? "Redo the last undone change" : "Nothing to redo";
    }
    function applyDrawingsJson(j) {
      try { st.drawings = JSON.parse(j) || []; } catch (e) { return false; }
      st.selected = null; st.pending = null;
      saveDrawings();
      scheduleRedraw();
      return true;
    }
    function drawingsStep(dir) {
      var cur = JSON.stringify(st.drawings || []);
      if (dir < 0) {
        if (!undoStack.length) { toast("Nothing to undo", "Draw something first", ""); return; }
        redoStack.push(cur);
        if (!applyDrawingsJson(undoStack.pop())) return;
      } else {
        if (!redoStack.length) { toast("Nothing to redo", "", ""); return; }
        undoStack.push(cur);
        if (!applyDrawingsJson(redoStack.pop())) return;
      }
      undoLast = JSON.stringify(st.drawings || []);
      syncUndo();
    }

    /* --- save / share / fullscreen / snapshot ------------------------- */
    function saveNow() {
      saveIndicators(); saveDrawings(); notifyState();
      toast("Layout saved",
            st.symbol + " · " + st.interval + " · " + st.indicators.length +
            (st.indicators.length === 1 ? " indicator" : " indicators") + " · " +
            (st.drawings || []).length + " drawings", "ok", 2600);
    }
    function shareIdea() {
      var url = location.href;
      var done = function () { toast("Link copied", url.length > 70 ? url.slice(0, 70) + "…" : url, "ok", 3000); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { toast("Share", url, "", 4000); });
      } else {
        toast("Share", url, "", 4000);
      }
    }
    function toggleFullscreen() {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      var t = viewEl.requestFullscreen && viewEl.requestFullscreen();
      if (t && t.catch) t.catch(function () { toast("Fullscreen blocked", "Use your browser's fullscreen command instead", "err"); });
    }
    function takeSnapshot() {
      try {
        var mr = mainWrap.getBoundingClientRect();
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(mr.width * dpr));
        out.height = Math.max(1, Math.round(mr.height * dpr));
        var ctx = out.getContext("2d");
        ctx.fillStyle = TV.bg;
        ctx.fillRect(0, 0, out.width, out.height);
        var kids = mainWrap.querySelectorAll("canvas");
        for (var i = 0; i < kids.length; i++) {
          var c = kids[i], r = c.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          try {
            ctx.drawImage(c, (r.left - mr.left) * dpr, (r.top - mr.top) * dpr,
                          r.width * dpr, r.height * dpr);
          } catch (e) { /* a canvas we cannot read — skip it */ }
        }
        var name = st.symbol + "-" + st.interval + "-" + Date.now() + ".png";
        var a = document.createElement("a");
        a.download = name;
        a.href = out.toDataURL("image/png");
        a.click();
        toast("Snapshot saved", name, "ok", 3000);
      } catch (e) {
        console.warn("[chartview] snapshot", e);
        toast("Snapshot failed", String((e && e.message) || e), "err");
      }
    }

    /* --- go to date / time zone -------------------------------------- */
    function goToStamp(v) {
      if (!v || !data || !data.n) return;
      var p = String(v).split("-");
      if (p.length !== 3) return;
      var sec = Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1) / 1000;
      function land() {
        var i = barIndexAt(sec);
        if (i == null || i < 0) i = sec <= data.time[0] ? 0 : data.n - 1;
        var span = Math.max(40, Math.min(400, Math.round((drawnN || data.n) * 0.4)));
        var from = Math.max(0, i - span), to = Math.min(data.n - 1, i + span);
        if (to - from < 12) from = Math.max(0, to - 12);
        try { chart.timeScale().setVisibleRange({ from: from, to: to }); } catch (e) { /* noop */ }
        toast("Went to " + v, stampFor(data.time[Math.min(i, data.n - 1)]), "", 2600);
      }
      /* A date older than what we hold: walk the history back to it first.
         Clamping silently to the oldest loaded bar is what made this look
         broken — TradingView just loads the region you asked for. */
      if (sec <= data.time[0] && hasMoreBars && !replay.on) {
        var seqNo = loadSeq;
        (function step() {
          if (!alive || seqNo !== loadSeq) { land(); return; }
          setStatus(data.n + " bars · " + st.interval + " · loading history to " + v + "…");
          loadOlderPage(seqNo).then(function (moved) {
            if (!alive || seqNo !== loadSeq) return;
            if (data.time[0] <= sec || !moved || data.n >= HISTORY_MAX) {
              setStatus(data.n + " bars · " + st.interval);
              land();
              return;
            }
            step();
          });
        })();
        return;
      }
      land();
    }

    function tzFmt(sec, opts) {
      try {
        return new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: st.tz }, opts))
          .format(new Date(sec * 1000));
      } catch (e) { return new Date(sec * 1000).toISOString(); }
    }
    function updateClock() {
      if (!tzBtn) return;
      var parts;
      try {
        parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: st.tz, hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false, timeZoneName: "short"
        }).formatToParts(new Date());
      } catch (e) { parts = null; }
      if (!parts) { tzBtn.textContent = st.tz; return; }
      var g = {};
      parts.forEach(function (x) { g[x.type] = x.value; });
      tzBtn.textContent = (g.hour || "00") + ":" + (g.minute || "00") + ":" + (g.second || "00") +
        (g.timeZoneName ? " " + g.timeZoneName : "");
    }
    function applyTz() {
      if (!chart) return;
      try {
        chart.applyOptions({
          localization: {
            timeFormatter: function (t) {
              var sec = typeof t === "number" ? t : Number(t);
              if (!isNum(sec)) return "";
              return tzFmt(sec, { year: "numeric", month: "short", day: "2-digit",
                                  hour: "2-digit", minute: "2-digit", hour12: false });
            }
          },
          timeScale: {
            tickMarkFormatter: function (time) {
              var sec = Number(time);
              if (!isNum(sec)) return "";
              var intraday = st.interval === "15m" || st.interval === "1h" || st.interval === "4h";
              return intraday
                ? tzFmt(sec, { hour: "2-digit", minute: "2-digit", hour12: false })
                : tzFmt(sec, { year: "2-digit", month: "short", day: "2-digit" });
            }
          }
        });
      } catch (e) { console.warn("[chartview] timezone", e); }
    }
    function setTz(z) {
      st.tz = z;
      store("cx.cv.tz", z);
      applyTz();
      updateClock();
      scheduleRedraw();
      toast("Time zone", z, "ok", 2000);
    }

    /* --- chart settings dialog ---------------------------------------- */
    function setRow(label, hint, input) {
      return el("label", { class: "cv-srow" }, [
        el("span", { class: "cv-slab" }, [
          el("span", { class: "t", text: label }),
          hint ? el("span", { class: "h", text: hint }) : null
        ]),
        input
      ]);
    }
    function cb(on, onChange) {
      var b = el("input", { type: "checkbox", class: "cv-cb" });
      b.checked = !!on;
      b.addEventListener("change", function () { onChange(b.checked); });
      return b;
    }
    function sel(opts, value, onChange) {
      var s = el("select", {}, opts.map(function (o) {
        var opt = el("option", { value: o, text: o });
        if (o === value) opt.selected = true;
        return opt;
      }));
      s.addEventListener("change", function () { onChange(s.value); });
      return s;
    }

    function openSettingsDialog() {
      var strip = el("div", { class: "cv-tabs" });
      var body = el("div", { class: "cv-set" });
      var panes = {};

      function pane(id, kids) {
        var p = el("div", { class: "cv-setpane" }, kids);
        p.style.display = "none";
        panes[id] = p;
        body.appendChild(p);
        var t = el("button", { class: "cv-tab", text: id.charAt(0).toUpperCase() + id.slice(1) });
        t.dataset.tab = id;
        t.onclick = function () { show(id); };
        strip.appendChild(t);
      }
      function show(id) {
        Object.keys(panes).forEach(function (k) { panes[k].style.display = k === id ? "" : "none"; });
        $$(".cv-tab", strip).forEach(function (b) { b.classList.toggle("on", b.dataset.tab === id); });
      }

      function optv(fn, dflt) {
        try { var v = fn(); return v == null ? dflt : v; } catch (e) { return dflt; }
      }

      /* Symbol */
      pane("symbol", [
        setRow("Watermark", "symbol behind the candles",
          cb(optv(function () { return chart.options().watermark.visible; }, true), function (v) {
            chart.applyOptions({ watermark: { visible: v } }); })),
        setRow("OHLC values", "the O H L C Chg Vol strip",
          cb(ohlcRow.style.display !== "none", function (v) { ohlcRow.style.display = v ? "" : "none"; })),
        setRow("Legend", "indicator titles and values",
          cb(legend.style.display !== "none", function (v) { legend.style.display = v ? "" : "none"; })),
        setRow("Last price line", "dotted line at the latest close",
          cb(true, function (v) { candleSeries.applyOptions({ priceLineVisible: v, lastValueVisible: v }); })),
        setRow("Symbol", "", el("div", { class: "cv-sfix", text: st.symbol }))
      ]);

      /* Scales */
      var modeSel = sel(["Normal", "Logarithmic", "Percentage"],
        ["Normal", "Logarithmic", "Percentage"][optv(function () { return chart.priceScale("right").options().mode; }, 0) || 0],
        function (v) {
          var map = { Normal: 0, Logarithmic: 1, Percentage: 2 };
          chart.priceScale("right").applyOptions({ mode: map[v] });
        });
      pane("scales", [
        setRow("Price scale mode", "", modeSel),
        setRow("Auto fit data to screen", "fit every loaded bar",
          el("button", { class: "cv-btn", text: "Reset", onclick: function () { resetZoom(); } })),
        setRow("Scale margins", "space above and below the series",
          el("div", { class: "cv-sfix", text: "8% / 24%" })),
        setRow("Right price scale", "",
          cb(true, function (v) { chart.applyOptions({ rightPriceScale: { visible: v } }); }))
      ]);

      /* Time zone */
      pane("timezone", TZS.map(function (z) {
        return el("label", { class: "cv-srow" }, [
          el("span", { class: "cv-slab" }, [el("span", { class: "t", text: z })]),
          (function () {
            var r = el("input", { type: "radio", name: "cv-tz", class: "cv-cb" });
            r.checked = st.tz === z;
            r.addEventListener("change", function () { if (r.checked) setTz(z); });
            return r;
          })()
        ]);
      }));

      /* Appearance */
      pane("appearance", [
        setRow("Grid lines", "vertical and horizontal guides",
          cb(optv(function () { return chart.options().grid.vertLines.visible; }, false), function (v) {
            chart.applyOptions({ grid: { vertLines: { visible: v }, horzLines: { visible: v } } });
          })),
        setRow("Crosshair mode", "",
          sel(["Normal", "Magnet"], optv(function () { return chart.options().crosshair.mode; }, 0) === 1 ? "Magnet" : "Normal",
            function (v) { chart.applyOptions({ crosshair: { mode: v === "Magnet" ? 1 : 0 } }); })),
        setRow("Show drawings", "",
          cb(!st.hideDrawings, function (v) { st.hideDrawings = !v; store("cx.cv.hidedraw", !v); scheduleRedraw(); })),
        setRow("Left drawing rail", "",
          cb(toolsWrap.style.display !== "none", function (v) { toolsWrap.style.display = v ? "" : "none"; }))
      ]);

      show("symbol");

      openModal("Chart settings", body,
        [el("button", { class: "cv-btn cv-btn-primary", text: "Done", onclick: closeModal })],
        false, strip);
    }

    /* --- create alert -------------------------------------------------- */
    function openAlertDialog() {
      var last = data && data.n ? data.close[data.n - 1] : 0;
      /* The scan grammar wants bracketed field references — ``latest close``
         parses but is rejected downstream as an unknown operator.  Each row
         below is a clause the engine has actually accepted. */
      var conds = [
        { k: "crossUp", label: "Crossing up", op: "crossed above" },
        { k: "crossDown", label: "Crossing down", op: "crossed below" },
        { k: "gt", label: "Greater than", op: ">" },
        { k: "lt", label: "Less than", op: "<" }
      ];
      var condSel = sel(conds.map(function (c) { return c.label; }), conds[0].label, function () {});
      var valIn = el("input", { type: "number", step: "any", class: "cv-snum", value: fmtPrice(last) });
      var msgIn = el("input", { type: "text", class: "cv-textin",
        placeholder: st.symbol + " crossed " + fmtPrice(last) });
      var status = el("div", { class: "hint", text: "The alert runs on every scan cycle and can notify this tab." });

      function clause() {
        var c = conds[Math.max(0, conds.map(function (x) { return x.label; }).indexOf(condSel.value))];
        var v = parseFloat(valIn.value);
        if (!isNum(v)) v = last;
        return "[close] " + c.op + " " + v;
      }
      function refresh() {
        status.textContent = "Clause:  " + clause() + "  ·  last closed " + st.interval + " candle";
      }

      condSel.addEventListener("change", refresh);
      valIn.addEventListener("input", refresh);
      refresh();

      var body = el("div", { class: "cv-alert" }, [
        setRow("Symbol", "", el("div", { class: "cv-sfix", text: st.symbol })),
        setRow("Condition", "", condSel),
        setRow("Value", "price level", valIn),
        setRow("Message", "", msgIn),
        status
      ]);

      openModal("Create alert on " + st.symbol, body, [
        el("button", { class: "cv-btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "cv-btn cv-btn-primary", text: "Create", onclick: function () {
          var payload = {
            name: msgIn.value.trim() || (st.symbol + " " + condSel.value + " " + valIn.value),
            clause: clause(),
            interval: st.interval,
            limit: 400,
            enabled: true
          };
          status.textContent = "Saving…";
          fetch("/api/alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
              if (!res.ok || res.j.error) throw new Error(res.j && res.j.error || "request failed");
              closeModal();
              toast("Alert created", payload.clause + " · " + payload.interval, "ok", 3600);
            })
            .catch(function (e) {
              status.textContent = "Could not create the alert: " + ((e && e.message) || e);
              toast("Alert failed", String((e && e.message) || e), "err");
            });
        } })
      ], true);
    }

    function openPresetDialog() {
      var nameInput = el("input", {
        type: "text", class: "cv-tpl-name", maxlength: "48",
        placeholder: "Name this set — e.g. “My MACD strategy”"
      });
      var listBox = el("div", { class: "cv-tpl-list" });

      function paint() {
        var list = presetList();
        listBox.innerHTML = "";
        if (!list.length) {
          listBox.appendChild(el("div", { class: "hint", text: "Nothing saved yet." }));
          return;
        }
        list.forEach(function (p) {
          listBox.appendChild(el("div", { class: "cv-tpl" }, [
            el("span", { class: "nm", text: p.name }),
            el("span", { class: "sub", text: p.items.length + (p.items.length === 1 ? " indicator" : " indicators") }),
            el("span", { class: "spacer" }),
            el("button", {
              class: "cv-btn cv-btn-primary", text: "Load",
              onclick: function () {
                if (!presetApply(p.name)) return;
                closeModal();
                toast("Template loaded", p.name + " · " + st.indicators.length + " indicators", "ok", 2600);
              }
            }),
            el("button", {
              class: "cv-ibtn", html: ICON.x, title: "Delete “" + p.name + "”",
              onclick: function () { presetDrop(p.name); paint(); }
            })
          ]));
        });
      }

      function save() {
        var nm = (nameInput.value || "").trim();
        if (!nm) { toast("Name required", "Type a name for this set", "err"); nameInput.focus(); return; }
        if (!st.indicators.length) { toast("Nothing to save", "Add at least one indicator first", "err"); return; }
        if (!presetSave(nm)) return;
        nameInput.value = "";
        paint();
        toast("Template saved", nm + " · " + st.indicators.length + " indicators", "ok", 2600);
      }

      nameInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); save(); }
      });

      var body = el("div", { class: "cv-tpl-body" }, [
        el("div", {
          class: "hint",
          text: "Saves the indicators below plus every one of their settings. Load it on any symbol and the whole setup is rebuilt exactly as you left it."
        }),
        el("div", { class: "cv-tpl-current", text: "Current set · " + st.indicators.length + " indicator" + (st.indicators.length === 1 ? "" : "s") }),
        el("div", { class: "cv-tpl-save" }, [
          nameInput,
          el("button", { class: "cv-btn cv-btn-primary", text: "Save this set", onclick: save })
        ]),
        el("div", { class: "cv-group-title", text: "Saved templates" }),
        listBox
      ]);

      paint();
      openModal("Indicator templates", body, [
        el("span", { class: "hint", text: presetList().length + " saved" }),
        el("button", { class: "primary", text: "Close", onclick: closeModal })
      ]);
      setTimeout(function () { nameInput.focus(); }, 30);
    }

    function openIndicatorDialog() {
      var searchBox = el("input", { type: "text", class: "cv-find", placeholder: "Search indicators…", spellcheck: "false" });
      var listBox = el("div", {});
      var activeBox = el("div", { class: "cv-active" });

      var titleEl = el("div", { class: "cv-group-title", text: "Active · " + st.indicators.length });

      function paintActive() {
        titleEl.textContent = "Active · " + st.indicators.length;
        activeBox.innerHTML = "";
        if (!st.indicators.length) {
          activeBox.appendChild(el("div", { class: "hint", text: "Nothing active yet." }));
          return;
        }
        st.indicators.forEach(function (inst) {
          var study = STUDY_MAP[inst.id];
          if (!study) return;
          activeBox.appendChild(el("div", { class: "cv-ai" }, [
            el("span", { class: "dot", style: "background:" + (inst.params.color || inst.params.color2 || "#3b82f6") }),
            el("span", { class: "nm", text: studyLabel(inst) }),
            el("span", { class: "ps", text: studyDetail(inst) }),
            el("span", { class: "spacer" }),
            el("button", { class: "cv-ibtn", html: ICON.gear, title: "Edit",
              onclick: function () { openSettings(inst.uid); } }),
            el("button", { class: "cv-ibtn", html: ICON.x, title: "Remove",
              onclick: function () { removeIndicator(inst.uid); paintActive(); } })
          ]));
        });
      }

      function paint() {
        var q = searchBox.value.trim().toLowerCase();
        listBox.innerHTML = "";
        var groups = GROUP_ORDER.slice();
        var any = false;
        groups.forEach(function (g) {
          var items = STUDIES.filter(function (s) {
            if (s.group !== g) return false;
            if (!q) return true;
            return s.name.toLowerCase().indexOf(q) > -1 || s.short.toLowerCase().indexOf(q) > -1 || s.id.indexOf(q) > -1;
          });
          if (!items.length) return;
          any = true;
          listBox.appendChild(el("div", { class: "cv-group-title", text: g }));
          var grid = el("div", { class: "cv-grid" });
          items.forEach(function (s) {
            grid.appendChild(el("button", {
              class: "cv-study",
              onclick: function () {
                addIndicator(s.id);
                paintActive();
                toast("Indicator added", s.name, "ok", 2000);
              }
            }, [
              el("span", { class: "plus", text: "+" }),
              el("span", { text: s.name }),
              el("span", { class: "sub", text: s.kind === "pane" ? "pane" : "overlay" })
            ]));
          });
          listBox.appendChild(grid);
        });
        if (!any) listBox.appendChild(el("div", { class: "hint", text: "No indicator matches that search." }));
      }

      searchBox.addEventListener("input", paint);

      var body = el("div", {}, [
        searchBox,
        titleEl,
        activeBox,
        el("div", { style: "height:6px" }),
        listBox
      ]);
      paint();
      paintActive();

      openModal("Indicators", body, [
        el("span", { class: "hint", text: STUDIES.length + " studies · unlimited instances" }),
        el("button", { html: ICON.templates + "<span>Templates</span>", class: "cv-ibtn wide",
          title: "Save this set of indicators + settings, or load one you saved",
          onclick: openPresetDialog }),
        el("button", {
          text: "Remove all", class: "danger",
          onclick: function () {
            st.indicators.slice().forEach(function (i) { destroyInstance(i); });
            st.indicators = [];
            saveIndicators();
            renderLegend();
            paintActive();
            scheduleRedraw();
          }
        }),
        el("button", { class: "primary", text: "Close", onclick: closeModal })
      ]);
      setTimeout(function () { searchBox.focus(); }, 30);
    }

    /* ------------------------------------------------------- keyboard */
    keyHandler = function (e) {
      if (!alive) return;
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.key === " " || e.code === "Space") && replay.on) {
        e.preventDefault();
        if (replay.playing) replayPause(); else replayPlay();
        return;
      }
      if (e.key === "Escape") {
        if (ctxMenu) { closeCtxMenu(); return; }
        if (flyout) { closeFlyout(); return; }
        if (dialog) { closeModal(); return; }
        if (st.pending) { st.pending = null; scheduleRedraw(); return; }
        if (st.selected) { st.selected = null; scheduleRedraw(); return; }
        if (st.tool !== "cursor") setTool("cursor");
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && st.selected) {
        e.preventDefault();
        deleteDrawing(st.selected);
        toast("Drawing deleted", "", "", 1400);
        return;
      }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.35); return; }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.35); return; }
      if (e.key === "0") { e.preventDefault(); resetZoom(); return; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        var ck = typeof e.key === "string" ? e.key.toLowerCase() : "";
        if (ck === "z" && !e.shiftKey) { e.preventDefault(); drawingsStep(-1); return; }
        if (ck === "y" || (ck === "z" && e.shiftKey)) { e.preventDefault(); drawingsStep(1); return; }
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        var r = chart.timeScale().getVisibleLogicalRange();
        if (r) {
          e.preventDefault();
          var shiftBy = e.key === "ArrowLeft" ? -8 : 8;
          chart.timeScale().setVisibleLogicalRange({ from: r.from + shiftBy, to: r.to + shiftBy });
        }
        return;
      }
      var map = { v: "cursor", t: "trend", r: "ray", h: "hline", m: "measure", e: "delete", z: "zoomregion" };
      var key = typeof e.key === "string" && e.key.length === 1 ? e.key.toLowerCase() : "";
      if (map[key] && !e.ctrlKey && !e.metaKey && !e.altKey) setTool(map[key]);
    };
    window.addEventListener("keydown", keyHandler);

    resizeHandler = function () {
      if (!alive) return;
      mainWrap.style.setProperty("--cv-h", chartHeight() + "px");
      /* The chart has to be given the new box before anything is measured off
         it — autoSize alone is not reliable here (see fitChart). */
      fitChart();
      /* TradingView keeps indicator panes at a fixed height and lets the price
         pane absorb window resizes — re-assert ours so the factors don't just
         stretch everything proportionally. */
      applyPaneSizes();
      scheduleRedraw();
    };
    window.addEventListener("resize", resizeHandler);

    /* ------------------------------------------------- right-click menu
       TradingView's chart context menu: view actions, clipboard, the
       indicator dialog and the drawing-mode toggles. */
    var ctxMenu = null;
    function closeCtxMenu() {
      if (!ctxMenu) return;
      var m = ctxMenu;
      ctxMenu = null;
      if (m.node && m.node.parentNode) m.node.parentNode.removeChild(m.node);
      document.removeEventListener("mousedown", m.onDoc, true);
      window.removeEventListener("blur", closeCtxMenu);
    }
    function openCtxMenu(x, y) {
      closeCtxMenu();
      var node = el("div", { class: "cv-flyout cv-ctx" });
      function row(label, opts) {
        opts = opts || {};
        var b = el("button", { class: "cv-fly" + (opts.danger ? " danger" : "") }, [
          el("span", { class: "i" }),
          el("span", { class: "n" })
        ]);
        b.querySelector(".n").textContent = label;
        b.querySelector(".i").innerHTML = opts.check
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>'
          : "";
        if (opts.check) b.classList.add("chk");
        b.onclick = function () { closeCtxMenu(); opts.run(); };
        node.appendChild(b);
      }
      function sep() { node.appendChild(el("div", { class: "cv-fsep" })); }

      row("Reset chart view", { run: function () { resetZoom(); toast("View reset", "Fits every loaded bar", "", 1500); } });
      row("Copy symbol", { run: function () { copyText(st.symbol, "Symbol copied"); } });
      row("Copy price", { run: function () { copyText(lastPriceStr(), "Price copied"); } });
      sep();
      row("Insert indicator…", { run: openIndicatorDialog });
      sep();
      row("Lock drawings", { check: st.locked, run: toggleLock });
      row("Hide all drawings", { check: st.hideDrawings, run: toggleHidden });
      row("Remove drawings", { danger: true, run: clearDrawings });

      node.style.position = "fixed";
      node.style.left = Math.min(x, window.innerWidth - 210) + "px";
      node.style.top = Math.min(y, window.innerHeight - node.offsetHeight - 8 || y) + "px";
      document.body.appendChild(node);
      var h = node.offsetHeight;
      if (y + h > window.innerHeight - 6) node.style.top = Math.max(6, window.innerHeight - h - 6) + "px";
      var onDoc = function (ev) { if (node.contains(ev.target)) return; closeCtxMenu(); };
      ctxMenu = { node: node, onDoc: onDoc };
      setTimeout(function () {
        document.addEventListener("mousedown", onDoc, true);
        window.addEventListener("blur", closeCtxMenu);
      }, 0);
    }

    function lastPriceStr() {
      if (st.quote && isNum(st.quote.price)) return String(st.quote.price);
      if (data && data.n) return String(data.close[data.n - 1]);
      return "";
    }

    function copyText(s, msg) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s);
        else {
          var ta = el("textarea", { style: "position:fixed;opacity:0" });
          ta.value = s;
          document.body.appendChild(ta); ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        toast(msg, s, "ok", 1600);
      } catch (e) { toast("Copy failed", "", "", 1600); }
    }

    mainWrap.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY);
    });

    /* ---------------------------------------------------- chart events */
    chart.subscribeCrosshairMove(onCrosshair);
    chart.subscribeClick(function (param) {
      if (!alive || !param || !param.point) return;
      scheduleRedraw();
    });
    chart.subscribeDblClick(function (param) {
      if (!alive || st.tool !== "cursor") return;
      /* Double-click a note / text / price label / sticker to retype it. */
      if (param && param.point && !st.locked && !st.hideDrawings) {
        var hit = hitTest(param.point.x, param.point.y);
        if (hit && TEXTY[hit.drawing.tool]) { editText(hit.drawing); return; }
      }
      resetZoom();
      toast("View reset", "Double-click fits all bars again", "", 1500);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
      scheduleRedraw();
      /* Panned past the oldest bar? Pull the next page of history in.
         The settle window keeps LWC's transient clamp right after a swap —
         which reads as a hugely negative `from` — from fetching on its own. */
      if (!replay.on && range && range.from <= -1 && !histEager && Date.now() >= histReadyAt) {
        loadOlderPage(loadSeq).then(function (moved) { if (moved) applyHistorySoon(); });
      }
    });
    chart.timeScale().subscribeSizeChange(function () { scheduleRedraw(); });

    redrawTick = setInterval(function () { if (alive) redrawOverlay(); }, 450);

    /* ------------------------------------------------------------ go */
    buildReplayBar();
    syncControls();
    if (chartTypeBtn) {
      chartTypeBtn.title = "Chart type — " + CHART_TYPES[st.chartType].label;
      chartTypeBtn.classList.toggle("on", st.chartType !== "candles");
    }
    updateClock();
    syncOverlay();
    updateBack();
    renderLegend();
    notifyState();          // the router remembers exactly where we left off
    boot();

    /* --------------------------------------------------------- destroy */
    function destroy() {
      if (!alive) return;
      alive = false;
      closeMenu();
      tfOpen = false;
      document.removeEventListener("mousedown", tfOutside, true);
      document.removeEventListener("keydown", tfEsc, true);
      replayClearTimer();
      clearTimeout(searchTimer);
      clearTimeout(applyTimer);
      clearInterval(redrawTick);
      clearInterval(clockTimer);
      clearInterval(undoTimer);
      clearInterval(fitTick);
      if (redrawRaf) cancelAnimationFrame(redrawRaf);
      closeModal();
      closeFlyout();
      closeCtxMenu();
      try { if (markerApi) markerApi.setMarkers([]); } catch (e) { /* noop */ }
      window.removeEventListener("mousedown", onWinMouseDown, true);
      window.removeEventListener("mousemove", onWinMouseMove, false);
      window.removeEventListener("mouseup", onWinMouseUp, false);
      window.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", resizeHandler);
      document.removeEventListener("click", onDocClick);
      try { chart.remove(); } catch (e) { /* noop */ }
      chart = null;
      if (activeInstance === api2) activeInstance = null;
    }

    var api2 = {
      destroy: destroy,
      get chart() { return chart; },
      get data() { return data; },
      get indicators() { return st.indicators; },
      get drawings() { return st.drawings; },
      get state() { return st; },
      addIndicator: addIndicator,
      removeIndicator: removeIndicator,
      updateIndicator: updateIndicator,
      setTool: setTool,
      zoomIn: function () { zoomBy(1.35); },
      zoomOut: function () { zoomBy(1 / 1.35); },
      resetZoom: resetZoom,
      zoomBy: zoomBy,
      goBack: goBack,
      changeInterval: changeInterval,
      changeLimit: changeLimit,
      goToSymbol: goToSymbol,
      clearDrawings: clearDrawings,
      deleteDrawing: deleteDrawing,
      redraw: redrawOverlay,
      fit: resetZoom
    };
    /* The first layout runs before the flex row has settled, so give the chart
       its real box once everything is in the document — see fitChart. */
    fitChart();
    /* …and keep giving it. Nothing else re-measures the chart when the box
       moves on its own — the header above the chart is still resolving for a
       beat after this, and the panel below it can move without a resize event
       ever reaching us. A stale box is not cosmetic: the chart's own wrapper
       keeps its old height and hangs over the bottom bar, swallowing the
       clicks along its top edge. fitChart de-dupes, so a check is free unless
       the box actually moved. */
    setTimeout(function () {
      if (!alive) return;
      fitChart();
      if (resizeHandler) resizeHandler();
    }, 60);
    var fitTick = setInterval(function () {
      if (!alive || !chart || !chartHost) { clearInterval(fitTick); return; }
      if (fitW === chartHost.clientWidth && fitH === chartHost.clientHeight) return;
      fitChart();
      if (resizeHandler) resizeHandler();
    }, 400);
    activeInstance = api2;
    return destroy;
  }

  /* document-level click for the suggestion dropdown is bound per mount so it
     can be dropped again on teardown — see onDocClick inside mount(). */

  window.ChartView = {
    version: "1.0.0",
    mount: mount,
    pushHistory: pushNav,
    get current() { return activeInstance; },
    get history() { return navStack; },
    studies: function () { return STUDIES.map(function (s) { return { id: s.id, name: s.name, group: s.group, kind: s.kind }; }); },
    /* ---------------------------------------------------- Pine Script ---
       pineCheck only compiles, so the editor can report a bad line without
       disturbing whatever is already on the chart. pineSave registers a
       source under an id (reusing the id keeps an open instance attached
       when a script is edited) and rebuilds any instance already using it. */
    pineCheck: function (src) {
      if (!window.Pine) return { error: "The Pine interpreter is not loaded." };
      var c;
      try { c = window.Pine.compileCached(String(src || "")); }
      catch (e) { return { error: e.message, line: e.pineLine || 0 }; }
      if (!c || c.error) {
        return { error: c ? c.error : "compile failed", line: (c && c.errorLine) || 0 };
      }
      var inputs = [];
      (c.inputs || []).forEach(function (it) {
        inputs.push({ id: it.id, kind: it.kind, title: it.title, dflt: it.dflt,
                      min: it.minval, max: it.maxval, options: it.options });
      });
      return { ok: true, name: c.name, overlay: c.overlay, inputs: inputs };
    },
    pineSave: function (src, id) {
      var res = addPineStudy(src, id);
      if (!res || res.error) return res;
      var api = activeInstance;
      if (api && api.updateIndicator) {
        (api.indicators || []).forEach(function (inst) {
          if (inst.id === res.id) api.updateIndicator(inst.uid, {});
        });
      }
      return res;
    },
    pineAdd: function (src, id) {
      var res = this.pineSave(src, id);
      if (!res || res.error) return res;
      var api = activeInstance;
      if (api && api.addIndicator) api.addIndicator(res.id);
      return res;
    },
    pineList: function () {
      return STUDIES.filter(function (s) { return s.group === PINE_GROUP; })
        .map(function (s) {
          return { id: s.id, name: s.name, kind: s.kind, source: s.source,
                   inputs: (s.fields || []).length };
        });
    },
    pineRemove: function (id) {
      var s = STUDY_MAP[id];
      if (!s || s.group !== PINE_GROUP) return false;
      var api = activeInstance;
      if (api && api.removeIndicator) {
        (api.indicators || []).slice().forEach(function (inst) {
          if (inst.id === id) api.removeIndicator(inst.uid);
        });
      }
      var at = STUDIES.indexOf(s);
      if (at >= 0) STUDIES.splice(at, 1);
      delete STUDY_MAP[id];
      var all = pineScriptsAll();
      delete all[id];
      store(PINE_SCRIPTS_KEY, all);
      /* Push the shrunken map, or the server copy would keep the script and
         hand it back on the next load. */
      pinePushRemote(all);
      return true;
    }
  };
})();
