/* ============================================================================
 * pine.js — a Pine Script interpreter for the chart.
 *
 * This is NOT a lookalike language: scripts are parsed and executed with Pine's
 * real execution model, which is bar-by-bar.  Everything in Pine is a *series*:
 * a value that exists once per bar, and `x[2]` means "x two bars ago".  So the
 * interpreter walks the program once per bar, holding variable state in ring
 * buffers, exactly as TradingView's server-side Pine VM does.
 *
 * Supported (v1) — enough to run real indicator scripts:
 *   //@version=5 | indicator()/strategy() header
 *   var / varip declarations, := reassignment
 *   arithmetic, comparison, logical, ternary, na propagation
 *   if / else if / else (statement and expression form)
 *   for / while loops, break / continue
 *   history references:  close[1], myLine[offset]
 *   data series: open high low close volume hl2 hlc3 ohlc4
 *   bar_index, time, barstate.*, syminfo.*
 *   ta.* (sma ema rma wma swma hma vwma stdev variance atr tr rsi macd stoch
 *         cci mom roc change abschange crossover crossunder cross rising
 *         falling highest lowest highestbars lowestbars barssince sum avg
 *         median mode percentrank mfi obv vwap accdist ad willr wcp cog
 *         slopesqrt slope ema... ),  math.*, str.*, nz(), na(), fixnan()
 *   input.int/float/bool/string/color/source/timeframe
 *   plot, plotshape, plotchar, plotcandle, hline, fill, bgcolor, alert
 *   color.* constants, color.new(), color.rgb(), color.tint()
 *
 * Not supported (and never will be, locally): strategy order execution,
 * request.security() across servers, drawing objects, arrays/tables/maps as
 * first-class containers, methods, user-defined types, and other people's
 * published scripts (Pine only runs on TradingView's servers).
 * ========================================================================= */

window.Pine = (function () {
  "use strict";

  /* ---------------------------------------------------------------- na ---
   * Pine's missing value.  It is a distinct sentinel so that `na` can be
   * told apart from 0 and from a genuine NaN, and so arithmetic on it
   * propagates rather than silently producing a number.
   * ------------------------------------------------------------------------ */
  function Na() {}
  var NA = new Na();
  /* A builtin that hands back its own argument — nz(x), math.abs(x) — returns
   * the *series* it was given, and the call wrapper would then wrap that in a
   * second series. The result is a series holding a series, which no operator
   * sees through: `nz(st) == 1.0` was false on every bar because === compared
   * the inner object to the literal. Unwrap all the way down. */
  function unwrap(v) {
    for (var hops = 0; v && v.__isSeries && hops < 8; hops++) v = v.val;
    return v;
  }
  /* Every na check goes through here so that a Series holding na is treated
   * the same as a bare na. */
  function isNa(v) {
    v = unwrap(v);
    return v === NA || v === null || v === undefined || v === "";
  }
  /* A real number, as opposed to na / a Series / a string. The drawing
   * objects need this: `isNa` alone would let `close` (a Series) through and
   * then Math.round on an object would give NaN silently. */
  function isNum(v) {
    v = unwrap(v);
    return typeof v === "number" && isFinite(v);
  }
  /* Binary ops on na give na — this is what makes Pine scripts robust. */
  function num(v) { return isNa(v) ? NA : v; }

  /* ------------------------------------------------------------- lexer --- */
  var KEYWORDS = {
    if: 1, else: 1, for: 1, while: 1, break: 1, continue: 1, var: 1, varip: 1,
    switch: 1, true: 1, false: 1, na: 1, and: 1, or: 1, not: 1, import: 1,
    export: 1, method: 1, type: 1, as: 1, in: 1, return: 1, to: 1, by: 1
  };
  /* Multi-char operators longest-first, or `>=` would lex as `>` then `=`. */
  var OPS3 = [">=<=", "**="];
  var OPS2 = ["==", "!=", ">=", "<=", "&&", "||", "**", ":=", "+=", "-=", "*=", "/=", "%="];

  function lex(src) {
    var toks = [], i = 0, n = src.length, line = 1, curInd = 0;
    while (i < n) {
      var c = src[i];
      /* Pine is line-based: a newline ends a statement, so it has to be a
       * token rather than whitespace. Without it `x = 1` on one line and
       * `[a, b] = …` on the next lexes as `1[a` — a valid index expression —
       * which silently swallows the following statement. A run of blank lines
       * collapses into a single one.
       *
       * Indentation is recorded on every token as well, because constructs
       * like `switch` have no braces: their case bodies exist only by virtue
       * of being indented further than the case itself. */
      if (c === "\n") {
        line++; i++;
        var ind = 0;
        while (i < n && (src[i] === "\n" || src[i] === " " || src[i] === "\t" || src[i] === "\r")) {
          if (src[i] === "\n") { line++; ind = 0; }
          else if (src[i] === " ") ind++;
          else if (src[i] === "\t") ind += 4;
          i++;
        }
        curInd = ind;
        toks.push({ t: "nl", v: null, line: line, ind: ind });
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      /* comment */
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      /* string */
      if (c === '"' || c === "'") {
        var q = c, s = "", j = i + 1;
        while (j < n && src[j] !== q) {
          if (src[j] === "\\") { s += unescapeChar(src[j + 1]); j += 2; }
          else s += src[j++];
        }
        toks.push({ t: "str", v: s, line: line, ind: curInd }); i = j + 1; continue;
      }
      /* colour literal  #rrggbb  or  #rrggbbaa */
      if (c === "#") {
        var hx = src.substr(i + 1, 8).match(/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?/);
        if (hx) {
          toks.push({ t: "color", v: "#" + hx[0].toUpperCase(), line: line, ind: curInd });
          i += 1 + hx[0].length; continue;
        }
      }
      /* number (incl. 1e-3 and .5) */
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
        var m = src.slice(i).match(/^(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/);
        var txt = m[0];
        toks.push({ t: "num", v: txt.slice(0, 2) === "0x" ? parseInt(txt, 16) : parseFloat(txt), line: line, ind: curInd });
        i += txt.length; continue;
      }
      /* identifier / keyword */
      if (/[A-Za-z_]/.test(c)) {
        var w = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)[0];
        toks.push({ t: KEYWORDS[w] ? "kw" : "id", v: w, line: line, ind: curInd });
        i += w.length; continue;
      }
      /* operator */
      var three = src.substr(i, 3), two = src.substr(i, 2);
      if (OPS3.indexOf(three) !== -1) { toks.push({ t: "op", v: three, line: line, ind: curInd }); i += 3; continue; }
      if (OPS2.indexOf(two) !== -1) { toks.push({ t: "op", v: two, line: line, ind: curInd }); i += 2; continue; }
      /* `;` is only here so the C-style `for (i = 0; i < n; i++)` and
       * `while (…)` forms from v3/v4 scripts reach their parser branches —
       * Pine itself never uses it. It is deliberately absent from CONT, so a
       * `;` never swallows the newline after it. */
      if ("+-*/%<>!=()[]{},.?:;".indexOf(c) !== -1) {
        toks.push({ t: "op", v: c, line: line, ind: curInd }); i++; continue;
      }
      throw err("Unexpected character '" + c + "'", line);
    }
    toks.push({ t: "eof", v: null, line: line, ind: curInd });
    return toks;
  }

  function unescapeChar(c) {
    return c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
  }

  function err(msg, line) {
    var e = new Error("line " + line + ": " + msg);
    e.pineLine = line;
    return e;
  }

  /* ------------------------------------------------------------- parser ---
   * Recursive descent producing a small AST.  Statements carry their own
   * line so a runtime failure can point back at the source line.
   * ------------------------------------------------------------------------ */
  function parse(toks) {
    var p = 0, lastReal = null;
    function peek(k) { return toks[p + (k || 0)]; }
    function at(t, v) { var x = peek(); return x.t === t && (v === undefined || x.v === v); }
    function next() {
      var t = toks[p++];
      if (t.t !== "nl") lastReal = t;
      return t;
    }
    /* Tokens that cannot legally end a line mean the statement carries on
     * past the newline — `plot(close,\n     color=color.red)`. Anything else
     * lets the newline terminate it, which is what keeps `x = 1` from
     * reading the `[a, b]` on the next line as an index into `1`. */
    var CONT = { "+": 1, "-": 1, "*": 1, "/": 1, "%": 1, "**": 1, "<": 1, ">": 1,
                 "<=": 1, ">=": 1, "==": 1, "!=": 1, "&&": 1, "||": 1, "?": 1, ":": 1,
                 ",": 1, "(": 1, "[": 1, "=": 1, ":=": 1, "+=": 1, "-=": 1, "*=": 1,
                 "/=": 1, "%=": 1, ".": 1 };
    function canContinue() {
      var t = lastReal;
      if (!t) return false;
      if (t.t === "op") return CONT[t.v] === 1;
      if (t.t === "kw") return t.v === "and" || t.v === "or" || t.v === "not";
      return false;
    }
    /* Consume newlines only while the line is syntactically unfinished. */
    function skipNl() { while (at("nl") && canContinue()) next(); }
    /* Consume them regardless — used where a statement boundary is known. */
    function skipNlAll() { while (at("nl")) next(); }
    function expect(t, v) {
      skipNlAll();
      if (!at(t, v)) throw err("Expected " + (v || t) + " but found " + String(peek().v), peek().line);
      return next();
    }
    function atOp(v) { return at("op", v); }

    function block() {
      var body = [];
      for (;;) {
        skipNlAll();
        if (at("eof") || at("op", "}")) break;
        body.push(statement());
      }
      return { k: "block", body: body };
    }

    /* `f(a, b) => a + b` — a user-defined function. `plot(close)` opens the
     * same way, so the token stream is scanned past the *matching* parenthesis
     * for `=>` before the parser commits; the cursor only moves once the whole
     * shape is confirmed. */
    function isFuncDef() {
      if (peek().t !== "id" || !(peek(1).t === "op" && peek(1).v === "(")) return false;
      var j = p + 2, depth = 1;
      while (j < toks.length && depth > 0) {
        var tk = toks[j];
        if (tk.t === "op" && tk.v === "(") depth++;
        else if (tk.t === "op" && tk.v === ")") depth--;
        j++;
      }
      if (depth !== 0) return false;
      return toks[j].t === "op" && toks[j].v === "=" &&
             toks[j + 1].t === "op" && toks[j + 1].v === ">";
    }

    /* The annotations Pine permits on a parameter — `color under`,
     * `series float src`, `float[] buf` — are the compiler's own documentation
     * and cost nothing at runtime, so they are read past and dropped. Not
     * dropping them is what made a perfectly valid helper fail with
     * "Expected ) but found under": `color` was taken for the parameter's name.
     * Parameter defaults (`f(len = 14)`) are expressions, not constants. */
    function parseFuncDef() {
      var ln = peek().line, ind = peek().ind;
      var name = expect("id").v;
      expect("op", "(");
      var params = [];
      skipNl();
      if (!atOp(")")) {
        for (;;) {
          skipNl();
          while (at("id") && (peek(1).t === "id" ||
                 (peek(1).t === "op" && peek(1).v === "["))) next();
          if (atOp("[")) { next(); expect("op", "]"); }
          var pn = expect("id").v;
          var pdef = null;
          skipNl();
          if (atOp("=")) { next(); pdef = expr(); }
          params.push({ name: pn, def: pdef });
          skipNl();
          if (!atOp(",")) break;
          next();
        }
      }
      expect("op", ")");
      skipNl();
      if (atOp("=")) { next(); expect("op", ">"); }
      if (atOp(":")) next();
      var body = bodyBlock(ind);
      /* A helper's value is its last expression — `f(a) => a * 2` contains no
       * `return` at all. Rewriting that trailing expression into an explicit
       * one captures it once, at parse time, so it is never evaluated twice:
       * re-reading it at run time would draw a trailing plot() twice. */
      var bs = body && body.k === "block" ? body.body : [body];
      if (bs.length) {
        var lt = bs[bs.length - 1];
        if (lt.k === "exprstat") bs[bs.length - 1] = { k: "return", value: lt.expr, line: lt.line };
      }
      return { k: "fndef", name: name, params: params,
               body: body && body.k === "block" ? { k: "block", body: bs } : bs[0], line: ln };
    }

    function statement() {
      skipNlAll();
      var ln = peek().line;
      if (atOp("{")) { next(); var b = block(); expect("op", "}"); return b; }
      if (at("kw", "var") || at("kw", "varip")) {
        var kind = next().v;
        var decl = { k: "decl", kind: kind, line: ln };
        /* `var float peak = na` — an optional type annotation sits between
         * the keyword and the name. */
        if (at("id") && peek(1).t === "id") next();
        /* `var float[] src = array.new_float(0)` — the annotation carries a
         * size. Arrays are the one part of Pine this engine does not have,
         * so say so in words rather than letting the parser run out of
         * something to say halfway down the line. */
        if (at("id") && peek(1).t === "op" && peek(1).v === "[") {
          throw err("Arrays are not supported by this Pine engine yet — use a series variable instead", ln);
        }
        decl.name = expect("id").v;
        if (atOp("=")) { next(); decl.expr = expr(); }
        else if (atOp(":=")) { throw err(":= on a fresh var — did you mean =?", ln); }
        return decl;
      }
      if (isFuncDef()) return parseFuncDef();
      if (at("kw", "if")) return ifStatement();
      if (at("kw", "for")) return forStatement();
      if (at("kw", "while")) return whileStatement();
      if (at("kw", "break")) { next(); return { k: "break", line: ln }; }
      if (at("kw", "continue")) { next(); return { k: "continue", line: ln }; }
      /* `return` only ever appears inside a function, and its value is the
       * last thing that function produces. A bare `return` is legal, so the
       * expression is optional — but only to the end of the line, or
       * `return\n    x` would swallow the next statement as the value. */
      if (at("kw", "return")) {
        next();
        var rv = null;
        if (!at("nl") && !at("eof") && !atOp("}")) rv = expr();
        return { k: "return", value: rv, line: ln };
      }
      if (at("kw", "switch")) return switchStatement();
      /* Tuple destructuring — `[macdLine, signalLine, hist] = ta.macd(...)`
       * is how every MACD/DMI style script pulls apart a multi-value call.
       * Detected by scanning the token stream ahead, so the cursor only
       * moves once the whole `[a, b] =` shape is confirmed. */
      if (atOp("[")) {
        var j = p + 1, names = [];
        while (toks[j].t === "id") {
          names.push(toks[j].v);
          j++;
          if (toks[j].t === "op" && toks[j].v === ",") { j++; continue; }
          break;
        }
        if (names.length && toks[j].t === "op" && toks[j].v === "]" &&
            toks[j + 1].t === "op" && toks[j + 1].v === "=") {
          p = j + 2;
          return { k: "tupleassign", names: names, value: expr(), line: ln };
        }
      }
      /* expression statement — covers calls like plot(...), and assignments */
      var e = expr();
      if (atOp(":=") || atOp("=") || atOp("+=") || atOp("-=") || atOp("*=") || atOp("/=") || atOp("%=")) {
        var op = next().v, rhs = expr();
        return { k: "assign", op: op, target: e, value: rhs, line: ln };
      }
      return { k: "exprstat", expr: e, line: ln };
    }

    /* An `if` / `for` / `while` body is either one statement on the header
     * line — `if c > 0 plot(close)` — or every line indented past it. Reading
     * only the *first* indented statement silently promoted the rest to top
     * level, where they ran on every bar with no guard whatsoever: a script's
     * second `label.new` fired once per bar instead of once ever, and its
     * second `plot` drew unconditionally. The single-statement form keeps its
     * old shape so the common one-liner compiles to the same tree as before.
     * `ind` is the *header's* indent, never the newline's — a newline's
     * indent belongs to the line after it, so using it would ask for
     * statements deeper than the body itself and collect none. */
    /* The first token after any blank lines, without consuming them. */
    function nextReal(k) {
      var i = k || 0, t;
      while ((t = peek(i)) && t.t === "nl") i++;
      return t;
    }

    function bodyBlock(ind) {
      if (!at("nl") && !at("eof")) return statement();
      /* A brace may sit on the line *after* the header — C-style
       * `if (x)` newline `{`. Measuring indent straight past it would read
       * the block as a stray statement and leave the body orphaned, so look
       * for it first; `statement()` skips the newlines itself. */
      var nx = nextReal(0);
      if (nx && nx.t === "op" && nx.v === "{") return statement();
      var body = statementsDeeperThan(ind, ind);
      return body.length === 1 ? body[0] : { k: "block", body: body };
    }

    function ifStatement() {
      var hd = next(), ln = hd.line;
      var cond = expr();
      var then = bodyBlock(hd.ind), alt = null;
      /* `else` sits on its own line after the then-branch, so the newline
       * before it has to be cleared explicitly. */
      skipNlAll();
      if (at("kw", "else")) {
        /* The `else` keyword's own indent is the reference for its body —
         * the body sits *under* it, one level deeper than the `if`. */
        var eh = next();
        alt = at("kw", "if") ? ifStatement() : bodyBlock(eh.ind);
      }
      return { k: "if", cond: cond, then: then, alt: alt, line: ln };
    }

    /* Pine's loop is `for i = 0 to 4 [by step]`, which counts in whichever
     * direction `by` points. The older C-style `for (i = 0; i < n; i++)`
     * from v3/v4 scripts is still accepted. */
    function forStatement() {
      var fh = next(), ln = fh.line;
      if (atOp("(")) {
        next();
        var name = null, from = null;
        if (at("id")) { name = next().v; expect("op", "="); from = expr(); }
        expect("op", ";");
        var cond = expr();
        expect("op", ";");
        var target = null;
        if (at("id") && name && peek().v === name) {
          next();
          if (atOp("+")) { next(); if (atOp("+")) next(); target = { k: "bin", op: "+", l: { k: "ident", name: name }, r: { k: "num", v: 1 } }; }
          else if (atOp("-")) { next(); if (atOp("-")) next(); target = { k: "bin", op: "-", l: { k: "ident", name: name }, r: { k: "num", v: 1 } }; }
          else target = expr();
        } else target = expr();
        expect("op", ")");
        return { k: "for", name: name, from: from, cond: cond, step: target, body: bodyBlock(fh.ind), line: ln };
      }
      var nm = expect("id").v;
      expect("op", "=");
      var start = expr();
      expect("kw", "to");
      var limit = expr();
      var by = null;
      if (at("kw", "by")) { next(); by = expr(); }
      /* A negative `by` counts down, so the guard has to flip. The step is
       * an *increment*: `by 2` advances i by 2 each pass, so it is folded
       * into an `i + 2` expression rather than being an absolute value. */
      var down = !!(by && by.k === "num" && by.v < 0);
      return {
        k: "for", name: nm, from: start,
        cond: { k: "bin", op: down ? ">=" : "<=", l: { k: "ident", name: nm }, r: limit },
        step: { k: "bin", op: "+", l: { k: "ident", name: nm }, r: by || { k: "num", v: 1 } },
        body: bodyBlock(fh.ind), line: ln
      };
    }

    /* Pine v5 drops the parentheses — `while n < 5.0` followed by an indented
     * body. The older C-style `while (n < 5.0)` is still accepted. */
    function whileStatement() {
      var wh = next(), ln = wh.line;
      var cond;
      if (atOp("(")) { next(); cond = expr(); expect("op", ")"); }
      else cond = expr();
      return { k: "while", cond: cond, body: bodyBlock(wh.ind), line: ln };
    }

    /* Pine's switch has neither parentheses nor braces: cases exist only by
     * being indented under `switch`, a case body only by being indented under
     * its case, and `=>` introduces the default. Without a target the cases
     * are boolean conditions tested in order. */
    function switchStatement() {
      var sw = next();
      var ln = sw.line;
      /* Cases are compared against the `switch` line's own indent. The next
       * token is a newline, whose indent is the *first case's* — using that
       * would break out of the loop before reading a single case. */
      var baseInd = sw.ind;
      var target = null;
      if (!at("nl") && !at("eof")) target = expr();
      if (at("nl")) next();
      var cases = [];
      /* A case's result is either on the same line — `1 => plot(close)`, the
       * form almost every copied script uses — or indented underneath it.
       * Both are valid Pine. */
      function caseBody(ind) {
        if (!at("nl") && !at("eof")) return [statement()];
        return statementsDeeperThan(ind, baseInd);
      }
      for (;;) {
        skipNlAll();
        if (at("eof")) break;
        if (peek().ind <= baseInd) break;
        var caseInd = peek().ind;
        if (atOp("=") && peek(1).v === ">") {
          next(); next();
          if (atOp(":")) next();
          cases.push({ match: null, body: caseBody(caseInd) });
          continue;
        }
        var v = expr();
        if (atOp(":")) next();
        if (atOp("=") && peek(1).v === ">") { next(); next(); if (atOp(":")) next(); }
        cases.push({ match: v, body: caseBody(caseInd) });
      }
      return { k: "switch", target: target, cases: cases, line: ln };
    }

    /* Collect statements for as long as they stay indented past `level`. */
    function statementsDeeperThan(level, base) {
      var out = [];
      for (;;) {
        skipNlAll();
        if (at("eof")) break;
        if (peek().ind <= level || peek().ind <= base) break;
        out.push(statement());
      }
      return out;
    }

    /* ------------------------------------------------ expression grammar
     * precedence (low -> high):
     *   ?:   or   and   == !=   < > <= >=   + -   * / %   unary   **   postfix
     * ------------------------------------------------------------ */
    function expr() { return ternary(); }

    function ternary() {
      var c = orExpr();
      skipNl();
      if (atOp("?")) {
        next(); skipNl();
        var a = expr();
        expect("op", ":");
        var b = expr();
        return { k: "cond3", c: c, a: a, b: b };
      }
      return c;
    }

    function orExpr() {
      var l = andExpr();
      for (;;) { skipNl(); if (!(at("kw", "or") || atOp("||"))) break; next(); skipNl(); l = { k: "bin", op: "or", l: l, r: andExpr() }; }
      return l;
    }
    function andExpr() {
      var l = eqExpr();
      for (;;) { skipNl(); if (!(at("kw", "and") || atOp("&&"))) break; next(); skipNl(); l = { k: "bin", op: "and", l: l, r: eqExpr() }; }
      return l;
    }
    function eqExpr() {
      var l = relExpr();
      for (;;) { skipNl(); if (!(atOp("==") || atOp("!="))) break; var o = next().v; skipNl(); l = { k: "bin", op: o, l: l, r: relExpr() }; }
      return l;
    }
    function relExpr() {
      var l = addExpr();
      for (;;) { skipNl(); if (!(atOp("<") || atOp(">") || atOp("<=") || atOp(">="))) break; var o = next().v; skipNl(); l = { k: "bin", op: o, l: l, r: addExpr() }; }
      return l;
    }
    function addExpr() {
      var l = mulExpr();
      for (;;) { skipNl(); if (!(atOp("+") || atOp("-"))) break; var o = next().v; skipNl(); l = { k: "bin", op: o, l: l, r: mulExpr() }; }
      return l;
    }
    function mulExpr() {
      var l = powExpr();
      for (;;) { skipNl(); if (!(atOp("*") || atOp("/") || atOp("%"))) break; var o = next().v; skipNl(); l = { k: "bin", op: o, l: l, r: powExpr() }; }
      return l;
    }
    function powExpr() {
      var l = unary();
      skipNl();
      if (atOp("**")) { next(); skipNl(); l = { k: "bin", op: "**", l: l, r: powExpr() }; }
      return l;
    }
    function unary() {
      skipNl();
      if (atOp("-")) { next(); return { k: "neg", e: unary() }; }
      if (atOp("+")) { next(); return unary(); }
      if (at("kw", "not")) { next(); return { k: "not", e: unary() }; }
      return postfix();
    }
    /* A call argument is either a plain expression or `name=value`, which is
     * how every plot()/input() option in real scripts is written. */
    function callArg() {
      if (at("id") && !at("kw") && peek(1).t === "op" && peek(1).v === "=") {
        var nm = next().v; next();
        return { k: "named", name: nm, value: expr() };
      }
      return expr();
    }

    function postfix() {
      var e = primary();
      for (;;) {
        skipNl();
        if (atOp("(")) {
          next();
          var args = [];
          skipNl();
          if (!atOp(")")) {
            for (;;) {
              args.push(callArg());
              skipNl();
              if (!atOp(",")) break;
              next();
              skipNl();
            }
          }
          expect("op", ")");
          e = { k: "call", callee: e, args: args, line: peek().line };
        }
        else if (atOp("[")) { next(); skipNl(); var off = expr(); expect("op", "]"); e = { k: "index", obj: e, off: off }; }
        else if (atOp(".")) { next(); var nm = expect("id").v; e = { k: "member", obj: e, name: nm }; }
        else break;
      }
      return e;
    }
    function primary() {
      skipNl();
      var t = peek();
      if (t.t === "nl") throw err("Unexpected end of line — the expression is unfinished", t.line);
      if (t.t === "num") { next(); return { k: "num", v: t.v }; }
      if (t.t === "str") { next(); return { k: "str", v: t.v }; }
      if (t.t === "color") { next(); return { k: "color", v: t.v }; }
      if (t.t === "kw") {
        if (t.v === "true") { next(); return { k: "bool", v: true }; }
        if (t.v === "false") { next(); return { k: "bool", v: false }; }
        if (t.v === "na") { next(); return { k: "na" }; }
        /* `trend = close > open ? 1 : -1` and `x = if c a else b` — the
         * if-expression form is very common in published scripts. */
        if (t.v === "if") {
          next();
          var ic = expr(), ia = expr();
          expect("kw", "else");
          var ib = expr();
          return { k: "ifexpr", c: ic, a: ia, b: ib };
        }
        /* `y = switch x` with `1 => 10` bodies — the value form of switch.
         * Statement-position switch parses through statement(); this is the
         * same shape reached from the right-hand side of an assignment, so it
         * needs an expression node that yields the matched body's value. */
        if (t.v === "switch") {
          var sw = switchStatement();
          return { k: "switchexpr", target: sw.target, cases: sw.cases, line: sw.line };
        }
        throw err("Unexpected keyword '" + t.v + "'", t.line);
      }
      if (t.t === "id") { next(); return { k: "ident", name: t.v }; }
      if (atOp("(")) { next(); var e = expr(); expect("op", ")"); return e; }
      /* `[len, mult] = [20, 2]`, `[ma, up, dn] = ta.bb(...)`, and the tuple a
       * multi-value call hands back. statement() recognises the left-hand
       * shape on its own; this is the right-hand half — without it every
       * script that unpacks a tuple stops at "Unexpected [". */
      if (atOp("[")) {
        next();
        var items = [];
        skipNl();
        if (!atOp("]")) {
          for (;;) {
            items.push(expr());
            skipNl();
            if (!atOp(",")) break;
            next();
            skipNl();
          }
        }
        expect("op", "]");
        return { k: "tuple", items: items };
      }
      throw err("Unexpected " + String(t.v), t.line);
    }

    var prog = [];
    for (;;) {
      skipNlAll();
      if (at("eof")) break;
      prog.push(statement());
    }
    return prog;
  }

  /* =========================================================== builtins ===
   * Each builtin receives (ctx, args) where ctx gives history access.
   * Args are evaluated by the caller, so a builtin that needs a *reference*
   * (ta.crossover(close, ma)) still receives values — that is fine, Pine's
   * ta functions are all value-based too.
   * ======================================================================= */

  /* Rolling-window helpers all share the same contract: the buffer is the
   * series' history, and `length` bars are needed before a value is valid.
   * TV seeds nothing and reports na until the window is full. */
  function window(series, length) {
    /* series is an array already laid out for this bar index */
    var i = series.length - 1;
    var out = [], need = length;
    for (var k = i; k >= 0 && need > 0; k--, need--) out.push(series[k]);
    return need === 0 ? out : null;
  }

  var BUILTINS = {};
  function defB(name, fn) { BUILTINS[name] = fn; }
  /* Builtins that hand back several series at once, for [a, b] = f(...) */
  var TUPLE_BUILTINS = { "ta.macd": 1, "ta.dmi": 1, "ta.kvo": 1 };

  /* ------------------------------------------------------------ ta.* --- */
  defB("ta.sma", function (c, a) { return rolling(a[0], a[1], mean); });
  defB("ta.ema", function (c, a) { return emaSeries(a[0], a[1]); });
  defB("ta.rma", function (c, a) { return rmaSeries(a[0], a[1]); });
  defB("ta.wma", function (c, a) { return rolling(a[0], a[1], wma); });
  defB("ta.swma", function (c, a) { return rolling(a[0], 4, swma); });
  defB("ta.hma", function (c, a) {
    var s = a[0], n = a[1] | 0;
    if (n < 2) return NA;
    var b = c.buf(s);
    if (!b || b.length < n) return NA;
    var half = Math.max(1, Math.round(n / 2));
    var sq = Math.max(1, Math.round(Math.sqrt(n)));
    /* HMA = wma(2*wma(src, n/2) - wma(src, n), sqrt(n)). Both inner WMAs are
     * whole series, so they are computed over the buffer at once — a builtin
     * only sees one bar, which is why the old one-window version never
     * produced a value at all. */
    var b1 = fullWma(b, half), b2 = fullWma(b, n);
    if (!b1 || !b2) return NA;
    var raw = [];
    for (var i = 0; i < b.length; i++) {
      raw.push(isNa(b1[i]) || isNa(b2[i]) ? NA : 2 * b1[i] - b2[i]);
    }
    var hma = fullWma(raw, sq);
    var last = hma.length - 1;
    return hma[last];
  });
  defB("ta.vwma", function (c, a) {
    /* Pine: ta.vwma(source, length). Volume is the bar's own, not an
     * argument — the old signature read it from a[2] and so always had the
     * length where it expected the volume series. */
    var bp = c.buf(a[0]), bv = c.buf(c.volSeries()), n = a[1] | 0;
    if (!bp || !bv || n <= 0) return NA;
    var len = Math.min(bp.length, bv.length);
    if (len < n) return NA;
    var spv = 0, sv = 0;
    for (var i = len - n; i < len; i++) {
      if (isNa(bp[i]) || isNa(bv[i])) return NA;
      spv += bp[i] * bv[i]; sv += bv[i];
    }
    return sv === 0 ? NA : spv / sv;
  });
  defB("ta.stdev", function (c, a) { return rolling(a[0], a[1], stdev); });
  defB("ta.variance", function (c, a) { return rolling(a[0], a[1], variance); });
  defB("ta.dev", function (c, a) {
    var s = rolling(a[0], a[1], mean);
    if (s === NA) return NA;
    return Math.abs(a[0] - s) / s;
  });
  defB("ta.tr", function (c) {
    var h = c.hi(), l = c.lo(), pc = c.prevClose();
    if (isNa(pc)) return h - l;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  /* TR depends on the *previous* close, so the whole range has to be walked.
   * Calling ta.tr() here would hand back one bar's value, and rma has
   * nothing to smooth. */
  defB("ta.atr", function (c, a) {
    var n = a[0] | 0;
    var bh = c.buf(c.hiSeries()), bl = c.buf(c.loSeries()), cl = c.closes();
    if (!bh || !bl || !cl || bh.length < n) return NA;
    var trs = [];
    for (var i = 0; i < bh.length; i++) {
      var pc = i > 0 ? cl[i - 1] : NA;
      trs.push(isNa(pc)
        ? bh[i] - bl[i]
        : Math.max(bh[i] - bl[i], Math.abs(bh[i] - pc), Math.abs(bl[i] - pc)));
    }
    return rmaSeries({ __buf: trs }, n);
  });
  /* The whole ATR series. ta.supertrend walks it bar by bar, so it cannot be
   * built from the one-bar ta.atr. */
  function atrBuf(c) {
    var bh = c.buf(c.hiSeries()), bl = c.buf(c.loSeries()), cl = c.closes();
    if (!bh || !bl || !cl) return null;
    var trs = [];
    for (var i = 0; i < bh.length; i++) {
      var pc = i > 0 ? cl[i - 1] : NA;
      trs.push(isNa(pc)
        ? bh[i] - bl[i]
        : Math.max(bh[i] - bl[i], Math.abs(bh[i] - pc), Math.abs(bl[i] - pc)));
    }
    return trs;
  }
  /* ta.supertrend(factor, period) -> [line, direction], the tuple every
   * copied Supertrend script unpacks. This is Pine's reference: bands trail
   * hl2 by factor*ATR, each band holds the previous bar's value unless the
   * new one is more extreme or price closes through it, and the line is
   * whichever band price is on the far side of. */
  defB("ta.supertrend", function (c, a) {
    var factor = +a[0], n = a[1] | 0;
    var trs = atrBuf(c);
    if (!trs || trs.length < n || !(n > 0)) return [NA, NA];
    var atr = fullRma(trs, n);
    var bh = c.buf(c.hiSeries()), bl = c.buf(c.loSeries()), cl = c.closes();
    var len = bh.length;
    var lowArr = new Array(len), upArr = new Array(len);
    var dir = new Array(len), line = new Array(len);
    for (var i = 0; i < len; i++) {
      if (isNa(atr[i])) { lowArr[i] = NA; upArr[i] = NA; dir[i] = NA; line[i] = NA; continue; }
      var mid = (bh[i] + bl[i]) / 2;
      var upB = mid + factor * atr[i];
      var dnB = mid - factor * atr[i];
      /* nz() of the previous band: the very first bar has nothing to hold. */
      var pL = (i > 0 && !isNa(lowArr[i - 1])) ? lowArr[i - 1] : 0;
      var pU = (i > 0 && !isNa(upArr[i - 1])) ? upArr[i - 1] : 0;
      lowArr[i] = (pL < dnB || cl[i] < pL) ? dnB : pL;
      upArr[i] = (pU > upB || cl[i] > pU) ? upB : pU;
      var d;
      if (i === 0 || isNa(dir[i - 1])) d = 1;
      else if (cl[i] > pU) d = 1;
      else if (cl[i] < pL) d = -1;
      else d = dir[i - 1];
      dir[i] = d;
      line[i] = d === 1 ? lowArr[i] : upArr[i];
    }
    var last = len - 1;
    return [line[last], dir[last]];
  });
  TUPLE_BUILTINS["ta.supertrend"] = 1;
  /* request.security(symbol, timeframe, expression). This engine only holds
   * the chart's own bars, so the expression is evaluated here — which is
   * exactly right for the common `syminfo.tickerid` / current-timeframe case
   * and an approximation for a higher timeframe. */
  defB("request.security", function (c, a) {
    return a.length > 2 ? a[2] : a[1];
  });
  TUPLE_BUILTINS["request.security"] = 1;
  defB("ta.rsi", function (c, a) {
    var s = a[0], n = a[1] | 0;
    var ch = c.prev(s) === NA ? NA : s - c.prev(s);
    var up = c.upSeries, dn = c.dnSeries;
    var upS = rmaSeries(up, n), dnS = rmaSeries(dn, n);
    if (upS === NA || dnS === NA) return NA;
    if (dnS === 0) return 100;
    var rs = upS / dnS;
    return 100 - 100 / (1 + rs);
  });
  /* MACD returns a tuple, so Pine's `[a, b, c] = ta.macd(...)` destructures
   * it. The three series are computed over the whole buffer at once, which
   * also keeps the per-bar cost linear rather than quadratic. */
  defB("ta.macd", function (c, a) {
    var s = a[0], fast = a[1] | 0, slow = a[2] | 0, sig = a[3] | 0;
    var b = c.buf(s);
    if (!b || b.length < slow + sig) return [NA, NA, NA];
    var f = fullEma(b, fast), sl = fullEma(b, slow);
    var m = new Array(b.length);
    for (var i = 0; i < b.length; i++) m[i] = (isNa(f[i]) || isNa(sl[i])) ? NA : f[i] - sl[i];
    var sg = fullEma(m, sig);
    var last = b.length - 1;
    var mv = m[last], sv = sg[last];
    return [mv, sv, (isNa(mv) || isNa(sv)) ? NA : mv - sv];
  });
  /* Straight EMA over a plain array, seeded the way TV does: the simple
   * average of the first `length` values, then the recursion. */
  function fullEma(arr, length) {
    var out = new Array(arr.length), acc = 0, cnt = 0, prev = NA;
    length = nlen(length);
    var alpha = 2 / (length + 1);
    for (var i = 0; i < arr.length; i++) {
      if (isNa(arr[i])) { out[i] = NA; continue; }
      if (cnt < length) { acc += arr[i]; cnt++; if (cnt === length) prev = acc / length; }
      else prev = alpha * arr[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }
  /* WMA/RMA over the whole buffer. ta.hma and ta.supertrend need the whole
   * intermediate series rather than one bar's value, and a builtin only ever
   * sees the current bar. */
  function fullWma(arr, n) {
    n = nlen(n);
    if (!(n > 0)) return null;
    var out = new Array(arr.length), den = n * (n + 1) / 2;
    for (var i = 0; i < arr.length; i++) {
      out[i] = NA;
      if (i < n - 1) continue;
      var s = 0, bad = false;
      for (var k = 0; k < n; k++) {
        var v = arr[i - k];
        if (isNa(v)) { bad = true; break; }
        s += v * (k + 1);
      }
      if (!bad) out[i] = s / den;
    }
    return out;
  }
  function fullRma(arr, n) {
    n = nlen(n);
    var out = new Array(arr.length), acc = 0, cnt = 0, prev = NA;
    for (var i = 0; i < arr.length; i++) {
      if (isNa(arr[i])) { out[i] = NA; continue; }
      if (cnt < n) { acc += arr[i]; cnt++; if (cnt === n) prev = acc / n; }
      else prev = (prev * (n - 1) + arr[i]) / n;
      out[i] = prev;
    }
    return out;
  }
  defB("ta.stoch", function (c, a) {
    var s = a[0], h = a[1], l = a[2], n = a[3] | 0;
    var hh = c.highest(h, n), ll = c.lowest(l, n);
    if (isNa(hh) || isNa(ll) || hh - ll === 0) return NA;
    return 100 * (s - ll) / (hh - ll);
  });
  defB("ta.cci", function (c, a) {
    var n = a[1] | 0;
    var b = c.buf(c.tpSeries());
    if (!b || b.length < n) return NA;
    var m = 0, i;
    for (i = b.length - n; i < b.length; i++) { if (isNa(b[i])) return NA; m += b[i]; }
    m /= n;
    var md = 0;
    for (i = b.length - n; i < b.length; i++) md += Math.abs(b[i] - m);
    md /= n;
    return md === 0 ? 0 : (b[b.length - 1] - m) / (0.015 * md);
  });
  defB("ta.mom", function (c, a) { var p = c.prevN(a[0], a[1] | 0); return isNa(p) ? NA : a[0] - p; });
  /* Pine defaults these lengths to 1. `a[1] | 0` turns a missing argument
   * into 0, which makes ta.change(close) return 0 on every bar rather than
   * the difference — so the default has to be written down, not derived. */
  function lenOr(a, i, dflt) {
    var v = a[i];
    return (v === undefined || v === null || isNa(v)) ? dflt : (v | 0);
  }
  defB("ta.roc", function (c, a) { var p = c.prevN(a[0], lenOr(a, 1, 1)); return (isNa(p) || p === 0) ? NA : 100 * (a[0] - p) / p; });
  defB("ta.change", function (c, a) { var p = c.prevN(a[0], lenOr(a, 1, 1)); return isNa(p) ? NA : a[0] - p; });
  defB("ta.abschange", function (c, a) { var p = c.prevN(a[0], lenOr(a, 1, 1)); return isNa(p) ? NA : Math.abs(a[0] - p); });
  /* `ta.crossover(a, b)` is a crosses *above* b: prev(a) <= prev(b) and now
   * a > b. The comparison lives entirely in crossUp/crossDn — an extra
   * "b is still above a" guard would contradict the crossing itself and
   * make the function return false forever. */
  defB("ta.crossover", function (c, a) { return condPush(c, a[0], a[1], c.crossUp(a[0], a[1])); });
  defB("ta.crossunder", function (c, a) { return condPush(c, a[0], a[1], c.crossDn(a[0], a[1])); });
  defB("ta.cross", function (c, a) { return condPush(c, a[0], a[1], c.crossUp(a[0], a[1]) || c.crossDn(a[0], a[1])); });
  defB("ta.rising", function (c, a) {
    var n = a[1] === undefined ? 1 : a[1] | 0;
    for (var k = 1; k <= n; k++) { var p = c.prevN(a[0], k); if (isNa(p) || isNa(a[0]) || a[0] <= p) return false; }
    return true;
  });
  defB("ta.falling", function (c, a) {
    var n = a[1] === undefined ? 1 : a[1] | 0;
    for (var k = 1; k <= n; k++) { var p = c.prevN(a[0], k); if (isNa(p) || isNa(a[0]) || a[0] >= p) return false; }
    return true;
  });
  defB("ta.highest", function (c, a) {
    var b = c.buf(a[0]);
    if (!b || b.length < a[1]) return NA;
    var m = -Infinity;
    for (var k = Math.max(0, b.length - a[1]); k < b.length; k++) if (b[k] > m) m = b[k];
    return m;
  });
  defB("ta.lowest", function (c, a) {
    var b = c.buf(a[0]);
    if (!b || b.length < a[1]) return NA;
    var m = Infinity;
    for (var k = Math.max(0, b.length - a[1]); k < b.length; k++) if (b[k] < m) m = b[k];
    return m;
  });
  defB("ta.highestbars", function (c, a) {
    var b = c.buf(a[0]);
    if (!b || b.length < a[1]) return NA;
    var best = -Infinity, at = 0;
    for (var k = b.length - 1, cnt = 0; k >= 0 && cnt < a[1]; k--, cnt++) if (b[k] > best) { best = b[k]; at = cnt; }
    return -at;
  });
  defB("ta.lowestbars", function (c, a) {
    var b = c.buf(a[0]);
    if (!b || b.length < a[1]) return NA;
    var best = Infinity, at = 0;
    for (var k = b.length - 1, cnt = 0; k >= 0 && cnt < a[1]; k--, cnt++) if (b[k] < best) { best = b[k]; at = cnt; }
    return -at;
  });
  /* A condition arrives either as a series of booleans or as the single
   * boolean the current bar produced — `ta.barssince(ta.crossover(a, b))` is
   * the second kind, and the crossover keeps its own history for it. */
  function condHistory(c, v) {
    if (v && v.__isSeries) return c.buf(v);
    var b = c.lastCondBuf();
    return b && b.length ? b : null;
  }
  defB("ta.barssince", function (c, a) {
    /* Pine counts back from the current bar whether or not today qualifies:
     * true today is 0, and a condition that has never held is na. Returning
     * na whenever the current bar is false — the obvious reading — left the
     * plot empty on every chart where the signal was not on the last bar. */
    var b = condHistory(c, a[0]);
    if (!b || !b.length) return NA;
    for (var i = 1; i <= b.length; i++) {
      if (b[b.length - i] === true) return i - 1;
    }
    return NA;
  });
  defB("ta.count", function (c, a) {
    var b = c.buf(a[0]), n = a[1] | 0;
    if (!b) return NA;
    var t = 0;
    for (var k = Math.max(0, b.length - n); k < b.length; k++) if (!isNa(b[k])) t++;
    return t;
  });
  defB("ta.sum", function (c, a) { return rolling(a[0], a[1], sum); });
  defB("ta.avg", function (c, a) { return rolling(a[0], a[1], mean); });
  defB("ta.median", function (c, a) {
    var w = windowBuf(a[0], a[1]);
    if (!w) return NA;
    var s = w.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  });
  defB("ta.mode", function (c, a) {
    var w = windowBuf(a[0], a[1]);
    if (!w) return NA;
    var t = {}, best = NA, bc = 0;
    for (var k = 0; k < w.length; k++) { var kk = String(w[k]); t[kk] = (t[kk] || 0) + 1; if (t[kk] > bc) { bc = t[kk]; best = w[k]; } }
    return best;
  });
  defB("ta.percentrank", function (c, a) {
    var w = windowBuf(a[0], a[1]);
    if (!w) return NA;
    var below = 0;
    for (var k = 0; k < w.length; k++) if (w[k] < a[0]) below++;
    return 100 * below / w.length;
  });
  defB("ta.mfi", function (c, a) {
    var n = a[0] | 0;
    var bt = c.buf(c.tpSeries()), bv = c.buf(c.volSeries());
    if (!bt || !bv) return NA;
    var len = Math.min(bt.length, bv.length);
    if (len < n + 1) return NA;
    var up = 0, dn = 0;
    for (var i = len - n; i < len; i++) {
      if (isNa(bt[i]) || isNa(bt[i - 1])) return NA;
      var d = bt[i] * bv[i] - bt[i - 1] * bv[i - 1];
      if (d > 0) up += d; else dn -= d;
    }
    return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  });
  defB("ta.obv", function (c) {
    var b = c.seriesStore["__obv"];
    var ch = c.prevClose();
    var prev = b && b.length > 1 ? b[b.length - 2] : 0;
    if (isNa(ch)) return 0;
    var d = c.close() - ch;
    return prev + (d > 0 ? c.vol() : d < 0 ? -c.vol() : 0);
  });
  defB("ta.vwap", function (c) {
    var b = c.seriesStore["__vwap"];
    if (!b || b.length === 0) return NA;
    return b[b.length - 1];
  });
  defB("ta.accdist", function (c) {
    var b = c.seriesStore["__ad"];
    return b && b.length ? b[b.length - 1] : NA;
  });
  defB("ta.ad", BUILTINS["ta.accdist"]);
  defB("ta.willr", function (c, a) {
    var hh = c.highest(c.hiSeries(), a[0] | 0), ll = c.lowest(c.loSeries(), a[0] | 0);
    if (hh === NA || ll === NA || hh === ll) return NA;
    return -100 * (hh - c.close()) / (hh - ll);
  });
  defB("ta.wcp", function (c, a) {
    var n = a[0] | 0;
    var cl = c.closes();
    if (!cl || cl.length < n) return NA;
    var s = 0;
    for (var i = cl.length - n; i < cl.length; i++) { if (isNa(cl[i])) return NA; s += cl[i]; }
    return (cl[cl.length - 1] * n - s) / n;
  });
  defB("ta.cog", function (c, a) {
    /* Pine: ta.cog(source, length). The old order read the length from the
       source slot, so every call returned na. */
    var s = a[0], n = a[1] | 0;
    var b = c.buf(s);
    if (!b || b.length < n) return NA;
    var st = 0, m = 0;
    for (var k = 0; k < n; k++) { var v = b[b.length - n + k]; if (isNa(v)) return NA; st += v * (n - k); m += v; }
    return m === 0 ? NA : st / m;
  });
  defB("ta.slopesqrt", function (c, a) {
    var n = a[1] | 0;
    var m = emaSeries(a[0], n);
    return m === NA ? NA : m * m;
  });
  defB("ta.slope", function (c, a) {
    var n = a[1] | 0, s = a[0];
    var b = c.buf(s);
    if (!b || b.length < n) return NA;
    var sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var k = 0; k < n; k++) { var x = k, y = b[b.length - n + k]; sx += x; sy += y; sxy += x * y; sxx += x * x; }
    var d = n * sxx - sx * sx;
    return d === 0 ? NA : (n * sxy - sx * sy) / d;
  });

  /* ------------------------------------------------- more ta.* --- */
  /* `ta.valuewhen(cond, source, occurrence)` — source's value on the most
   * recent bar where cond held. Both sides are walked back together so they
   * stay aligned even though only the condition decides the length. */
  defB("ta.valuewhen", function (c, a) {
    var cb = condHistory(c, a[0]), sb = c.buf(a[1]);
    if (!cb || !sb) return NA;
    var occ = a[2] === undefined ? 0 : a[2] | 0;
    /* The condition log and the source series both grow once per bar, so the
       last `n` entries of each line up bar for bar. */
    var n = Math.min(cb.length, sb.length), seen = 0;
    for (var i = 1; i <= n; i++) {
      if (cb[cb.length - i] === true) {
        if (seen === occ) return sb[sb.length - i];
        seen++;
      }
    }
    return NA;
  });
  defB("ta.cum", function (c, a) {
    var b = c.buf(a[0]);
    if (!b || !b.length) return NA;
    var s = 0;
    for (var i = 0; i < b.length; i++) { if (isNa(b[i])) return NA; s += b[i]; }
    return s;
  });
  /* Pivots only confirm once `rightbars` further bars have printed, which is
   * why they are na until then — a pivot that could still be beaten by the
   * next bar is not a pivot. */
  defB("ta.pivothigh", function (c, a) {
    var b = c.buf(a[0]), l = a[1] | 0, r = a[2] === undefined ? 1 : a[2] | 0;
    if (!b || b.length < l + r + 1) return NA;
    var p = b.length - 1 - r, v = b[p];
    if (isNa(v)) return NA;
    for (var i = p - l; i <= p + l; i++) if (i !== p && !isNa(b[i]) && b[i] >= v) return NA;
    return v;
  });
  defB("ta.pivotlow", function (c, a) {
    var b = c.buf(a[0]), l = a[1] | 0, r = a[2] === undefined ? 1 : a[2] | 0;
    if (!b || b.length < l + r + 1) return NA;
    var p = b.length - 1 - r, v = b[p];
    if (isNa(v)) return NA;
    for (var i = p - l; i <= p + l; i++) if (i !== p && !isNa(b[i]) && b[i] <= v) return NA;
    return v;
  });
  /* Bollinger. The middle band *is* the SMA, so it delegates rather than
   * restating the maths and drifting away from ta.sma. */
  defB("ta.bbmiddleband", function (c, a) { return BUILTINS["ta.sma"](c, [a[0], a[1]]); });
  defB("ta.bbupper", function (c, a) {
    var b = BUILTINS["ta.sma"](c, [a[0], a[1]]), s = BUILTINS["ta.stdev"](c, [a[0], a[1]]);
    if (isNa(b) || isNa(s)) return NA;
    return b + (a[2] === undefined ? 2 : a[2]) * s;
  });
  defB("ta.bblower", function (c, a) {
    var b = BUILTINS["ta.sma"](c, [a[0], a[1]]), s = BUILTINS["ta.stdev"](c, [a[0], a[1]]);
    if (isNa(b) || isNa(s)) return NA;
    return b - (a[2] === undefined ? 2 : a[2]) * s;
  });
  TUPLE_BUILTINS["ta.bb"] = 1;
  defB("ta.bb", function (c, a) {
    var b = BUILTINS["ta.sma"](c, [a[0], a[1]]), s = BUILTINS["ta.stdev"](c, [a[0], a[1]]);
    var m = a[2] === undefined ? 2 : a[2];
    if (isNa(b) || isNa(s)) return [NA, NA, NA];
    return [b - m * s, b, b + m * s];
  });
  defB("ta.cmo", function (c, a) {
    var n = a[1] | 0, b = c.buf(a[0]);
    if (!b || b.length < n + 1) return NA;
    var up = 0, dn = 0;
    for (var i = b.length - n; i < b.length; i++) {
      if (isNa(b[i]) || isNa(b[i - 1])) return NA;
      var d = b[i] - b[i - 1];
      if (d > 0) up += d; else if (d < 0) dn -= d;
    }
    return (up + dn) === 0 ? NA : 100 * (up - dn) / (up + dn);
  });
  defB("ta.percentile", function (c, a) { return percentileOf(c, a, false); });
  defB("ta.percentile_linear_interpolation", function (c, a) { return percentileOf(c, a, false); });
  defB("ta.percentile_nearest_rank", function (c, a) { return percentileOf(c, a, true); });
  function percentileOf(c, a, nearest) {
    var b = c.buf(a[0]), n = a[1] | 0, pct = a[2];
    if (!b || b.length < n) return NA;
    var w = [];
    for (var i = b.length - n; i < b.length; i++) if (!isNa(b[i])) w.push(b[i]);
    if (!w.length) return NA;
    w.sort(function (x, y) { return x - y; });
    if (nearest) {
      var rank = Math.max(1, Math.ceil((pct / 100) * w.length));
      return w[Math.min(w.length, rank) - 1];
    }
    if (w.length === 1) return w[0];
    var pos = (pct / 100) * (w.length - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    return w[lo] + (w[hi] - w[lo]) * (pos - lo);
  }
  /* DMI/ADX is a chain of RMA's — there is no single-bar form, so the whole
   * range is walked each time. O(bars) per bar stays cheap at the sizes this
   * chart pages back. */
  function dmiCompute(c, n, ns) {
    var rt = c.rt, nb = rt.bar + 1;
    if (nb <= n) return null;
    var eTr = 0, eP = 0, eN = 0, dxs = [], diP = 0, diN = 0, adx = NA;
    for (var k = 1; k < nb; k++) {
      var h = rt.highs[k], l = rt.lows[k], ph = rt.highs[k - 1], pl = rt.lows[k - 1], pc = rt.closes[k - 1];
      var up = h - ph, dn = pl - l;
      var p = (up > dn && up > 0) ? up : 0;
      var q = (dn > up && dn > 0) ? dn : 0;
      var t = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      if (k <= n) {
        eTr += t; eP += p; eN += q;
      } else {
        eTr = eTr - eTr / n + t; eP = eP - eP / n + p; eN = eN - eN / n + q;
      }
      if (k >= n) {
        diP = eTr === 0 ? 0 : 100 * eP / eTr;
        diN = eTr === 0 ? 0 : 100 * eN / eTr;
        var sum = diP + diN;
        dxs.push(sum === 0 ? 0 : 100 * Math.abs(diP - diN) / sum);
        if (dxs.length >= ns) {
          var acc = 0;
          for (var m = dxs.length - ns; m < dxs.length; m++) acc += dxs[m];
          adx = acc / ns;
        }
      }
    }
    return { diP: diP, diN: diN, adx: adx };
  }
  TUPLE_BUILTINS["ta.dmi"] = 1;
  defB("ta.dmi", function (c, a) {
    var r = dmiCompute(c, Math.max(1, a[0] | 0), Math.max(1, a[1] | 0));
    return r ? [r.diP, r.diN, r.adx] : [NA, NA, NA];
  });
  defB("ta.adx", function (c, a) {
    var r = dmiCompute(c, Math.max(1, a[0] | 0), Math.max(1, a[1] | 0));
    return r ? r.adx : NA;
  });
  defB("ta.correlation", function (c, a) { return correlationOf(c, a, true); });
  defB("ta.covariance", function (c, a) { return correlationOf(c, a, false); });
  function correlationOf(c, a, normalised) {
    var x = c.buf(a[0]), y = c.buf(a[1]), n = a[2] | 0;
    if (!x || !y || x.length < n || y.length < n || n < 2) return NA;
    var sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
    for (var k = 0; k < n; k++) {
      var u = x[x.length - n + k], v = y[y.length - n + k];
      if (isNa(u) || isNa(v)) return NA;
      sx += u; sy += v; sxy += u * v; sxx += u * u; syy += v * v;
    }
    if (!normalised) return (sxy - sx * sy / n) / n;
    var d = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    return d === 0 ? NA : (n * sxy - sx * sy) / d;
  }
  /* Least-squares regression over the last `length` bars. ta.linreg returns
   * the fitted value at `offset` bars back, which is why a Linear Regression
   * Channel plots it directly rather than through a separate fit. */
  function linregFit(s, length, offset) {
    var b = s && s.__isSeries ? s.__buf : null;
    if (!b) return { v: NA };
    length = Math.max(2, length | 0);
    offset = offset | 0;
    if (b.length < length) return { v: NA };
    var start = b.length - length - offset;
    if (start < 0) return { v: NA };
    var sx = 0, sy = 0, sxy = 0, sxx = 0, i, x, y;
    for (i = 0; i < length; i++) {
      y = b[start + i];
      if (isNa(y)) return { v: NA };
      x = i - (length - 1) / 2;
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    var den = length * sxx - sx * sx;
    if (den === 0) return { v: NA };
    var slope = (length * sxy - sx * sy) / den;
    var intercept = (sy - slope * sx) / length;
    /* The regression line runs through the mean, so the fitted value at bar
     * index (length-1-offset) is intercept + slope * its centred x. */
    var xc = (length - 1 - offset) - (length - 1) / 2;
    var fitted = intercept + slope * xc;
    var actual = b[b.length - 1 - offset];
    return { v: fitted, slope: slope, intercept: intercept, err: isNa(actual) ? NA : actual - fitted };
  }
  defB("ta.linreg", function (c, a) { return linregFit(a[0], a[1], a[2]).v; });
  defB("ta.linregcorrection", function (c, a) { return linregFit(a[0], a[1], a[2]).err; });
  defB("ta.linregslope", function (c, a) { return linregFit(a[0], a[1], 0).slope; });
  defB("ta.rSquared", function (c, a) {
    var r = correlationOf(c, a, true);
    return isNa(r) ? NA : r * r;
  });
  /* Normalised ATR — percentage rather than price, so it compares across
   * symbols. */
  defB("ta.natr", function (c, a) {
    var atr = BUILTINS["ta.atr"](c, a);
    var cl = c.close();
    return isNa(atr) || isNa(cl) || cl === 0 ? NA : 100 * atr / cl;
  });
  /* How many consecutive bars the series has risen / fallen. */
  defB("ta.rise", function (c, a) {
    var b = c.buf(a[0]), n = Math.max(1, a[1] | 0);
    if (!b || b.length < n + 1) return false;
    for (var k = 0; k < n; k++) {
      var i = b.length - 1 - k;
      if (isNa(b[i]) || isNa(b[i - 1]) || !(b[i] > b[i - 1])) return false;
    }
    return true;
  });
  defB("ta.fall", function (c, a) {
    var b = c.buf(a[0]), n = Math.max(1, a[1] | 0);
    if (!b || b.length < n + 1) return false;
    for (var k = 0; k < n; k++) {
      var i = b.length - 1 - k;
      if (isNa(b[i]) || isNa(b[i - 1]) || !(b[i] < b[i - 1])) return false;
    }
    return true;
  });
  /* Volume-weighted HMA — HMA of the volume series. */
  defB("ta.vhma", function (c, a) { return BUILTINS["ta.hma"](c, [c.volSeries(), a[0]]); });
  /* Williams Accumulation/Distribution. */
  defB("ta.wad", function (c) {
    var b = c.rt && c.rt.seriesStore ? c.rt.seriesStore["__ad"] : null;
    return b && b.length ? b[b.length - 1] : NA;
  });
  /* Ichimoku's five lines, the tuple every Ichimoku script unpacks. */
  defB("ta.ichimoku", function (c, a) {
    var conv = a[0] | 0, base = a[1] | 0, lead = a[2] | 0;
    var bh = c.buf(c.hiSeries()), bl = c.buf(c.loSeries()), cl = c.closes();
    if (!bh || !bl) return [NA, NA, NA, NA, NA];
    function mid(n) {
      if (n < 1 || bh.length < n) return NA;
      var hh = -Infinity, ll = Infinity;
      for (var i = bh.length - n; i < bh.length; i++) {
        if (bh[i] > hh) hh = bh[i];
        if (bl[i] < ll) ll = bl[i];
      }
      return (hh + ll) / 2;
    }
    var tenkan = mid(conv), kijun = mid(base);
    var senkouA = isNa(tenkan) || isNa(kijun) ? NA : (tenkan + kijun) / 2;
    var span = lead > 1 ? (function () {
      if (bh.length < base * 2) return NA;
      var hh = -Infinity, ll = Infinity;
      for (var i = bh.length - base * 2; i < bh.length; i++) {
        if (bh[i] > hh) hh = bh[i];
        if (bl[i] < ll) ll = bl[i];
      }
      return (hh + ll) / 2;
    })() : NA;
    var last = bh.length - 1;
    var chikou = last >= base ? cl[last - base] : NA;
    return [senkouA, span, tenkan, kijun, chikou];
  });
  TUPLE_BUILTINS["ta.ichimoku"] = 1;
  /* Klinger Volume Oscillator — [kvo, signal]. Trend flips on close vs the
   * previous close, the accumulation counter carries the raw range while the
   * trend holds and resets when it flips, and the force index is smoothed
   * into the two lines. */
  defB("ta.kvo", function (c, a) {
    /* Pine: ta.kvo(source, fastLength, slowLength, signal) */
    var fast = a[1] | 0, slow = a[2] | 0, sig = a[3] | 0;
    var bh = c.buf(c.hiSeries()), bl = c.buf(c.loSeries()), cl = c.closes(), bv = c.buf(c.volSeries());
    if (!bh || !bl || !cl || !bv) return [NA, NA];
    var n = bh.length, force = new Array(n), prevTrend = 0, cm = 0;
    for (var i = 0; i < n; i++) {
      var trend = i === 0 ? 0 : (cl[i] > cl[i - 1] ? 1 : cl[i] < cl[i - 1] ? -1 : prevTrend);
      var dm = bh[i] - bl[i];
      cm = (i > 0 && trend === prevTrend) ? cm + dm : dm;
      prevTrend = trend;
      force[i] = (cm === 0 || isNa(dm)) ? NA
        : bv[i] * (2 * (dm / cm) - 1) * trend;
    }
    var f = fullEma(force, fast), s = fullEma(force, slow);
    var line = new Array(n);
    for (var j = 0; j < n; j++) line[j] = (isNa(f[j]) || isNa(s[j])) ? NA : f[j] - s[j];
    var sg = fullEma(line, sig);
    var last = n - 1;
    return [line[last], sg[last]];
  });

  /* ----------------------------------------------------------- math.* --- */
  defB("math.abs", function (c, a) { return isNa(a[0]) ? NA : Math.abs(a[0]); });
  defB("math.max", function (c, a) { return anyNa(a) ? NA : Math.max.apply(null, a); });
  defB("math.min", function (c, a) { return anyNa(a) ? NA : Math.min.apply(null, a); });
  defB("math.round", function (c, a) { return isNa(a[0]) ? NA : Math.round(a[0]); });
  defB("math.roundtozero", function (c, a) { return isNa(a[0]) ? NA : a[0] < 0 ? Math.ceil(a[0]) : Math.floor(a[0]); });
  defB("math.floor", function (c, a) { return isNa(a[0]) ? NA : Math.floor(a[0]); });
  defB("math.ceil", function (c, a) { return isNa(a[0]) ? NA : Math.ceil(a[0]); });
  defB("math.sign", function (c, a) { return isNa(a[0]) ? NA : a[0] > 0 ? 1 : a[0] < 0 ? -1 : 0; });
  defB("math.pow", function (c, a) { return anyNa(a) ? NA : Math.pow(a[0], a[1]); });
  defB("math.sqrt", function (c, a) { return isNa(a[0]) ? NA : Math.sqrt(a[0]); });
  defB("math.log", function (c, a) { return isNa(a[0]) ? NA : Math.log(a[0]); });
  defB("math.log10", function (c, a) { return isNa(a[0]) ? NA : Math.log(a[0]) / Math.LN10; });
  defB("math.exp", function (c, a) { return isNa(a[0]) ? NA : Math.exp(a[0]); });
  defB("math.sin", function (c, a) { return isNa(a[0]) ? NA : Math.sin(a[0]); });
  defB("math.cos", function (c, a) { return isNa(a[0]) ? NA : Math.cos(a[0]); });
  defB("math.tan", function (c, a) { return isNa(a[0]) ? NA : Math.tan(a[0]); });
  defB("math.atan", function (c, a) { return isNa(a[0]) ? NA : Math.atan(a[0]); });
  defB("math.todegrees", function (c, a) { return isNa(a[0]) ? NA : a[0] * 180 / Math.PI; });
  defB("math.toradians", function (c, a) { return isNa(a[0]) ? NA : a[0] * Math.PI / 180; });
  defB("math.sum", function (c, a) { return rolling(a[0], a[1], sum); });
  defB("math.avg", function (c, a) { return rolling(a[0], a[1], mean); });
  defB("math.median", function (c, a) { return BUILTINS["ta.median"](c, a); });
  defB("math.mode", function (c, a) { return BUILTINS["ta.mode"](c, a); });
  defB("math.variance", function (c, a) { return rolling(a[0], a[1], variance); });
  defB("math.stdev", function (c, a) { return rolling(a[0], a[1], stdev); });
  defB("math.acos", function (c, a) { return isNa(a[0]) ? NA : Math.acos(a[0]); });
  defB("math.asin", function (c, a) { return isNa(a[0]) ? NA : Math.asin(a[0]); });
  defB("math.atan2", function (c, a) { return anyNa(a) ? NA : Math.atan2(a[0], a[1]); });
  defB("math.cbrt", function (c, a) { return isNa(a[0]) ? NA : Math.cbrt(a[0]); });
  defB("math.trunc", function (c, a) { return isNa(a[0]) ? NA : Math.trunc(a[0]); });
  defB("math.rem", function (c, a) { return anyNa(a) || a[1] === 0 ? NA : a[0] % a[1]; });
  defB("math.round_to_multiplication", function (c, a) {
    return anyNa(a) || a[1] === 0 ? NA : Math.round(a[0] / a[1]) * a[1];
  });
  /* `math.log(x)` is natural; `math.log(x, base)` switches base. */
  defB("math.log", function (c, a) {
    if (isNa(a[0])) return NA;
    var r = Math.log(a[0]);
    return a.length > 1 && !isNa(a[1]) && a[1] > 0 && a[1] !== Math.E ? r / Math.log(a[1]) : r;
  });

  /* --------------------------------------------------------- global --- */
  defB("nz", function (c, a) { return isNa(a[0]) ? (a.length > 1 ? a[1] : 0) : a[0]; });
  defB("na", function (c, a) { return isNa(a[0]); });
  defB("fixnan", function (c, a) {
    var b = c.buf(a[0]);
    if (!b) return NA;
    for (var k = b.length - 1; k >= 0; k--) if (!isNa(b[k])) return b[k];
    return NA;
  });
  defB("tostring", function (c, a) { return isNa(a[0]) ? "NaN" : String(a[0]); });
  defB("color.new", function (c, a) {
    var col = parseColor(a[0]);
    var trans = a[1] === undefined ? 0 : a[1];
    col.a = Math.max(0, Math.min(100, 100 - trans)) / 100;
    return col;
  });
  defB("color.rgb", function (c, a) { return { r: a[0] | 0, g: a[1] | 0, b: a[2] | 0, a: a[3] === undefined ? 1 : (100 - a[3]) / 100 }; });
  defB("color.tint", function (c, a) {
    var col = parseColor(a[0]);
    var t = (a[1] === undefined ? 0 : a[1]) / 100;
    return { r: col.r + (255 - col.r) * t, g: col.g + (255 - col.g) * t, b: col.b + (255 - col.b) * t, a: col.a };
  });
  /* The four component accessors. `color.t` is transparency 0..100 — the
   * inverse of the alpha colour.new() stores — and is what a blending helper
   * needs to composite two translucent colours the way a canvas would. */
  function colorComp(a, key) {
    var v = parseColor(a[0]);
    return v && v[key] !== undefined ? v[key] : NA;
  }
  defB("color.r", function (c, a) { return colorComp(a, "r"); });
  defB("color.g", function (c, a) { return colorComp(a, "g"); });
  defB("color.b", function (c, a) { return colorComp(a, "b"); });
  defB("color.t", function (c, a) {
    var v = parseColor(a[0]);
    if (!v) return NA;
    var alpha = v.a === undefined ? 1 : v.a;
    /* Rounded so 30% transparency comes back as 30 rather than 29.99999…,
     * which a script that divides it back out would carry all the way to the
     * plotted colour. */
    return Math.round((1 - alpha) * 10000) / 100;
  });
  defB("str.tostring", function (c, a) { return String(a[0]); });
  defB("str.concat", function (c, a) { return a.map(function (x) { return String(x); }).join(""); });
  defB("str.format", function (c, a) {
    var s = String(a[0]);
    var rest = a.slice(1), k = 0;
    return s.replace(/\{([^}]*)\}/g, function (_, spec) {
      var v = rest[k++];
      if (spec.indexOf(".") !== -1 && typeof v === "number") {
        var dp = parseInt(spec.split(".")[1], 10);
        return v.toFixed(isNaN(dp) ? 2 : dp);
      }
      return String(v);
    });
  });
  defB("str.length", function (c, a) { return String(a[0]).length; });
  defB("str.toupper", function (c, a) { return String(a[0]).toUpperCase(); });
  defB("str.tolower", function (c, a) { return String(a[0]).toLowerCase(); });
  defB("str.tonumber", function (c, a) {
    var s = String(a[0]).trim();
    if (s === "") return NA;
    var n = Number(s);
    return isFinite(n) ? n : NA;
  });
  defB("str.replace", function (c, a) { return String(a[0]).split(String(a[1])).join(String(a[2])); });
  defB("str.substring", function (c, a) {
    var s = String(a[0]), from = a[1] | 0;
    var to = a.length > 2 && a[2] !== undefined ? a[2] | 0 : s.length;
    return s.substring(Math.max(0, from), Math.max(0, to));
  });
  defB("str.slice", function (c, a) {
    var s = String(a[0]);
    var from = a[1] | 0, to = a.length > 2 && a[2] !== undefined ? a[2] | 0 : s.length;
    return s.slice(from < 0 ? Math.max(0, s.length + from) : from, to);
  });
  defB("str.contains", function (c, a) { return String(a[0]).indexOf(String(a[1])) !== -1; });
  defB("str.startswith", function (c, a) { return String(a[0]).indexOf(String(a[1])) === 0; });
  defB("str.endswith", function (c, a) {
    var s = String(a[0]), x = String(a[1]);
    return s.length >= x.length && s.lastIndexOf(x) === s.length - x.length;
  });
  defB("str.indexof", function (c, a) { return String(a[0]).indexOf(String(a[1])); });
  defB("str.lastindexof", function (c, a) { return String(a[0]).lastIndexOf(String(a[1])); });
  defB("str.repeat", function (c, a) { return String(a[0]).repeat(Math.max(0, a[1] | 0)); });
  defB("str.reverse", function (c, a) { return String(a[0]).split("").reverse().join(""); });
  defB("str.padleft", function (c, a) {
    var s = String(a[0]), n = a[1] | 0, f = a.length > 2 ? String(a[2]) : " ";
    if (f.length === 0) f = " ";
    while (s.length < n) s = f[0] + s;
    return s;
  });
  defB("str.padright", function (c, a) {
    var s = String(a[0]), n = a[1] | 0, f = a.length > 2 ? String(a[2]) : " ";
    if (f.length === 0) f = " ";
    while (s.length < n) s = s + f[0];
    return s;
  });

  /* --------------------------------------------------------- helpers --- */
  function anyNa(a) { for (var i = 0; i < a.length; i++) if (isNa(a[i])) return true; return false; }
  function toBool(v) {
    v = unwrap(v);
    return isNa(v) ? false : !!v;
  }
  function windowBuf(series, length) {
    if (isNa(series) || isNa(length) || length <= 0) return null;
    var b = series.__buf;
    if (!b || b.length < length) return null;
    return b.slice(b.length - length);
  }
  /* A length arrives either as a plain number or as a Series — `ta.ema(close,
   * len)` is written against a variable in almost every real script, and a
   * variable is a Series here. Series has a valueOf, so unary + unwraps it;
   * everything below compares lengths with ===/<< and would otherwise see an
   * object and quietly produce NaN instead of an error. */
  function nlen(v) { return +v; }
  /* Rolling statistics read the *value's own history buffer*, which the
   * runtime maintains for every series variable. */
  function rolling(series, length, fn) {
    var w = windowBuf(series, nlen(length));
    return w ? fn(w) : NA;
  }
  function rollingSumWindow(series, length) {
    var w = windowBuf(series, length);
    return w ? w.reduce(function (a, b) { return a + (isNa(b) ? 0 : b); }, 0) : null;
  }
  function sum(w) { var s = 0; for (var i = 0; i < w.length; i++) s += w[i]; return s; }
  function mean(w) { return sum(w) / w.length; }
  function variance(w) {
    var m = mean(w), s = 0;
    for (var i = 0; i < w.length; i++) { var d = w[i] - m; s += d * d; }
    return s / w.length;
  }
  function stdev(w) { return Math.sqrt(variance(w)); }
  function wma(w) {
    var n = w.length, den = n * (n + 1) / 2, s = 0;
    for (var i = 0; i < n; i++) s += w[i] * (i + 1);
    return s / den;
  }
  function swma(w) { return (w[0] + 2 * w[1] + 2 * w[2] + w[3]) / 6; }

  /* EMA/RMA need the whole series, not a window — Pine computes them
   * iteratively so that the seed is the simple average of the first
   * `length` values, exactly like TV. */
  function emaSeries(series, length) {
    var b = series && series.__buf;
    length = nlen(length);
    if (!b || !(length > 0)) return NA;
    var alpha = 2 / (length + 1), acc = 0, cnt = 0;
    for (var i = 0; i < b.length; i++) {
      if (isNa(b[i])) continue;
      if (cnt < length) { acc += b[i]; cnt++; if (cnt === length) series.__ema = acc / length; }
      else series.__ema = alpha * b[i] + (1 - alpha) * series.__ema;
    }
    return length > b.length ? NA : series.__ema;
  }
  function rmaSeries(series, length) {
    var b = series && series.__buf;
    length = nlen(length);
    if (!b || !(length > 0)) return NA;
    var acc = 0, cnt = 0;
    for (var i = 0; i < b.length; i++) {
      if (isNa(b[i])) continue;
      if (cnt < length) { acc += b[i]; cnt++; if (cnt === length) series.__ema = acc / length; }
      else series.__ema = (series.__ema * (length - 1) + b[i]) / length;
    }
    return length > b.length ? NA : series.__ema;
  }
  function emaSeriesAt(buf, length) { return emaSeries({ __buf: buf }, length); }
  function mulSeries(a, b) { return isNa(a) || isNa(b) ? NA : a * b; }
  function seriesMap2(a, b) { return isNa(a) || isNa(b) ? NA : a * b; }
  function rollingSub(s, n, k) {
    var m = rolling(s, n, mean);
    return m === NA ? NA : s - k * m;
  }

  /* -------------------------------------------------------- colours --- */
  var COLOR_NAMED = {
    red: "#f23645", green: "#089981", blue: "#2962ff", orange: "#ff9800",
    purple: "#9c27b0", yellow: "#ffd600", white: "#ffffff", black: "#000000",
    gray: "#787b86", grey: "#787b86", lime: "#00e676", teal: "#009688",
    navy: "#001f3f", maroon: "#800000", silver: "#c0c0c0", olive: "#808000",
    aqua: "#00ffff", fuchsia: "#ff00ff", skyblue: "#00bfff",
    transparent: "#00000000", na: "#00000000"
  };
  function parseColor(v) {
    /* A colour built by a call — color.new(color.blue, 10), color.tint(…),
     * color.rgb(…) — arrives as a Series wrapper, because *every* builtin
     * result is one so that colour builtins chain like everything else. Read
     * the current bar's colour out of it, and treat na as "no colour" rather
     * than letting Math.round(undefined) paint rgba(NaN,NaN,NaN,1). */
    if (v && v.__isSeries) v = v.val;
    if (isNa(v)) return { r: 0, g: 0, b: 0, a: 1 };
    if (v && typeof v === "object") return v;
    if (typeof v !== "string") return { r: 0, g: 0, b: 0, a: 1 };
    var s = v.toLowerCase();
    if (COLOR_NAMED[s]) v = COLOR_NAMED[s];
    if (v[0] !== "#") return { r: 0, g: 0, b: 0, a: 1 };
    var hex = v.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    var a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r: r, g: g, b: b, a: a };
  }
  function colorCss(c) {
    if (!c) return "transparent";
    if (typeof c === "string") return c;
    return "rgba(" + Math.round(c.r) + "," + Math.round(c.g) + "," + Math.round(c.b) + "," + (c.a === undefined ? 1 : c.a) + ")";
  }

  /* `time("D")` — the opening time of the higher timeframe's period that holds
   * this bar. Done in milliseconds on UTC calendar boundaries, because month
   * and week lengths are not fixed and a plain division would drift off the
   * real boundary. The bare `time` identifier stays an ordinary series, so
   * this is only reached when the name is actually called. */
  function periodOpen(tMs, tf) {
    var s = String(tf === undefined || tf === null ? "" : tf).trim().toUpperCase();
    var d, k, m;
    if (s === "D" || s === "1D") return Math.floor(tMs / 864e5) * 864e5;
    if (s === "W" || s === "1W") {
      /* Pine weeks start on Monday; 1970-01-01 was a Thursday. */
      var day = Math.floor(tMs / 864e5);
      return (day - ((day + 3) % 7)) * 864e5;
    }
    if (s === "M" || s === "1M") {
      d = new Date(tMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    if (s === "Y" || s === "1Y" || s === "12M") {
      d = new Date(tMs); return Date.UTC(d.getUTCFullYear(), 0, 1);
    }
    if ((m = s.match(/^([0-9]+)([DWMY])$/))) {
      k = parseInt(m[1], 10);
      if (m[2] === "D") return Math.floor(tMs / (k * 864e5)) * (k * 864e5);
      if (m[2] === "W") return Math.floor(tMs / (k * 6048e5)) * (k * 6048e5);
      if (m[2] === "M") { d = new Date(tMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (k - 1), 1); }
      d = new Date(tMs); return Date.UTC(d.getUTCFullYear() - (k - 1), 0, 1);
    }
    /* A bare number is a count of minutes — "60", "240", "1440". */
    if (/^[0-9]+$/.test(s)) { k = parseInt(s, 10); if (k > 0) return Math.floor(tMs / (k * 6e4)) * (k * 6e4); }
    return tMs;
  }

  /* Named constants scripts reference. Kept loose — the chart maps these onto
   * its own shape/location vocabulary when it paints them. */
  var SHAPE_CONSTS = {
    circle: "circle", cross: "cross", xcross: "xcross", triangleup: "triup",
    triangledown: "tridown", arrowup: "arrowup", arrowdown: "arrowdown",
    labelup: "labelup", labeldown: "labeldown", square: "square",
    diamond: "diamond", flagdown: "flagdown", flagup: "flagup"
  };
  var LOCATION_CONSTS = {
    abovebar: "abovebar", belowbar: "belowbar", top: "top", bottom: "bottom",
    absolute: "absolute", absolutetop: "absolutetop", absolutebottom: "absolutebottom"
  };
  var DISPLAY_CONSTS = {
    all: "all", price: "price", none: "none",
    status_line: "status", price_scale: "price", data_window: "data"
  };
  /* plot.style_* / hline.style_* / size.* — values the chart's renderer
   * understands, keyed exactly as Pine spells them. The bare spellings
   * (`plot.histogram`) are accepted too; plenty of published scripts use them
   * and TradingView tolerates the short form. */
  var PLOT_CONSTS = {
    style_line: "line", style_linebr: "linebr", style_area: "area",
    style_areabr: "area", style_stepline: "stepline", style_steplinebr: "stepline",
    style_columns: "columns", style_cross: "cross", style_histogram: "histogram",
    style_circles: "circles",
    line: "line", linebr: "linebr", area: "area", stepline: "stepline",
    columns: "columns", cross: "cross", histogram: "histogram", circles: "circles"
  };
  var HLINE_CONSTS = {
    style_solid: "solid", style_dashed: "dashed", style_dotted: "dotted",
    solid: "solid", dashed: "dashed", dotted: "dotted"
  };
  var SIZE_CONSTS = { tiny: "tiny", small: "small", normal: "normal", large: "large", auto: "auto" };
  /* label.new / line.new / box.new speak their own constant vocabulary.
     Registered in globals AND in COLOR_CONSTS so `eval("member")` resolves
     them either way round, the same dual path the style constants use. */
  var XLOC_CONSTS = { bar_index: "bar_index", bar_time: "bar_time" };
  var YLOC_CONSTS = { price: "price", top: "top", bottom: "bottom" };
  var EXTEND_CONSTS = { none: "none", left: "left", right: "right", both: "both" };
  var LINESTYLE_CONSTS = { style_solid: "solid", style_dotted: "dotted", style_dashed: "dashed",
                           solid: "solid", dotted: "dotted", dashed: "dashed" };
  var HALIGN_CONSTS = { left: "left", center: "center", right: "right" };
  var VALIGN_CONSTS = { top: "top", center: "center", bottom: "bottom" };
  var LABEL_STYLE_CONSTS = {
    none: "none", xcross: "xcross", cross: "cross", triangleup: "triup",
    diamond: "diamond", square: "square", flag: "flag",
    arrowup: "arrowup", arrowdown: "arrowdown",
    labelup: "labelup", labeldown: "labeldown", labelleft: "labelleft",
    labelright: "labelright", labelcenter: "labelcenter",
    style_none: "none", style_xcross: "xcross", style_cross: "cross",
    style_triangleup: "triup", style_diamond: "diamond", style_square: "square",
    style_flag: "flag", style_arrowup: "arrowup", style_arrowdown: "arrowdown",
    style_label_up: "labelup", style_label_down: "labeldown",
    style_label_left: "labelleft", style_label_right: "labelright",
    style_label_center: "labelcenter"
  };

  var COLOR_CONSTS = {
    color: {
      red: "#f23645", green: "#089981", blue: "#2962ff", orange: "#ff9800",
      purple: "#9c27b0", yellow: "#ffd600", white: "#ffffff", black: "#000000",
      gray: "#787b86", grey: "#787b86", lime: "#00e676", teal: "#009688",
      navy: "#001f3f", maroon: "#800000", silver: "#c0c0c0", olive: "#808000",
      aqua: "#00ffff", fuchsia: "#ff00ff", skyblue: "#00bfff",
      transparent: "rgba(0,0,0,0)", na: "rgba(0,0,0,0)"
    },
    syminfo: { ticker: "", tickerid: "", description: "", type: "crypto", currency: "USDT", session: "", timezone: "UTC", mintick: 0.01, pointvalue: 1, basecurrency: "" },
    timeframe: { isintraday: true, isdaily: false, isweekly: false, ismonthly: false, isseconds: false, isminutes: true, multipler: "", period: "" },
    /* Registered here as well as in globals: `eval("member")` falls back to
     * COLOR_CONSTS[root.name], so a style constant resolves either way round. */
    plot: PLOT_CONSTS, hline: HLINE_CONSTS, size: SIZE_CONSTS,
    xloc: XLOC_CONSTS, yloc: YLOC_CONSTS, extend: EXTEND_CONSTS,
    line: LINESTYLE_CONSTS, halign: HALIGN_CONSTS, valign: VALIGN_CONSTS,
    label: LABEL_STYLE_CONSTS, box: LINESTYLE_CONSTS
  };

  /* ============================================================ runtime ===
   * A compiled script is a list of statements.  To run it we step bar by
   * bar, keeping every variable in a Series (current value + history ring).
   * That is what makes `close[1]` and rolling ta.* functions work.
   * ======================================================================= */

  function Series() {
    this.val = NA;
    this.__buf = [];
    this.__ema = NA;
    this.__isSeries = true;
    this.__pbar = -1;
  }
  Series.prototype.push = function (v) {
    this.val = v;
    this.__buf.push(v);
    if (this.__buf.length > 4000) this.__buf.shift();
  };
  /* Writing a script variable gives it exactly one slot per bar, holding
   * whatever the variable ended that bar with. A second write on the same bar
   * replaces the slot instead of adding one — `float x = 0.0` followed by
   * `x := x + close` used to leave two entries per bar, which shifted every
   * `x[n]` read and every rolling window built from the variable. */
  Series.prototype.set = function (v, bar) {
    if (bar === this.__pbar && this.__buf.length) {
      /* Replace the slot *and* the current value — `val` is what every later
       * read sees, so leaving it stale would silently undo the write. */
      this.val = v;
      this.__buf[this.__buf.length - 1] = v;
    } else { this.__pbar = bar; this.push(v); }
    return v;
  };
  Series.prototype.at = function (n) {
    var b = this.__buf;
    if (n < 0 || n >= b.length) return NA;
    return b[b.length - 1 - n];
  };
  /* Lets `a + b` and `a > b` work on a series by falling back to its latest
   * value — which is exactly how Pine treats a series inside an expression. */
  Series.prototype.valueOf = function () { return isNa(this.val) ? NaN : this.val; };
  Series.prototype.toString = function () { return String(this.val); };

  /* Runtime context handed to builtins — gives them history access. */
  function Ctx(rt) {
    this.rt = rt;
  }
  /* `hiS`/`loS`/`volS`/`tpS` are built once from the whole dataset, so their
   * buffer already holds every bar while bar 0 is being evaluated. Reading it
   * whole means the builtin sees the future and returns the *same* value on
   * every bar — which is what made ta.atr, ta.supertrend and ta.ichimoku
   * draw a perfectly flat line. Truncate to the bar in hand. Script
   * variables already grow a bar at a time, so they come back untouched. */
  Ctx.prototype.buf = function (v) {
    if (!(v && v.__isSeries)) return [v];
    var b = v.__buf, lim = this.rt.bar + 1;
    return b.length <= lim ? b : b.slice(0, lim);
  };
  Ctx.prototype.prev = function (v, n) {
    if (!(v && v.__isSeries)) return NA;
    var k = n === undefined ? 1 : n;
    var b = this.buf(v), i = b.length - 1 - k;
    return i < 0 ? NA : b[i];
  };
  Ctx.prototype.prevN = function (v, n) { return this.prev(v, n); };
  Ctx.prototype.prevClose = function () { return this.rt.bar > 0 ? this.rt.closes[this.rt.bar - 1] : NA; };
  Ctx.prototype.hi = function () { return this.rt.highs[this.rt.bar]; };
  Ctx.prototype.lo = function () { return this.rt.lows[this.rt.bar]; };
  Ctx.prototype.close = function () { return this.rt.closes[this.rt.bar]; };
  Ctx.prototype.closes = function () {
    var a = this.rt.closes, lim = this.rt.bar + 1;
    return a.length <= lim ? a : a.slice(0, lim);
  };
  Ctx.prototype.vol = function () { return this.rt.vols[this.rt.bar]; };
  Ctx.prototype.hiSeries = function () { return this.rt.hiS; };
  Ctx.prototype.loSeries = function () { return this.rt.loS; };
  Ctx.prototype.volSeries = function () { return this.rt.volS; };
  /* ta.vwap / ta.obv / ta.accdist read accumulators the bar loop maintains on
   * the runtime. Builtins are handed a Ctx, not the runtime, so the store has
   * to be reachable from here — without it those three throw on the first bar
   * and every script that calls them dies with a property error. */
  Object.defineProperty(Ctx.prototype, "seriesStore", {
    get: function () { return this.rt.seriesStore; }
  });
  /* Returns the Series, not its latest value — rolling functions need the
   * whole buffer to work from. */
  Ctx.prototype.tpSeries = function () { return this.rt.tpS; };
  Ctx.prototype.callBuiltin = function (name, args) { return BUILTINS[name](this, args); };
  Ctx.prototype.highest = function (series, n) { return BUILTINS["ta.highest"](this, [series, n]); };
  Ctx.prototype.lowest = function (series, n) { return BUILTINS["ta.lowest"](this, [series, n]); };
  Ctx.prototype.crossUp = function (a, b) {
    var p = this.prev(a), pb = this.prev(b);
    return !isNa(p) && !isNa(pb) && !isNa(a) && !isNa(b) && p <= pb && a > b;
  };
  Ctx.prototype.crossDn = function (a, b) {
    var p = this.prev(a), pb = this.prev(b);
    return !isNa(p) && !isNa(pb) && !isNa(a) && !isNa(b) && p >= pb && a < b;
  };
  /* Condition history. `ta.barssince(ta.crossover(fast, slow))` hands the
   * builtin a bare boolean for the current bar — there is no series to read
   * back through — so each crossover keeps its own ring buffer, keyed by the
   * pair of series it compares. Two crossovers in one script therefore stay
   * separate instead of interleaving into one unusable log, and the most
   * recently written buffer is the one the enclosing call means. */
  Ctx.prototype.condBuf = function (a, b) {
    var rt = this.rt;
    rt.condKeys = rt.condKeys || [];
    rt.condBufs = rt.condBufs || [];
    for (var i = 0; i < rt.condKeys.length; i++) {
      if (rt.condKeys[i][0] === a && rt.condKeys[i][1] === b) {
        rt.lastCond = rt.condBufs[i];
        return rt.condBufs[i];
      }
    }
    rt.condKeys.push([a, b]);
    var nb = [];
    rt.condBufs.push(nb);
    rt.lastCond = nb;
    return nb;
  };
  Ctx.prototype.lastCondBuf = function () { return this.rt.lastCond || null; };
  function condPush(c, a, b, v) {
    var buf = c.condBuf(a, b);
    buf.push(v);
    if (buf.length > 4000) buf.shift();
    return v;
  }

  /* ------------------------------------------------------- the compiler ---
   * compile(src) -> { name, overlay, statements, inputs, error }
   * ======================================================================= */
  function compile(src) {
    var out = { name: "Custom", overlay: false, statements: null, inputs: [], error: null, version: 5 };
    var m = src.match(/@version\s*=\s*(\d+)/);
    if (m) out.version = parseInt(m[1], 10);
    try {
      out.statements = parse(lex(src));
    } catch (e) {
      out.error = e.message;
      /* The editor underlines the offending line in the gutter, so the number
         has to survive the trip out of the parser rather than being re-parsed
         back out of the message string. */
      out.errorLine = e.pineLine != null ? e.pineLine : 0;
      return out;
    }
    /* Read the header line: indicator("Name", overlay=true, …). It is a plain
     * expression statement, so it is lifted out here rather than executed. */
    var head = out.statements[0];
    if (head && head.k === "exprstat" && head.expr && head.expr.k === "call") {
      var cn = calleeName(head.expr.callee);
      if (cn === "indicator" || cn === "strategy" || cn === "library") {
        /* Both call shapes are everywhere in published scripts:
         *   indicator("Name", "Short", true)          <- positional
         *   indicator(title = "Name", overlay = true) <- keyword
         * Split first, then read each field from whichever form it arrived in.
         * Pine's positional order is (title, shorttitle, overlay), so the third
         * argument is the overlay flag rather than an unnamed extra. */
        var hp = [], hq = {};
        for (var hj = 0; hj < head.expr.args.length; hj++) {
          var hg = head.expr.args[hj];
          if (hg.k === "named") hq[hg.name] = hg.value;
          else hp.push(hg);
        }
        var hTitle = hp.length ? hp[0] : hq.title;
        if (hTitle && hTitle.k === "str") out.name = hTitle.v;
        var hShort = hp.length > 1 ? hp[1] : hq.shorttitle;
        if (hShort && hShort.k === "str") out.shorttitle = hShort.v;
        var hOv = hp.length > 2 ? hp[2] : hq.overlay;
        if (hOv) out.overlay = hOv.k === "bool" ? hOv.v : true;
      }
    }
    out.inputs = collectInputs(out.statements);
    return out;
  }

  /* ---------------------------------------------------------- inputs ---
   * Collected by walking the tree at compile time: the settings dialog has to
   * know every field before the script has ever run against a real bar, and
   * running it just to discover them would need bars that may not exist yet. */
  var INPUT_KINDS = {
    "input.int": "number", "input.float": "number", "input.bool": "checkbox",
    "input.string": "text", "input.color": "color", "input.source": "source",
    "input.timeframe": "timeframe", "input.price": "number"
  };
  function litOf(n) {
    if (!n || typeof n !== "object") return undefined;
    if (n.k === "num" || n.k === "str" || n.k === "bool" || n.k === "color") return n.v;
    if (n.k === "neg") { var v = litOf(n.e); return typeof v === "number" ? -v : v; }
    /* `input.color(color.red, …)` — resolve the named constant here, because
     * the settings panel has to show a colour before the script ever runs. */
    if (n.k === "member" && n.obj && n.obj.k === "ident") {
      var tbl = COLOR_CONSTS[n.obj.name];
      if (tbl && tbl[n.name] !== undefined) return tbl[n.name];
    }
    if (n.k === "tuple") {
      /* `options = ["Solid", "Dashed", "Dotted"]` — an array literal parses as
       * a tuple, and the settings panel renders it as a dropdown. */
      var outa = [];
      for (var oi = 0; oi < n.items.length; oi++) {
        var ov = litOf(n.items[oi]);
        if (ov === undefined) return undefined;
        outa.push(ov);
      }
      return outa;
    }
    return undefined;
  }

  /* Split a call's arguments into positional nodes and a name -> node map.
   * Pine reads the first two positionally (`input.int(9, "Length")`), but
   * nearly every published script uses the keyword form instead
   * (`input.int(defval = 9, title = "Length")`) or mixes the two. */
  function splitArgs(n) {
    var pos = [], named = {};
    for (var i = 0; i < n.args.length; i++) {
      var a = n.args[i];
      if (a && a.k === "named") named[a.name] = a.value;
      else pos.push(a);
    }
    return { pos: pos, named: named };
  }

  /* `group = GRP_BGA`, `tooltip = TIP_BG` — scripts define those labels as
   * their own top-level string constants, so resolve a bare identifier through
   * them rather than showing the variable name in the settings panel. */
  function stringConsts(stmts) {
    var map = {};
    for (var i = 0; i < stmts.length; i++) {
      var s = stmts[i];
      if (s && s.k === "assign" && s.op === "=" && s.target &&
          s.target.k === "ident" && s.value && s.value.k === "str") {
        map[s.target.name] = s.value.v;
      }
    }
    return map;
  }
  function litOfArg(n, consts) {
    if (n && n.k === "ident" && consts && consts[n.name] !== undefined) return consts[n.name];
    return litOf(n);
  }

  /* Keyed on the *title* rather than the default value: at compile time the
   * default of `input.color(color.red, …)` is a bare identifier, while at run
   * time it is an evaluated colour object — the two would never agree. The
   * title is a literal string on both sides.
   *
   * The *group* is part of the key as well, because published scripts reuse
   * one label across every section ("Enable", "Dark green", "Width"), and
   * without it ten distinct fields would collapse into a single setting. */
  function inputId(kind, group, title, dflt) {
    var t = title === undefined || title === null ? "" : String(title);
    var g = group === undefined || group === null ? "" : String(group);
    var base = g ? kind + ":" + g + " · " + t : kind + ":" + t;
    if (t) return base;
    /* Pine lets the title be dropped; without one, two untitled inputs of the
     * same kind and group would silently share a single setting. */
    return base + ":=" + String(dflt);
  }

  /* `input(…)` with no suffix is Pine's auto-detecting input — its type comes
   * from whatever the default happens to be. */
  function inputTypeOf(kind, dflt) {
    if (INPUT_KINDS[kind]) return INPUT_KINDS[kind];
    if (typeof dflt === "boolean") return "checkbox";
    if (typeof dflt === "number") return "number";
    if (typeof dflt === "string" && dflt.charAt(0) === "#") return "color";
    return "text";
  }

  var compiledInputCache = [];
  function compiledInput(cache, id, kind, rec) {
    for (var i = 0; i < cache.length; i++) if (cache[i].id === id) return cache[i];
    cache.push(rec);
    return rec;
  }

  function collectInputs(stmts) {
    var seen = {}, out = [], consts = stringConsts(stmts);
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) walk(n[i]); return; }
      if (n.k === "call") {
        var nm = calleeName(n.callee);
        if (nm && (INPUT_KINDS[nm] || nm === "input")) {
          var sp = splitArgs(n);
          var dflt = litOfArg(sp.pos.length ? sp.pos[0] : sp.named.defval, consts);
          var tNode = sp.pos.length > 1 ? sp.pos[1] : sp.named.title;
          var title = tNode && tNode.k === "str" ? tNode.v : "";
          var group = litOfArg(sp.named.group, consts);
          var rec = {
            id: inputId(nm, group, title, dflt),
            kind: nm,
            type: inputTypeOf(nm, dflt),
            dflt: dflt,
            title: title
          };
          if (typeof group === "string") rec.group = group;
          /* minval / maxval / options / step, and the panel's own group,
           * tooltip and inline labels — lifted off the keyword arguments. */
          for (var k2 in sp.named) {
            if (!Object.prototype.hasOwnProperty.call(sp.named, k2)) continue;
            var lv = litOfArg(sp.named[k2], consts);
            if (lv !== undefined) rec[k2] = lv;
          }
          if (rec.minval === undefined && sp.pos.length > 2) {
            var mn = litOfArg(sp.pos[2], consts);
            if (mn !== undefined) rec.minval = mn;
          }
          if (rec.maxval === undefined && sp.pos.length > 3) {
            var mx = litOfArg(sp.pos[3], consts);
            if (mx !== undefined) rec.maxval = mx;
          }
          if (!seen[rec.id]) { seen[rec.id] = 1; out.push(rec); }
        }
      }
      for (var k in n) {
        if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
        if (k === "__ser" || k === "__s" || k === "__entry" ||
            k === "__plotIndex" || k === "__lastBar") continue;
        walk(n[k]);
      }
    })(stmts);
    return out;
  }

  /* Compile once per source. The AST is not inert — call sites cache their
   * series on the node — so it is scrubbed before every run; otherwise the
   * second run would append to the first run's buffers and every series would
   * come out double length. */
  var STATE_KEYS = ["__ser", "__s", "__entry", "__plotIndex", "__lastBar"];
  function resetState(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) resetState(n[i]); return; }
    for (var j = 0; j < STATE_KEYS.length; j++) delete n[STATE_KEYS[j]];
    for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) resetState(n[k]);
  }
  var compiledCache = Object.create(null);
  function compileCached(src) {
    var c = compiledCache[src];
    if (c === undefined) { c = compile(src); compiledCache[src] = c; }
    if (c.statements) resetState(c.statements);
    return c;
  }

  /* ------------------------------------------------------------- runner ---
   * run(compiled, bars, settings) -> a render plan the chart can paint.
   * `settings` maps input ids -> values so the settings dialog can drive it.
   * ======================================================================= */
  function run(compiled, bars, settings) {
    if (compiled.error) throw new Error(compiled.error);
    var plan = {
      name: compiled.name, overlay: compiled.overlay,
      lines: [], shapes: [], hlines: [], fills: [], bgcolors: [],
      candles: [], errors: [], inputs: compiled.inputs,
      /* label.new / line.new / box.new are imperative drawing objects, not
         declarative plots: each call creates one object that later set/delete
         calls mutate, so they live in their own arrays keyed by handle. */
      labels: [], drawlines: [], boxes: []
    };

    var rt = new Runtime(compiled, bars, settings || {}, plan);
    try {
      rt.execute();
    } catch (e) {
      plan.errors.push(e.message);
    }
    return plan;
  }

  function Runtime(prog, bars, settings, plan) {
    this.prog = prog;
    this.n = bars.length;
    this.opens = bars.map(function (b) { return b.open; });
    this.highs = bars.map(function (b) { return b.high; });
    this.lows = bars.map(function (b) { return b.low; });
    this.closes = bars.map(function (b) { return b.close; });
    this.vols = bars.map(function (b) { return b.volume === undefined ? NA : b.volume; });
    this.times = bars.map(function (b) { return b.time; });
    this.hiS = mk(this.highs); this.loS = mk(this.lows); this.volS = mk(this.vols);
    this.tpS = mk(bars.map(function (b) { return (b.high + b.low + b.close) / 3; }));
    this.settings = settings;
    this.plan = plan;
    this.vars = {};
    this.funcs = {};
    this.condBuf = [];
    this.macdBuf = [];
    this.bar = -1;
    this.ctx = new Ctx(this);
    /* Imperative drawing objects. TradingView hands back a handle (an int) from
     * label.new / line.new / box.new, and the script then mutates that handle
     * with label.set / line.delete … long after the creating bar. Keeping the
     * live object in a map keyed by handle is what lets a later bar edit the
     * object the first bar made, exactly as Pine does. */
    this.drawSeq = 0;
    this.drawStore = {};
    /* Built-in series live in a persistent environment object so a script can
     * read `close`, `volume`, `bar_index` … as ordinary identifiers. One
     * value is appended per bar, which is what makes `close[1]` work. */
    this.globals = {
      close: new Series(), open: new Series(), high: new Series(), low: new Series(),
      volume: new Series(), hl2: new Series(), hlc3: new Series(), ohlc4: new Series(),
      bar_index: new Series(), time: new Series(),
      barstate: { isfirst: false, islast: false, isnew: false, isrealtime: false,
                  isconfirmed: true, ishistory: true, islastconfirmedhistory: false,
                  withinbars: 0, isupdate: false },
      shape: SHAPE_CONSTS, location: LOCATION_CONSTS, display: DISPLAY_CONSTS,
      plot: PLOT_CONSTS, hline: HLINE_CONSTS, size: SIZE_CONSTS,
      xloc: XLOC_CONSTS, yloc: YLOC_CONSTS, extend: EXTEND_CONSTS,
      line: LINESTYLE_CONSTS, halign: HALIGN_CONSTS, valign: VALIGN_CONSTS,
      /* The drawing-object namespaces. label.new / line.new / box.new live in
       * BUILTINS; these carry the style enums so `label.style_label_up` and
       * friends resolve instead of falling into na. */
      label: LABEL_STYLE_CONSTS, box: LINESTYLE_CONSTS,
      /* Strategy order execution is out of scope for a charting engine, but a
       * published strategy still has to *run* — these read back the state a
       * script with no orders would actually be in. */
      strategy: { position_size: 0, initial_capital: 100000, equity: 100000,
                  netprofit: 0, openprofit: 0, closedtrades: 0, opentrades: 0,
                  commission: 0, slippage: 0, pyramiding: 1,
                  process_orders_on_close: false, calc_on_every_tick: false,
                  order_id: 0, id: 0, ticker: "", position_avg_price: 0 },
      syminfo: COLOR_CONSTS.syminfo, timeframe: COLOR_CONSTS.timeframe
    };
    function mk(a) { var s = new Series(); s.__buf = a.slice(); s.val = a[a.length - 1]; return s; }
  }

  Runtime.prototype.hi = function () { return this.highs[this.bar]; };
  Runtime.prototype.lo = function () { return this.lows[this.bar]; };
  Runtime.prototype.close = function () { return this.closes[this.bar]; };
  Runtime.prototype.vol = function () { return this.vols[this.bar]; };
  Runtime.prototype.prevClose = function () { return this.bar > 0 ? this.closes[this.bar - 1] : NA; };

  /* User-defined functions are hoisted — a helper may sit at the bottom of the
   * file and still be called from the top, which is how Pine treats them and
   * how nearly every published script is laid out. Collected once, before any
   * bar runs, so the bar loop never has to rebuild the table. */
  Runtime.prototype.collectFns = function (stmts) {
    for (var i = 0; i < stmts.length; i++) {
      var s = stmts[i];
      if (s.k === "fndef") this.funcs[s.name] = { params: s.params, body: s.body };
      else if (s.k === "block") this.collectFns(s.body);
      else if (s.k === "if") {
        if (s.then && s.then.k === "block") this.collectFns(s.then.body);
        if (s.alt && s.alt.k === "block") this.collectFns(s.alt.body);
      }
    }
  };

  Runtime.prototype.execute = function () {
    this.funcs = {};
    this.collectFns(this.prog.statements);
    for (var i = 0; i < this.n; i++) {
      this.bar = i;
      /* derived accumulators that ta.mfi / ta.obv / ta.vwap depend on */
      var pc = this.prevClose();
      var up = isNa(pc) ? NA : Math.max(this.close() - pc, 0);
      var dn = isNa(pc) ? NA : Math.max(pc - this.close(), 0);
      this.ctx.upSeries = pushS(this.ctx.upSeries, up);
      this.ctx.dnSeries = pushS(this.ctx.dnSeries, dn);
      var tp = (this.hi() + this.lo() + this.close()) / 3;
      var ad = this.ctx.prevClose() === NA ? 0 : 0;
      var prevAD = this.__adPrev || 0;
      var range = this.hi() - this.lo();
      var clv = range === 0 ? 0 : ((this.close() - this.lo()) - (this.hi() - this.close())) / range;
      this.__adPrev = prevAD + clv * this.vols[this.bar];
      this.__vwapPrev = ((this.__vwapPrev || 0) + tp * this.vols[this.bar]) / ((this.__vwapPV || 0) + this.vols[this.bar]);
      this.__vwapPV = (this.__vwapPV || 0) + this.vols[this.bar];
      this.seriesStore = this.seriesStore || {};
      pushStore(this, "__ad", this.__adPrev);
      pushStore(this, "__vwap", this.__vwapPrev);
      pushStore(this, "__obv", (function (self) {
        var prev = self.__obvPrev || 0;
        var p = self.prevClose();
        var d = isNa(p) ? 0 : self.close() - p;
        self.__obvPrev = prev + (d > 0 ? self.vols[self.bar] : d < 0 ? -self.vols[self.bar] : 0);
        return self.__obvPrev;
      })(this));

      /* Append this bar's values to the built-in series so `close[1]`,
       * ta.* rolling windows and history references all resolve. */
      var g = this.globals;
      g.open.push(this.opens[this.bar]);
      g.high.push(this.hi());
      g.low.push(this.lo());
      g.close.push(this.close());
      g.volume.push(this.vols[this.bar]);
      g.hl2.push((this.hi() + this.lo()) / 2);
      g.hlc3.push((this.hi() + this.lo() + this.close()) / 3);
      g.ohlc4.push((this.opens[this.bar] + this.hi() + this.lo() + this.close()) / 4);
      g.bar_index.push(this.bar);
      g.time.push(this.times[this.bar]);
      g.barstate.isfirst = this.bar === 0;
      g.barstate.islast = this.bar === this.n - 1;
      g.barstate.isnew = true;
      g.barstate.ishistory = true;

      this.execBlock(this.prog.statements, g);
    }
    this.finalise();
  };

  function pushS(s, v) { if (!s) { s = new Series(); } s.push(v); return s; }
  function pushStore(rt, key, v) {
    rt.seriesStore[key] = rt.seriesStore[key] || [];
    rt.seriesStore[key].push(v);
    if (rt.seriesStore[key].length > 4000) rt.seriesStore[key].shift();
  }

  /* Statement execution.  `env` is the lexical scope chain; `var` bindings
   * live in a persistent store so they survive across bars. */
  Runtime.prototype.execBlock = function (stmts, env) {
    for (var i = 0; i < stmts.length; i++) {
      var r = this.execStmt(stmts[i], env);
      if (r && r.jump) return r;
    }
    return null;
  };

  Runtime.prototype.execStmt = function (s, env) {
    switch (s.k) {
      case "decl": {
        var key = s.name;
        if (!this.vars[key]) this.vars[key] = new Series();
        var dser = this.vars[key];
        var isVar = s.kind === "var" || s.kind === "varip";
        /* `var x = …` initialises once — on the first bar the declaration is
         * *reached* — and the variable then holds that value until something
         * assigns to it. Re-running the initialiser on every bar resets it
         * each time, so `var float cum = 0.0` with `cum := cum + close` beneath
         * it would draw `close` rather than a running total, and nothing would
         * say so. The old guard only spared the push when the initialiser was
         * `na`, which is why `var x = na` — the commonest form — worked while
         * every other initialiser silently did not. On later bars the
         * declaration just carries the current value forward, which is what
         * keeps the buffer at one entry per bar for a variable that nothing
         * ever assigns. */
        if (isVar && dser.__init) dser.set(lastValue(dser), this.bar);
        else {
          /* Store the *scalar*, not the series object: a variable is itself a
           * series, and nesting one inside another would leave every later
           * read holding an object instead of a number. */
          var dv = s.expr ? lastValue(this.eval(s.expr, env)) : NA;
          dser.set(dv, this.bar);
          if (isVar) dser.__init = true;
        }
        env[key] = dser;
        return null;
      }
      case "assign": {
        var tgt = s.target;
        var val = lastValue(this.eval(s.value, env));
        if (s.op !== "=") {
          var cur = this.eval(tgt, env);
          val = lastValue(compound(s.op, cur, val));
        }
        if (tgt.k === "ident") {
          var nm = tgt.name;
          if (!this.vars[nm]) this.vars[nm] = new Series();
          this.vars[nm].set(val, this.bar);
          env[nm] = this.vars[nm];
        }
        return null;
      }
      case "tupleassign": {
        /* [macdLine, signalLine, hist] = ta.macd(close, 12, 26, 9) */
        var tv = this.eval(s.value, env);
        var arr = Array.isArray(tv) ? tv : [tv];
        for (var t = 0; t < s.names.length; t++) {
          var tn = s.names[t];
          if (!this.vars[tn]) this.vars[tn] = new Series();
          /* A multi-value call hands back plain numbers, but a tuple built
           * from a series — request.security's [close, volume] — carries
           * Series objects. Unwrap those, or every plot downstream reads an
           * object instead of a price. */
          var el = arr[t] === undefined ? NA : arr[t];
          if (el && el.__isSeries) el = el.val;
          this.vars[tn].set(el, this.bar);
          env[tn] = this.vars[tn];
        }
        return null;
      }
      case "exprstat": this.eval(s.expr, env); return null;
      case "if": {
        var c = toBool(this.eval(s.cond, env));
        if (c) return this.execStmt(s.then, env);
        else if (s.alt) return this.execStmt(s.alt, env);
        return null;
      }
      case "block": return this.execBlock(s.body, env);
      case "for": {
        var start = this.eval(s.from, env);
        var it = isNa(start) ? 0 : start;
        var local = Object.create(env);
        for (var g = 0; g < 100000; g++) {
          local[s.name] = it;
          if (!toBool(this.eval(s.cond, local))) break;
          var rr = this.execStmt(s.body, local);
          if (rr && rr.jump === "break") break;
          if (rr && rr.jump === "continue") { /* fall through */ }
          var st = this.eval(s.step, local);
          it = isNa(st) ? it + 1 : st;
        }
        return null;
      }
      case "while": {
        var guard = 0;
        while (toBool(this.eval(s.cond, env)) && guard++ < 100000) {
          var wr = this.execStmt(s.body, env);
          if (wr && wr.jump === "break") break;
        }
        return null;
      }
      case "break": return { jump: "break" };
      case "continue": return { jump: "continue" };
      /* Already collected into this.funcs before the bar loop; a definition
       * reached at run time is simply skipped. `return` unwinds the call —
       * execBlock propagates any jump, so the same mechanism carries it out. */
      case "fndef": return null;
      case "return": return { jump: "return", value: s.value ? this.eval(s.value, env) : NA };
      case "switch": {
        if (s.target === null) {
          /* Condition form: each case is its own boolean test, tried in
           * order, and a `=>` case is the fallback. */
          for (var ci = 0; ci < s.cases.length; ci++) {
            var cs = s.cases[ci];
            if (cs.match === null) return this.execBlock(cs.body, env);
            if (toBool(this.eval(cs.match, env))) return this.execBlock(cs.body, env);
          }
          return null;
        }
        var tv = lastValue(this.eval(s.target, env));
        for (var cj = 0; cj < s.cases.length; cj++) {
          var ct = s.cases[cj];
          if (ct.match === null || lastValue(this.eval(ct.match, env)) === tv) {
            return this.execBlock(ct.body, env);
          }
        }
        return null;
      }
      default: return null;
    }
  };

  function compound(op, cur, val) {
    /* `:=` is a plain overwrite — `na` is a perfectly legal value to hold,
     * so `var float x = na` followed by `x := …` must be able to recover.
     * The other operators really are arithmetic, and there `na` poisons. */
    if (op === ":=") return val;
    if (isNa(cur) || isNa(val)) return NA;
    switch (op) {
      case "+=": return cur + val;
      case "-=": return cur - val;
      case "*=": return cur * val;
      case "/=": return cur / val;
      case "%=": return cur % val;
      default: return NA;
    }
  }

  /* --------------------------------------------------------- expressions --- */
  Runtime.prototype.eval = function (e, env) {
    switch (e.k) {
      case "num": return e.v;
      case "str": return e.v;
      case "bool": return e.v;
      case "color": return parseColor(e.v);
      case "na": return NA;
      /* `y = switch x` with `1 => 10` bodies — switch in value position.
       * The matched body runs as statements; whatever the last one evaluated
       * to is the value of the whole expression. */
      case "switchexpr": {
        var stv = lastValue(this.eval(e.target, env));
        for (var xi = 0; xi < e.cases.length; xi++) {
          var xc = e.cases[xi];
          if (xc.match !== null && lastValue(this.eval(xc.match, env)) !== stv) continue;
          var xv = NA;
          for (var xj = 0; xj < xc.body.length; xj++) {
            var xs = xc.body[xj];
            if (xs.k === "exprstat") xv = this.eval(xs.expr, env);
            else this.execStmt(xs, env);
          }
          return xv;
        }
        return NA;
      }
      /* A tuple value — `[20, 2]`, or whatever a multi-value call handed
       * back. Unwrapped straight into the destructuring in tupleassign;
       * the elements are already evaluated. */
      case "tuple": {
        var tv = [], ti;
        for (ti = 0; ti < e.items.length; ti++) tv.push(this.eval(e.items[ti], env));
        return tv;
      }
      case "ident": {
        var v = lookup(env, e.name);
        /* Returned as-is rather than unwrapped: a Series keeps its history
         * buffer so ta.* functions can chain, while valueOf makes it read
         * like a plain number in arithmetic and comparisons. */
        if (v !== undefined) return v;
        return NA;
      }
      case "member": {
        var o = this.eval(e.obj, env);
        if (o && typeof o === "object" && e.name in o) return o[e.name];
        var root = e.obj;
        if (root.k === "ident" && COLOR_CONSTS[root.name] && COLOR_CONSTS[root.name][e.name] !== undefined) {
          return COLOR_CONSTS[root.name][e.name];
        }
        /* A parameterless builtin written bare — `plot(ta.vwap)` — parses as a
         * member access rather than a call, so it used to fall through to NA
         * and the plot came out empty. Run it through the same per-node series
         * cache the call path uses, so its history still advances one value
         * per bar. Anything that genuinely needs arguments returns NA here,
         * exactly as an arity-mismatched call would. */
        var bn = root.k === "ident" ? root.name + "." + e.name : null;
        if (bn && BUILTINS[bn]) {
          var res;
          try { res = BUILTINS[bn](this.ctx, []); } catch (ex) { res = NA; }
          /* Always push, even an NA — the buffer has to stay one value per bar
           * or later history references drift out of step. */
          if (e.__ser === undefined) e.__ser = new Series();
          e.__ser.push(isNa(res) ? NA : res);
          return e.__ser;
        }
        return NA;
      }
      case "neg": { var v = this.eval(e.e, env); return isNa(v) ? NA : -v; }
      case "not": {
        var v = this.eval(e.e, env);
        /* A Series object is always truthy, so `not na(h)` came out false on
         * every bar until toBool was taught to see through it. */
        return isNa(v) ? false : !toBool(v);
      }
      case "cond3": {
        var c = toBool(this.eval(e.c, env));
        return c ? this.eval(e.a, env) : this.eval(e.b, env);
      }
      case "ifexpr": {
        return toBool(this.eval(e.c, env)) ? this.eval(e.a, env) : this.eval(e.b, env);
      }
      case "bin": {
        if (e.op === "and") { var l = toBool(this.eval(e.l, env)); return l ? toBool(this.eval(e.r, env)) : false; }
        if (e.op === "or") { var l = toBool(this.eval(e.l, env)); return l ? true : toBool(this.eval(e.r, env)); }
        var a = this.eval(e.l, env), b = this.eval(e.r, env);
        var v = binop(e.op, a, b);
        /* Comparisons are series too. ta.barssince / ta.valuewhen / ta.falling
         * need the whole history of a condition, not just today's answer, so
         * the result is cached as a series on the node. The bar-number guard
         * keeps a node sitting inside a loop body appending exactly once per
         * bar rather than once per iteration. */
        if (e.op === "<" || e.op === ">" || e.op === "<=" || e.op === ">=" || e.op === "==" || e.op === "!=") {
          if (!e.__s) { e.__s = new Series(); e.__lastBar = -1; }
          if (e.__lastBar !== this.bar) { e.__s.push(v); e.__lastBar = this.bar; }
          /* Re-evaluated on the same bar — a `for`/`while` condition, say.
           * The buffer must stay at one entry per bar, but the *current*
           * answer still has to track, or `while n < 5.0` would read a stale
           * true and spin to its guard. */
          else e.__s.val = v;
          return e.__s;
        }
        return v;
      }
      case "index": {
        var o = this.eval(e.obj, env);
        var off = this.eval(e.off, env);
        if (isNa(off)) return NA;
        if (o && o.__isSeries) return o.at(off | 0);
        return NA;
      }
      case "call": return this.call(e, env);
      default: return NA;
    }
  };

  function lookup(env, name) {
    var cur = env;
    while (cur) {
      if (Object.prototype.hasOwnProperty.call(cur, name)) return cur[name];
      cur = Object.getPrototypeOf(cur);
    }
    return undefined;
  }
  function unwrap(v) {
    if (v && v.__isSeries) return v.val;
    return v;
  }

  function binop(op, a, b) {
    /* Relational operators coerce a Series through valueOf, but `===` never
     * does — it compared the Series *object* to the literal, so `direction ==
     * -1` was false on every bar and a copied Supertrend's Sell/Buy shapes
     * never appeared. Unwrap both sides to the scalar the operator sees.
     * NA handling is unchanged: an unwrapped NA-series still fails to match
     * the NA sentinel, exactly as the object did before. */
    if (op === "==" || op === "!=") {
      var x = scalar(a), y = scalar(b);
      return op === "==" ? x === y : x !== y;
    }
    /* string concatenation in Pine is `+` on strings */
    if (op === "+" && (typeof a === "string" || typeof b === "string")) {
      return str(a) + str(b);
    }
    if (isNa(a) || isNa(b)) {
      return NA;
    }
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? NA : a / b;
      case "%": return b === 0 ? NA : a % b;
      case "**": return Math.pow(a, b);
      case "<": return a < b;
      case ">": return a > b;
      case "<=": return a <= b;
      case ">=": return a >= b;
      default: return NA;
    }
  }
  function scalar(v) { v = unwrap(v); return isNa(v) ? NaN : v; }
  function str(v) { return isNa(v) ? "NaN" : String(v); }

  /* -------------------------------------------------------------- calls --- */
  /* Run a script's own helper. Every call gets its own variable namespace:
   * a function's locals must not collide with a global of the same name, and a
   * second call on the same bar must not overwrite the first one's. Saving and
   * restoring `this.vars` buys both, and makes recursion work for free. The
   * scope descends from the globals, not the caller — Pine has no closures, so
   * a helper sees the script's top level and nothing of whoever called it. */
  Runtime.prototype.callUser = function (fn, args, named, env) {
    var savedVars = this.vars;
    this.vars = {};
    var scope = Object.create(this.globals);
    for (var i = 0; i < fn.params.length; i++) {
      var pr = fn.params[i];
      if (i < args.length) scope[pr.name] = args[i];
      else if (named[pr.name] !== undefined) scope[pr.name] = named[pr.name];
      else if (pr.def) scope[pr.name] = this.eval(pr.def, scope);
      else scope[pr.name] = NA;
    }
    var body = fn.body && fn.body.k === "block" ? fn.body.body : [fn.body];
    var res = NA;
    try {
      var r = this.execBlock(body, scope);
      if (r && r.jump === "return") res = r.value;
    } finally { this.vars = savedVars; }
    return res;
  };

  Runtime.prototype.call = function (e, env) {
    var self = this;
    var name = calleeName(e.callee);
    /* Split positional from keyword arguments: builtins consume the
     * positional ones, while plot()/input() primitives consume the keywords. */
    var pos = [], named = {};
    for (var ai = 0; ai < e.args.length; ai++) {
      var ag = e.args[ai];
      if (ag.k === "named") named[ag.name] = self.eval(ag.value, env);
      else pos.push(self.eval(ag, env));
    }
    var args = pos;

    if (!name) return NA;
    /* A script's own helper wins over any builtin of the same name — the same
     * shadowing Pine does — so this is checked before the builtin table. */
    var ufn = this.funcs && this.funcs[name];
    if (ufn) return this.callUser(ufn, args, named, env);
    /* Pine v4 and most copy-pasted scripts use the bare names — `rsi(close,14)`,
     * `ema(close,20)`, `crossover(a,b)`, `security(...)` — which v5 renamed to
     * `ta.*` / `math.*` / `request.*`. Fall through to the prefixed form rather
     * than reporting an unknown function. */
    var fn = BUILTINS[name], resolved = name;
    if (!fn && name.indexOf(".") === -1) {
      if (BUILTINS["ta." + name]) { fn = BUILTINS["ta." + name]; resolved = "ta." + name; }
      else if (BUILTINS["math." + name]) { fn = BUILTINS["math." + name]; resolved = "math." + name; }
      else if (BUILTINS["request." + name]) { fn = BUILTINS["request." + name]; resolved = "request." + name; }
    }
    if (fn) {
      var res = fn(this.ctx, args);
      /* Tuple builtins (ta.macd, ta.dmi …) stay arrays so a script can
       * destructure them. Everything else becomes a Series cached on its own
       * call site: one value is appended per bar, so the buffer stays in step
       * and `ta.ema(ta.sma(close, 9), 9)` chains correctly instead of losing
       * the inner series' history. */
      if (TUPLE_BUILTINS[resolved]) return res;
      if (e.__ser === undefined) e.__ser = new Series();
      /* A builtin that returns its own argument (nz, math.abs, …) hands back
       * the series it was given; push the scalar so it is not nested inside
       * another series. Anything else is already a scalar here. */
      e.__ser.push(isNa(res) ? NA : unwrap(res));
      return e.__ser;
    }

    switch (name) {
      /* Declarations. compile() reads them off the first statement to get the
       * title/overlay; the bar loop still walks over the expression itself,
       * so it has to be a deliberate no-op rather than an unknown function. */
      case "indicator":
      case "study":
      case "strategy":
      case "library":
        return NA;
      case "plot": return this.doPlot(args, named, e);
      case "plotshape": return this.doShape(args, named, e);
      case "plotchar": return this.doChar(args, named, e);
      case "plotcandle": return this.doCandle(args, named, e);
      case "hline": return this.doHline(args, named, e);
      case "fill": return this.doFill(args, named, e);
      case "bgcolor": return this.doBg(args, named);
      /* TradingView's imperative drawing objects. Each mints a handle the
       * script can later mutate or delete from another bar, which is why
       * they carry their own plan arrays instead of aligning like a plot. */
      case "label.new": return this.doLabel(args, named);
      case "line.new": return this.doLineDraw(args, named);
      case "box.new": return this.doBoxDraw(args, named);
      case "label.delete": case "line.delete": case "box.delete":
        return this.drawDelete(args);
      case "label.get_last": return this.drawLast(this.plan.labels);
      case "line.get_last": return this.drawLast(this.plan.drawlines);
      case "box.get_last": return this.drawLast(this.plan.boxes);
      case "alert": return NA;
      case "alertcondition": return NA;
      case "time": {
        /* The function form of the `time` series: `time("D")` is the opening
         * time of the day that holds this bar, so it stays flat across a day's
         * hourly bars and steps on the boundary. The chart's own timestamps
         * are bucketed in milliseconds and handed back in whatever unit they
         * arrived in, so `time(tf)` and bare `time` always agree. */
        if (args.length === 0 || isNa(args[0]) || isNa(this.times[this.bar])) return NA;
        var rawT = this.times[this.bar];
        var inMs = Math.abs(rawT) < 1e11;
        var po = periodOpen(inMs ? rawT * 1000 : rawT, args[0]);
        return inMs ? po / 1000 : po;
      }
      case "input":
      case "input.int":
      case "input.float":
      case "input.bool":
      case "input.string":
      case "input.color":
      case "input.source":
      case "input.timeframe":
      case "input.price": {
        /* Keyword form as well as positional — `input.int(defval = 9,
         * title = "Length")` is what most published scripts actually write,
         * and the id has to come out identical to the one collectInputs()
         * derived at compile time or the dialog's value would never be read. */
        var dflt = args.length ? args[0] : named.defval;
        if (dflt === undefined) dflt = NA;
        /* `title = "X"` / `group = GRP_A` reach here as evaluated values, and a
         * script that names its label from a variable hands back a Series —
         * only a plain string can key an id, so unwrap before comparing. */
        var ititle = (args.length > 1 && typeof args[1] === "string") ? args[1]
                   : unwrap(named.title);
        if (typeof ititle !== "string") ititle = "";
        var id = this.inputIdFor(name, named.group, ititle, unwrap(dflt));
        var val = this.settings[id];
        if (val === undefined) {
          compiledInput(compiledInputCache, id, name, {
            id: id, kind: name, type: inputTypeOf(name, dflt), dflt: dflt, title: ititle
          });
          val = dflt;
        }
        /* minval / maxval clamp a value handed back by the settings dialog,
         * the same way Pine clamps one typed into its own panel. */
        if (typeof val === "number") {
          var imn = args.length > 2 ? args[2] : named.minval;
          var imx = args.length > 3 ? args[3] : named.maxval;
          if (typeof imn === "number" && val < imn) val = imn;
          if (typeof imx === "number" && val > imx) val = imx;
        }
        /* The settings dialog hands back the *name* of a source ("open"); the
         * script needs the series it points at. */
        if (name === "input.source" && typeof val === "string") {
          var sv = this.globals[val];
          if (sv && sv.__isSeries) return sv;
        }
        return val;
      }
      default:
        /* label.set_y / line.set_x2 / box.get_left … — the accessor family
         * is closed (every setter is one of the object's own fields, prefixed
         * by its namespace) so it is routed by shape instead of being listed
         * case by case. A miss still falls through to the error below. */
        if (name && this.drawAccessor(name, args, named)) return this.__drawRet;
        /* A mistyped or unimplemented function used to fall through to na
         * and quietly draw nothing — indistinguishable from a script that
         * legitimately evaluates to na. Surface it once, with the line. */
        if (name) {
          var umsg = "line " + (e.line || "?") + ": unknown function '" + name + "'";
          if (this.plan.errors.indexOf(umsg) === -1) this.plan.errors.push(umsg);
        }
        return NA;
    }
  };

  /* Plot primitives are *declarative* in Pine: the script reaches them once
   * per bar, but they declare a single plot. So the entry is created on the
   * first bar and every later bar only appends one value — which also keeps
   * the value arrays aligned with the bar index instead of being re-copied
   * on each pass (that would be O(n²) and one entry per bar). */
  function lastValue(v) {
    v = unwrap(v);
    return isNa(v) ? NA : v;
  }
  Runtime.prototype.ensure = function (node, arr, make) {
    if (node.__entry === undefined) { node.__entry = make(); arr.push(node.__entry); }
    return node.__entry;
  };
  /* Keep a plot's value array exactly one slot per bar, in step with
   * `d.time`. A plot inside an `if` only fires on the bars where the branch
   * is taken, and one inside a loop body can fire twice — without this its
   * values would slide sideways against the candles and every later bar would
   * be plotted at the wrong time. Gaps are na (a break in the line), and a
   * repeat on the same bar keeps the last value, which is what TradingView
   * shows too. */
  Runtime.prototype.align = function (ent, v) { alignOne(ent.values, this.bar, v); };
  function alignOne(arr, n, v) {
    if (arr.length > n) arr.length = n;
    while (arr.length < n) arr.push(NA);
    arr.push(v);
  }

  /* Pine spells a plot's title as a positional argument far more often than as
   * a named one — plot(close, "Basis"), hline(70, "Overbought") — so read it
   * from wherever the script put it. */
  function argTitle(args, i, dflt) {
    var t = args[i];
    return typeof t === "string" ? t : dflt;
  }
  /* Pine's plot* signatures are positional — `plotshape(cond, "Sell",
   * shape.triangleup, location.abovebar, color.red)` is the form most copied
   * scripts use, and it only reached the named-argument path, so style and
   * location silently fell back to their defaults. Fill any option the script
   * did not name from the positional slots, in Pine's declared order. */
  Runtime.prototype.fillPos = function (args, o, names, i0) {
    /* Positional arguments take the next parameter that no keyword claimed,
     * which is how Pine reads a partly-named call like
     * `plotshape(c, "Buy", shape.x, location=location.belowbar, color.green)`
     * — the colour skips the keyword's slot instead of landing on it.
     * Most plot primitives take their subject first and start the named list
     * at `title`, so the scan opens at args[1]; label.new / line.new /
     * box.new have no subject and open at args[0]. */
    var slot = 0, i = i0 === undefined ? 1 : i0;
    while (i < args.length && slot < names.length) {
      while (slot < names.length && o[names[slot]] !== undefined) slot++;
      if (slot >= names.length) break;
      /* `title` is the one slot a script may leave out while passing a later
       * argument — only take it when it really is a title. */
      if (names[slot] === "title" && typeof args[i] !== "string") { slot++; continue; }
      o[names[slot]] = args[i];
      slot++; i++;
    }
    return o;
  };
  Runtime.prototype.doPlot = function (args, o, node) {
    var series = args[0];
    if (series === undefined) return NA;
    this.fillPos(args, o, ["title", "color", "linewidth", "style", "trackprice",
                           "histbase", "offset", "join", "editable", "show_last", "display"]);
    var self = this;
    var ent = this.ensure(node, this.plan.lines, function () {
      node.__plotIndex = self.plan.lines.length;
      return {
        title: o.title !== undefined ? o.title : argTitle(args, 1, "Plot"),
        color: colorCss(o.color !== undefined ? parseColor(o.color) : "#2962ff"),
        width: o.linewidth !== undefined ? o.linewidth : 2,
        style: o.style !== undefined ? o.style : "line",
        overlay: self.prog.overlay,
        histBase: o.histbase !== undefined ? o.histbase : (o.histogram_base !== undefined ? o.histogram_base : 0),
        display: o.display !== undefined ? o.display : "all",
        /* Pine lets `color` be a series — plot(ma, color = stacked ? green :
         * red) — so a line can change colour bar by bar. Recorded as a sparse
         * list of the bars where it *switched*, which stays a handful of
         * entries even over a long history instead of one string per bar. */
        colors: null,
        curColor: null,
        values: []
      };
    });
    var cc = colorCss(parseColor(o.color !== undefined ? o.color : ent.color));
    if (ent.curColor === null) ent.curColor = ent.color;
    if (cc !== ent.curColor) {
      if (!ent.colors) ent.colors = [];
      ent.colors.push({ at: this.bar, color: cc });
      ent.curColor = cc;
    }
    this.align(node.__entry, lastValue(series));
    /* Pine hands back a plot *handle* here, which is what fill() consumes:
     * `p1 = plot(upper), p2 = plot(lower), fill(p1, p2, …)`. */
    return { __plotIndex: node.__plotIndex };
  };
  Runtime.prototype.doShape = function (args, o, node) {
    /* Pine: plotshape(series, title, style, location, color, offset, text, …) */
    this.fillPos(args, o, ["title", "style", "location", "color", "offset",
                           "text", "textcolor", "editable", "size", "show_last"]);
    var self = this;
    var entry = this.ensure(node, this.plan.shapes, function () {
      return {
        title: o.title !== undefined ? o.title : argTitle(args, 1, ""),
        location: o.location !== undefined ? o.location : "abovebar",
        style: o.style !== undefined ? o.style : "circle",
        text: o.text !== undefined ? String(o.text) : "",
        size: o.size !== undefined ? o.size : "auto",
        offset: o.offset !== undefined ? o.offset : 0,
        color: colorCss(o.color !== undefined ? parseColor(o.color) : "#f23645"),
        values: []
      };
    });
    this.align(entry, lastValue(args[0]));
    return NA;
  };
  Runtime.prototype.doChar = function (args, o, node) {
    /* Pine: plotchar(series, title, char, location, color, offset, …) */
    this.fillPos(args, o, ["title", "char", "location", "color", "offset",
                           "text", "textcolor", "editable", "size", "show_last"]);
    if (o.character === undefined && o.char !== undefined) o.character = o.char;
    var self = this;
    var entry = this.ensure(node, this.plan.shapes, function () {
      return {
        location: o.location !== undefined ? o.location : "abovebar",
        char: o.character !== undefined ? o.character : "•",
        style: "char",
        offset: o.offset !== undefined ? o.offset : 0,
        color: colorCss(o.color !== undefined ? parseColor(o.color) : "#f23645"),
        values: []
      };
    });
    this.align(entry, lastValue(args[0]));
    return NA;
  };
  /* ------------------------------------------------- drawing objects ---
   * label.new / line.new / box.new are TradingView's imperative drawing API,
   * and published scripts lean on them constantly. They are not plots: each
   * call mints a handle that later `set`/`delete` calls from a *different*
   * bar mutate, so the objects live in the plan keyed by handle rather than
   * being aligned one value per bar like a plot. Each call site also records
   * the bar it fired on, which is what turns an object into a marker/segment
   * the chart can actually place.
   * ======================================================================= */
  /* Pine's x is a bar index under xloc.bar_index (the default) and a
     unix-millisecond stamp under xloc.bar_time. Both have to become an index
     into this.times so the chart can look the position up by time. */
  Runtime.prototype.drawBar = function (x, xloc) {
    var v = lastValue(x);
    if (!isNum(v)) return -1;
    if (xloc === "bar_time") {
      var want = v > 1e11 ? v / 1000 : v;
      var best = -1, bd = Infinity;
      for (var i = 0; i < this.times.length; i++) {
        var dd = Math.abs(this.times[i] - want);
        if (dd < bd) { bd = dd; best = i; }
      }
      return best;
    }
    var n = Math.round(v);
    return n >= 0 && n < this.times.length ? n : -1;
  };
  Runtime.prototype.newDraw = function (arr, obj) {
    var id = ++this.drawSeq;
    obj.id = id;
    obj.dead = false;
    this.drawStore[id] = obj;
    arr.push(obj);
    /* TradingView keeps one handle per namespace pointing at the most recent
       object, which is what `label.get_last(bar_index)` hands back. */
    this.drawStore["$" + arr.length] = id;
    return id;
  };
  Runtime.prototype.drawGet = function (id) {
    var o = this.drawStore[lastValue(id)];
    return o && !o.dead ? o : null;
  };
  Runtime.prototype.drawLast = function (arr) {
    for (var i = arr.length - 1; i >= 0; i--) if (!arr[i].dead) return arr[i].id;
    return -1;
  };
  /* Applying the keyword/positional options a set() shares with new(). */
  Runtime.prototype.drawStyleInto = function (o, names, args) {
    this.fillPos(args, o, names, 1);
    if (o.color !== undefined) o.color = colorCss(parseColor(o.color));
    return o;
  };

  Runtime.prototype.doLabel = function (args, o) {
    /* label.new(x, y, text, xloc, yloc, color, style, textcolor, size, …) */
    this.fillPos(args, o, ["x", "y", "text", "xloc", "yloc", "color", "style",
                           "textcolor", "size", "textalign"], 0);
    var L = {
      kind: "label", bar: this.drawBar(o.x, o.xloc),
      price: isNa(o.y) ? null : +lastValue(o.y),
      text: o.text === undefined ? "" : String(o.text),
      xloc: o.xloc !== undefined ? o.xloc : "bar_index",
      yloc: o.yloc !== undefined ? o.yloc : "price",
      color: colorCss(o.color !== undefined ? parseColor(o.color) : "#2962ff"),
      style: o.style !== undefined ? String(o.style) : "labelup",
      textcolor: colorCss(o.textcolor !== undefined ? parseColor(o.textcolor) : "#ffffff"),
      size: o.size !== undefined ? String(o.size) : "auto"
    };
    if (L.bar < 0) return -1;
    return this.newDraw(this.plan.labels, L);
  };
  Runtime.prototype.doLineDraw = function (args, o) {
    /* line.new(x1, y1, x2, y2, xloc, extend, color, style, width) */
    this.fillPos(args, o, ["x1", "y1", "x2", "y2", "xloc", "extend",
                           "color", "style", "width"], 0);
    var L = {
      kind: "line", bar1: this.drawBar(o.x1, o.xloc), bar2: this.drawBar(o.x2, o.xloc),
      p1: isNa(o.y1) ? null : +lastValue(o.y1),
      p2: isNa(o.y2) ? null : +lastValue(o.y2),
      xloc: o.xloc !== undefined ? o.xloc : "bar_index",
      extend: o.extend !== undefined ? o.extend : "none",
      color: colorCss(o.color !== undefined ? parseColor(o.color) : "#2962ff"),
      style: o.style !== undefined ? String(o.style) : "solid",
      width: isNum(o.width) ? o.width : 1
    };
    if (L.bar1 < 0 && L.bar2 < 0) return -1;
    return this.newDraw(this.plan.drawlines, L);
  };
  Runtime.prototype.doBoxDraw = function (args, o) {
    /* box.new(left, top, right, bottom, xloc, extend_left, extend_right,
       border_color, border_style, border_width, text, …) */
    this.fillPos(args, o, ["left", "top", "right", "bottom", "xloc",
                           "extend_left", "extend_right", "border_color",
                           "border_style", "border_width", "text"], 0);
    var B = {
      kind: "box", bar1: this.drawBar(o.left, o.xloc), bar2: this.drawBar(o.right, o.xloc),
      top: isNa(o.top) ? null : +lastValue(o.top),
      bottom: isNa(o.bottom) ? null : +lastValue(o.bottom),
      xloc: o.xloc !== undefined ? o.xloc : "bar_index",
      color: colorCss(o.border_color !== undefined ? parseColor(o.border_color) : "#2962ff"),
      bgcolor: o.bgcolor !== undefined ? colorCss(parseColor(o.bgcolor)) : "rgba(0,0,0,0)",
      style: o.border_style !== undefined ? String(o.border_style) : "solid",
      width: isNum(o.border_width) ? o.border_width : 1,
      text: o.text === undefined ? "" : String(o.text)
    };
    if (B.bar1 < 0 && B.bar2 < 0) return -1;
    return this.newDraw(this.plan.boxes, B);
  };

  /* label.set / line.set / box.set — the same option list as the matching
     new(), shifted one slot right because arg 0 is the handle. Re-running the
     position mapping matters: a set() may hand back a bar index or a
     timestamp exactly as new() did. */
  var DRAW_SET_NAMES = {
    label: ["x", "y", "text", "xloc", "yloc", "color", "style",
            "textcolor", "size", "textalign"],
    line: ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width"],
    box: ["left", "top", "right", "bottom", "xloc", "extend_left", "extend_right",
          "border_color", "border_style", "border_width", "text", "bgcolor"]
  };
  Runtime.prototype.drawUpdate = function (arr, args, o, names) {
    var self = this;
    var obj = this.drawGet(args[0]);
    if (!obj) return NA;
    /* Start from the object's live fields, layer the caller's keyword (or
       single-field accessor) values over them, then let any remaining
       positional arguments fill the slots no keyword claimed. Working on a
       copy is what keeps a field the script omitted at its old value instead
       of being blanked with undefined. */
    var keep = {};
    names.forEach(function (k) { if (obj[k] !== undefined) keep[k] = obj[k]; });
    if (o) names.forEach(function (k) { if (o[k] !== undefined) keep[k] = o[k]; });
    this.fillPos(args, keep, names, 1);
    names.forEach(function (k) {
      if (keep[k] === undefined) return;
      if (k === "x") { obj.bar = self.drawBar(keep.x, keep.xloc); return; }
      if (k === "y") { obj.price = isNa(keep.y) ? null : +lastValue(keep.y); return; }
      if (k === "x1") { obj.bar1 = self.drawBar(keep.x1, keep.xloc); return; }
      if (k === "y1") { obj.p1 = isNa(keep.y1) ? null : +lastValue(keep.y1); return; }
      if (k === "x2") { obj.bar2 = self.drawBar(keep.x2, keep.xloc); return; }
      if (k === "y2") { obj.p2 = isNa(keep.y2) ? null : +lastValue(keep.y2); return; }
      if (k === "left") { obj.bar1 = self.drawBar(keep.left, keep.xloc); return; }
      if (k === "right") { obj.bar2 = self.drawBar(keep.right, keep.xloc); return; }
      if (k === "top") { obj.top = isNa(keep.top) ? null : +lastValue(keep.top); return; }
      if (k === "bottom") { obj.bottom = isNa(keep.bottom) ? null : +lastValue(keep.bottom); return; }
      if (k === "color" || k === "border_color") { obj.color = colorCss(parseColor(keep[k])); return; }
      if (k === "bgcolor") { obj.bgcolor = colorCss(parseColor(keep.bgcolor)); return; }
      obj[k] = keep[k];
    });
    return obj.id;
  };
  Runtime.prototype.drawDelete = function (args) {
    var obj = this.drawGet(args[0]);
    if (obj) obj.dead = true;
    return NA;
  };
  /* TradingView's accessor family on a drawing object: `label.set(id, …)`,
     `label.set_y(id, y)`, `line.set_xy2(id, x, y)`, `box.get_left(id)`. The
     set is closed — every setter names a field of its own object — so it is
     routed by shape rather than listed case by case. Returns false when the
     name is not one of these, which lets the caller report it as unknown. */
  var DRAW_NS = { label: 1, line: 1, box: 1 };
  var DRAW_ARGV = {   /* setters that take more than the handle and one value */
    line_set_xy1: ["x1", "y1"], line_set_xy2: ["x2", "y2"],
    label_set_xy: ["x", "y"], box_set_lefttop: ["left", "top"],
    box_set_rightbottom: ["right", "bottom"], box_set_topbottom: ["top", "bottom"]
  };
  Runtime.prototype.drawAccessor = function (name, args, named) {
    var dot = name.indexOf(".");
    if (dot < 0) return false;
    var ns = name.slice(0, dot), rest = name.slice(dot + 1);
    if (!DRAW_NS[ns]) return false;
    var arr = ns === "label" ? this.plan.labels : ns === "line" ? this.plan.drawlines : this.plan.boxes;
    if (rest === "set") { this.__drawRet = this.drawUpdate(arr, args, named, DRAW_SET_NAMES[ns]); return true; }
    if (rest.indexOf("set_") === 0) {
      var fld = rest.slice(4);
      var argv = DRAW_ARGV[ns + "_set_" + fld];
      if (argv) {
        var multi = {};
        argv.forEach(function (k, i) { if (args[i + 1] !== undefined) multi[k] = args[i + 1]; });
        this.__drawRet = this.drawUpdate(arr, [args[0]], multi, argv);
        return true;
      }
      if (DRAW_SET_NAMES[ns].indexOf(fld) === -1) return false;
      var one = {};
      one[fld] = args[1];
      this.__drawRet = this.drawUpdate(arr, [args[0]], one, [fld]);
      return true;
    }
    if (rest.indexOf("get_") === 0) {
      this.__drawRet = this.drawGetField(arr, args, rest.slice(4));
      return true;
    }
    return false;
  };
  /* label.get_x / line.get_y2 / box.get_left — the field name is the tail of
     the builtin name, mapped onto whatever the object stores it as. */
  var DRAW_GET_MAP = {
    label: { x: "bar", y: "price", text: "text" },
    line: { x1: "bar1", y1: "p1", x2: "bar2", y2: "p2" },
    box: { left: "bar1", top: "top", right: "bar2", bottom: "bottom" }
  };
  Runtime.prototype.drawGetField = function (arr, args, field) {
    var obj = this.drawGet(args[0]);
    if (!obj) return NA;
    var map = DRAW_GET_MAP[obj.kind] || {};
    var key = map[field] !== undefined ? map[field] : field;
    var v = obj[key];
    return v === undefined || v === null ? NA : v;
  };

  Runtime.prototype.doCandle = function (args, o, node) {
    var entry = this.ensure(node, this.plan.candles, function () {
      return {
        colorUp: colorCss(o.bordercolor_up !== undefined ? parseColor(o.bordercolor_up) : "#089981"),
        colorDown: colorCss(o.bordercolor_down !== undefined ? parseColor(o.bordercolor_down) : "#f23645"),
        values: []
      };
    });
    this.align(entry, lastValue(args[0]));
    return NA;
  };
  Runtime.prototype.doHline = function (args, o, node) {
    /* Pine: hline(price, title, color, linestyle, linewidth, editable, …) */
    this.fillPos(args, o, ["title", "color", "linestyle", "linewidth",
                           "editable", "show_last", "display"]);
    if (o.style === undefined && o.linestyle !== undefined) o.style = o.linestyle;
    /* hline is a constant level — declared once, never appended to. */
    this.ensure(node, this.plan.hlines, function () {
      return {
        price: lastValue(args[0]),
        title: o.title !== undefined ? o.title : argTitle(args, 1, ""),
        color: colorCss(o.color !== undefined ? parseColor(o.color) : "#787b86"),
        width: o.linewidth !== undefined ? o.linewidth : 1,
        style: o.style !== undefined ? o.style : "solid"
      };
    });
    return NA;
  };
  /* A plot handle resolves back to the *latest value* of its line, so fill()
   * can span two already-plotted lines across the current bar. */
  Runtime.prototype.plotValue = function (v) {
    if (v && v.__plotIndex !== undefined) {
      var L = this.plan.lines[v.__plotIndex];
      if (L && L.values.length) return L.values[L.values.length - 1];
    }
    return lastValue(v);
  };
  Runtime.prototype.doFill = function (args, o, node) {
    var a = args[0], b = args[1];
    if (a === undefined || b === undefined) return NA;
    var entry = this.ensure(node, this.plan.fills, function () {
      return {
        color: colorCss(o.color !== undefined ? parseColor(o.color) : "rgba(41,98,255,0.1)"),
        from: [], to: []
      };
    });
    alignOne(entry.from, this.bar, this.plotValue(a));
    alignOne(entry.to, this.bar, this.plotValue(b));
    return NA;
  };
  Runtime.prototype.doBg = function (args, o) {
    /* bgcolour is genuinely per-bar: only bars where the value holds get
     * painted, so this one appends rather than declaring. Pine's first
     * positional argument is the *colour* — bgcolor(f(...), title = "…") —
     * which is the only way a script blending its own colours can call it. A
     * bare boolean is the shorthand this engine also accepts, and keeps the
     * default blue. */
    var col, has;
    if (o.color !== undefined) {
      col = o.color;
      has = args.length ? toBool(args[0]) : true;
    } else if (typeof args[0] === "boolean") {
      col = undefined;
      has = args[0];
    } else {
      col = args[0];
      has = args.length > 0 && !isNa(col);
    }
    if (has) {
      this.plan.bgcolors.push({
        color: colorCss(col !== undefined ? parseColor(col) : "#2962ff"),
        at: this.bar
      });
    }
    return NA;
  };

  function calleeName(e) {
    /* `na(x)` — `na` lexes as a keyword, but it is also a real function
     * (BUILTINS["na"]). Without this the call silently resolved to nothing
     * and returned na whatever the argument held. */
    if (e.k === "na") return "na";
    if (e.k === "ident") return e.name;
    if (e.k === "member") {
      var base = calleeName(e.obj);
      return base ? base + "." + e.name : null;
    }
    return null;
  }
  function seriesBuf(v) {
    if (v && v.__isSeries) return v.__buf.slice();
    return [v];
  }
  function seriesBufOf(v) { return seriesBuf(v); }

  /* The settings dialog is driven by the ids collectInputs() derived at compile
   * time, so the bar loop has to land on the very same id for the same input.
   * Matching on (kind, group, title) against the compiled list is more reliable
   * than re-deriving it here, because a group label is often a variable the
   * compiler could not resolve to a literal. */
  Runtime.prototype.inputIdFor = function (kind, group, title, dflt) {
    if (!this.__inIds) {
      var byKey = Object.create(null), byTitle = Object.create(null);
      var ins = (this.prog && this.prog.inputs) || [];
      for (var i = 0; i < ins.length; i++) {
        var it = ins[i];
        byKey[it.kind + "\u0000" + (it.group || "") + "\u0000" + (it.title || "")] = it.id;
        /* Second chance without the group: a script that builds its group
         * label dynamically leaves the compiler nothing to resolve, so the
         * compiled id carries no group while this call site does. */
        byTitle[it.kind + "\u0000" + (it.title || "")] = it.id;
      }
      this.__inIds = { byKey: byKey, byTitle: byTitle };
    }
    /* `group = GRP_BGA` evaluates to a Series here (a variable *is* a series),
     * so it would never equal the plain string collectInputs() read off the
     * source — unwrap first, or every field named "Enable" in a different
     * group collapses onto one id and the dialog's value is never read. */
    var g = unwrap(group);
    var id = this.__inIds.byKey[kind + "\u0000" + (typeof g === "string" ? g : "") + "\u0000" + (title || "")];
    if (id === undefined) id = this.__inIds.byTitle[kind + "\u0000" + (title || "")];
    return id !== undefined ? id : inputId(kind, g, title, dflt);
  };

  /* Finalise: convert the accumulated plan into a shape the chart consumes. */
  Runtime.prototype.finalise = function () { /* nothing yet — plan is already complete */ };

  /* ------------------------------------------------------------- public --- */
  return {
    compile: compile,
    compileCached: compileCached,
    run: run,
    isNa: isNa,
    NA: NA,
    parseColor: parseColor,
    colorCss: colorCss,
    builtins: Object.keys(BUILTINS),
    version: 1
  };
})();
