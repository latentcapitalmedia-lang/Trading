"""Parser for Chartink-style scan clauses.

Accepted syntax::

    ( [volume] > 5000000 and [rsi(14)] < 30 )
    [sma(20)] crossed above [sma(50)] or [macd_histogram] > 0
    not [market_cap] < 100000000
    [adx(14)] > 25 and [plus di]            # bare field means "> 0"

Brackets are optional (``rsi(14) < 30`` works too) and double brackets such as
``[[volume]]`` are normalised, mirroring Chartink's own notation.
"""

from __future__ import annotations

import re


class ClauseError(ValueError):
    """Raised when a clause cannot be parsed."""

    def __init__(self, message, pos=None):
        super().__init__(message)
        self.message = message
        self.pos = pos


_TOKEN_RE = re.compile(
    r"""
      (?P<field>\[\s*[^\[\]]+\s*\])
    | (?P<number>-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)
    | (?P<word>[A-Za-z_][A-Za-z0-9_]*)
    | (?P<op>>=|<=|==|!=|>|<|=)
    | (?P<lparen>\()
    | (?P<rparen>\))
    | (?P<comma>,)
    | (?P<ws>\s+)
    | (?P<other>.)
    """,
    re.VERBOSE,
)

_CROSS_WORDS = {
    ("crossed", "above"): "crossed above",
    ("crossed", "below"): "crossed below",
    ("cross", "above"): "crossed above",
    ("cross", "below"): "crossed below",
    ("crosses", "above"): "crossed above",
    ("crosses", "below"): "crossed below",
}

_COMPARE_OPS = {">", "<", ">=", "<=", "=", "==", "!="}


# --------------------------------------------------------------------------
# candle offsets
#
# A field operand may carry a per-filter offset prefix::
#
#     [<state>] [<tf>] <field-operand>
#
# e.g. ``current 4h [close] > 100`` or ``2nd closed weekly [volume] > 5``.
# The default offset (closed daily) is omitted from the AST entirely so
# ordinary clauses keep their original shape.
# --------------------------------------------------------------------------

DEFAULT_OFFSET = {"state": "closed", "tf": "1d"}
STATES = ("current", "closed", "2nd closed", "3rd closed")
TIMEFRAMES = ("5m", "15m", "30m", "45m", "1h", "2h", "3h", "4h", "1d", "1w", "1M", "1y")

_INTRADAY_TF = ("5m", "15m", "30m", "45m", "1h", "2h", "3h", "4h")
_WORD_TF = {"1d": "daily", "1w": "weekly", "1M": "monthly", "1y": "yearly"}
_TF_WORDS = {v: k for k, v in _WORD_TF.items()}
_UNIT_WORDS = {
    "m": "m", "min": "m", "mins": "m", "minute": "m", "minutes": "m",
    "h": "h", "hr": "h", "hrs": "h", "hour": "h", "hours": "h",
}
_ORDINALS = ("st", "nd", "rd", "th")
_MINUTE_TF_VALUES = (5, 15, 30, 45)
_HOUR_TF_VALUES = (1, 2, 3, 4)
_STATE_BY_COUNT = {1: "closed", 2: "2nd closed", 3: "3rd closed"}


def make_offset(state=None, tf=None):
    """Build a validated offset dict (raises :class:`ClauseError` if invalid)."""
    state = DEFAULT_OFFSET["state"] if state is None else state
    tf = DEFAULT_OFFSET["tf"] if tf is None else tf
    if state not in STATES:
        raise ClauseError(
            f"unknown candle state {state!r}; use one of {', '.join(STATES)}"
        )
    if tf not in TIMEFRAMES:
        raise ClauseError(
            f"unknown timeframe {tf!r}; use one of {', '.join(TIMEFRAMES)}"
        )
    return {"state": state, "tf": tf}


def is_default_offset(offset):
    """True when the offset is the implicit closed-daily default."""
    offset = offset or {}
    return offset.get("state", "closed") == "closed" and offset.get("tf", "1d") == "1d"


def offset_of(node):
    """The offset of a field node, materialised as a dict."""
    offset = node.get("offset")
    if not offset:
        return dict(DEFAULT_OFFSET)
    return {"state": offset.get("state") or "closed", "tf": offset.get("tf") or "1d"}


def tf_text(tf):
    """Human/keyword form of a timeframe: ``1d`` -> ``daily``, ``4h`` -> ``4h``."""
    return _WORD_TF.get(tf, tf)


def offset_text(offset):
    """``'current 4h'`` rendering, empty string for the default offset."""
    if is_default_offset(offset):
        return ""
    return f"{offset.get('state', 'closed')} {tf_text(offset.get('tf', '1d'))}"


def offset_suffix(offset):
    """Compact ``@current4h`` style suffix used in ids / cache keys.

    Unique per ``(state, tf)`` and empty for the default offset.  Intraday
    timeframes are glued to the state (``rsi(14)@current4h``) while the daily,
    weekly, monthly and yearly keywords get a space (``volume@2nd closed
    weekly``).
    """
    if is_default_offset(offset):
        return ""
    state = offset.get("state", "closed")
    tf = offset.get("tf", "1d")
    sep = "" if tf in _INTRADAY_TF else " "
    return f"@{state}{sep}{tf_text(tf)}"


def spec_id(field, params, offset=None):
    """``<field>(<params>)`` plus the offset suffix (``rsi(14)@current4h``).

    A field without parameters keeps the bare name (``volume@2nd closed
    weekly``), matching the ids the scanner exposes for plan fields.
    """
    params_text = ",".join(str(p) for p in params)
    body = f"{field}({params_text})" if params else field
    return body + offset_suffix(offset)


def normalise(text):
    """Strip Chartink's doubled brackets around field references."""
    out = []
    i = 0
    while i < len(text):
        if text[i] == "[" and i + 1 < len(text) and text[i + 1] == "[":
            out.append("[")
            i += 2
            continue
        if text[i] == "]" and i + 1 < len(text) and text[i + 1] == "]":
            out.append("]")
            i += 2
            continue
        out.append(text[i])
        i += 1
    return "".join(out)


def _tokenize(text):
    tokens = []
    pos = 0
    while pos < len(text):
        m = _TOKEN_RE.match(text, pos)
        if not m:
            raise ClauseError("unexpected character", pos)
        kind = m.lastgroup
        value = m.group()
        if kind == "ws":
            pos = m.end()
            continue
        if kind == "other":
            raise ClauseError(f"unexpected character {value!r}", pos)
        tokens.append({"kind": kind, "value": value, "pos": pos})
        pos = m.end()
    return tokens


def _parse_field(raw, pos):
    name = raw.strip().strip("[]").strip()
    if not name:
        raise ClauseError("empty field reference", pos)
    name = re.sub(r"\s+", "", name).lower()
    m = re.match(r"^([a-z_][a-z0-9_]*)(?:\(([^)]*)\))?$", name)
    if not m:
        raise ClauseError(f"bad field reference [{raw.strip()}]", pos)
    base = m.group(1)
    params = []
    if m.group(2) is not None and m.group(2).strip():
        for chunk in m.group(2).split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            try:
                params.append(float(chunk) if "." in chunk else int(chunk))
            except ValueError:
                raise ClauseError(f"bad parameter {chunk!r} in [{raw.strip()}]", pos)
    return {"field": base, "params": params}


def _as_int(tok):
    """Integer value of a number token, or None when it is not a plain int."""
    value = tok["value"]
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    return None


def _apply_offset(node, offset):
    """Attach an offset to every field node of a (sub-)expression."""
    kind = node.get("t")
    if kind == "field":
        if "offset" not in node:
            node["offset"] = dict(offset)
    elif kind in ("and", "or"):
        for kid in node["kids"]:
            _apply_offset(kid, offset)
    elif kind == "not":
        _apply_offset(node["kid"], offset)
    elif kind == "cmp":
        _apply_offset(node["left"], offset)
        right = node.get("right")
        if isinstance(right, dict) and right.get("t"):
            _apply_offset(right, offset)


def _normalise_offsets(node):
    """Validate offset keys on a hand-built AST, dropping the default one."""
    kind = node.get("t")
    if kind == "field":
        raw = node.get("offset")
        if raw is not None:
            offset = make_offset(raw.get("state"), raw.get("tf"))
            if is_default_offset(offset):
                del node["offset"]
            else:
                node["offset"] = offset
    elif kind in ("and", "or"):
        for kid in node["kids"]:
            _normalise_offsets(kid)
    elif kind == "not":
        _normalise_offsets(node["kid"])
    elif kind == "cmp":
        _normalise_offsets(node["left"])
        right = node.get("right")
        if isinstance(right, dict) and right.get("t"):
            _normalise_offsets(right)


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def peek(self, offset=0):
        j = self.i + offset
        return self.tokens[j] if j < len(self.tokens) else None

    def next(self):
        tok = self.peek()
        if tok is None:
            raise ClauseError("unexpected end of clause")
        self.i += 1
        return tok

    def _at(self, offset):
        return self.tokens[offset] if 0 <= offset < len(self.tokens) else None

    def expect_rparen(self):
        tok = self.peek()
        if tok is None or tok["kind"] != "rparen":
            raise ClauseError("missing closing parenthesis", tok["pos"] if tok else None)
        self.i += 1

    # expression hierarchy: or -> and -> not -> comparison
    def parse(self):
        if not self.tokens:
            raise ClauseError("clause is empty")
        node = self.parse_or()
        if self.i < len(self.tokens):
            tok = self.peek()
            raise ClauseError(f"unexpected {tok['value']!r}", tok["pos"])
        return node

    def parse_or(self):
        node = self.parse_and()
        while True:
            tok = self.peek()
            if tok and tok["kind"] == "word" and tok["value"].lower() in ("or", "||"):
                self.next()
                node = {"t": "or", "kids": [node, self.parse_and()]}
            else:
                return node

    def parse_and(self):
        node = self.parse_not()
        while True:
            tok = self.peek()
            if tok and tok["kind"] == "word" and tok["value"].lower() in ("and", "&&"):
                self.next()
                node = {"t": "and", "kids": [node, self.parse_not()]}
            else:
                return node

    def parse_not(self):
        tok = self.peek()
        if tok and tok["kind"] == "word" and tok["value"].lower() in ("not", "!"):
            self.next()
            return {"t": "not", "kid": self.parse_not()}
        return self.parse_comparison()

    def parse_comparison(self):
        left, is_group = self._operand()
        # A parenthesised group (possibly behind an offset prefix) is already a
        # complete expression.
        if is_group:
            return left

        tok = self.peek()
        if tok is None:
            return self._bare(left)

        if tok["kind"] == "op" and tok["value"] in _COMPARE_OPS:
            self.next()
            op = {"=": "==", "==": "==", "!=": "!="}.get(tok["value"], tok["value"])
            right, _ = self._operand()
            return {"t": "cmp", "left": left, "op": op, "right": right}

        if tok["kind"] == "word":
            word = tok["value"].lower()
            nxt = self.peek(1)
            if nxt and nxt["kind"] == "word":
                phrase = _CROSS_WORDS.get((word, nxt["value"].lower()))
                if phrase:
                    self.next()
                    self.next()
                    right, _ = self._operand()
                    return {
                        "t": "cmp",
                        "left": left,
                        "op": phrase,
                        "right": right,
                    }
            if word in ("and", "or"):
                # The connective belongs to the enclosing and/or parser.
                return self._bare(left)
            raise ClauseError(f"unknown operator {tok['value']!r}", tok["pos"])

        if tok["kind"] == "rparen":
            return self._bare(left)

        raise ClauseError(
            f"expected an operator, found {tok['value']!r}", tok["pos"]
        )

    @staticmethod
    def _bare(left):
        """A field with no operator is treated as ``field > 0``."""
        if isinstance(left, dict) and left.get("t") == "field":
            return {
                "t": "cmp",
                "left": left,
                "op": ">",
                "right": {"t": "num", "v": 0},
            }
        raise ClauseError("expected an operator after the value")

    def _operand(self):
        """Parse one operand, consuming an optional ``[state] [tf]`` prefix.

        Returns ``(node, was_group)``.  The prefix is only consumed when it is
        actually followed by an operand start, so ordinary clauses such as
        ``[rsi(14)] < 30`` are left untouched.
        """
        offset = self._scan_offset()
        node, is_group = self._primary()
        if offset is not None and not is_default_offset(offset):
            if node.get("t") == "field":
                node["offset"] = dict(offset)
            elif is_group:
                _apply_offset(node, offset)
            else:
                raise ClauseError(
                    "a candle offset must be followed by a field reference"
                )
        return node, is_group

    def _scan_offset(self):
        """Consume ``[<state>] [<tf>] `` before an operand if present.

        Returns the offset dict (possibly the default) when the prefix was
        consumed, otherwise ``None`` and the tokens are left alone.
        """
        i = self.i
        state = None
        tf = None
        error = None
        error_pos = None
        tok = self._at(i)

        # --- state: current | closed | [n][st|nd|rd|th] closed ---
        if tok is not None and tok["kind"] == "word":
            word = tok["value"].lower()
            if word in ("current", "closed"):
                state = word
                i += 1
        elif tok is not None and tok["kind"] == "number":
            n = _as_int(tok)
            j = i + 1
            nxt = self._at(j)
            if nxt is not None and nxt["kind"] == "word" and nxt["value"].lower() in _ORDINALS:
                j += 1
                nxt = self._at(j)
            if nxt is not None and nxt["kind"] == "word" and nxt["value"].lower() == "closed":
                if n in _STATE_BY_COUNT:
                    state = _STATE_BY_COUNT[n]
                else:
                    error = (
                        f"unsupported closed-bar count {tok['value']}; use "
                        f"'closed', '2nd closed' or '3rd closed'"
                    )
                    error_pos = tok["pos"]
                i = j + 1

        # --- timeframe: <n><unit> | daily | weekly | monthly | yearly ---
        if error is None:
            tok = self._at(i)
            if tok is not None and tok["kind"] == "word" and tok["value"].lower() in _TF_WORDS:
                tf = _TF_WORDS[tok["value"].lower()]
                i += 1
            elif tok is not None and tok["kind"] == "number":
                n = _as_int(tok)
                nxt = self._at(i + 1)
                raw = nxt["value"] if nxt is not None and nxt["kind"] == "word" else None
                if raw is not None and f"{n}{raw}" in _WORD_TF:
                    # canonical ids of the keyword timeframes: 1d, 1w, 1M, 1y
                    tf = f"{n}{raw}"
                    i += 2
                elif raw is not None and raw.lower() in _UNIT_WORDS:
                    unit = _UNIT_WORDS[raw.lower()]
                    allowed = _MINUTE_TF_VALUES if unit == "m" else _HOUR_TF_VALUES
                    if n in allowed:
                        tf = f"{n}{unit}"
                    else:
                        error = (
                            f"unsupported intraday timeframe "
                            f"'{tok['value']}{raw.lower()}'; use one of "
                            "5m, 15m, 30m, 45m, 1h, 2h, 3h, 4h"
                        )
                        error_pos = tok["pos"]
                    i += 2

        # A prefix only counts when an operand actually follows it.
        nxt = self._at(i)
        if nxt is None:
            return None
        follows_operand = (
            nxt["kind"] == "field"
            or nxt["kind"] == "lparen"
            or (nxt["kind"] == "word" and nxt["value"].lower() not in ("and", "or", "not"))
        )
        if not follows_operand:
            return None
        if state is None and tf is None and error is None:
            return None
        if error is not None:
            raise ClauseError(error, error_pos)
        self.i = i
        return {"state": state or "closed", "tf": tf or "1d"}

    def _primary(self):
        """Parse a number / field / parenthesised group (no offset prefix)."""
        tok = self.peek()
        if tok is None:
            raise ClauseError("unexpected end of clause")

        if tok["kind"] == "number":
            self.next()
            return {"t": "num", "v": float(tok["value"])}, False

        if tok["kind"] == "field":
            self.next()
            return {"t": "field", **_parse_field(tok["value"], tok["pos"])}, False

        if tok["kind"] == "lparen":
            self.next()
            node = self.parse_or()
            self.expect_rparen()
            return node, True

        if tok["kind"] == "word":
            # bare identifier, optionally with parameters: rsi(14) or volume
            nxt = self.peek(1)
            word = tok["value"]
            if nxt and nxt["kind"] == "lparen" and word.lower() not in (
                "and", "or", "not"
            ):
                raw = self._consume_call()
                return {"t": "field", **_parse_field(raw, tok["pos"])}, False
            if word.lower() in ("and", "or", "not"):
                raise ClauseError(f"unexpected {word!r}", tok["pos"])
            self.next()
            return {"t": "field", "field": word.lower(), "params": []}, False

        raise ClauseError(f"unexpected {tok['value']!r}", tok["pos"])

    def _consume_call(self):
        name = self.next()["value"]
        buf = [name, self.next()["value"]]  # name + '('
        depth = 1
        while depth:
            tok = self.next()
            buf.append(tok["value"])
            if tok["kind"] == "lparen":
                depth += 1
            elif tok["kind"] == "rparen":
                depth -= 1
        return "".join(buf)


def parse(clause):
    """Parse a clause string into an AST. Raises :class:`ClauseError`."""
    if isinstance(clause, dict):
        _normalise_offsets(clause)
        return clause
    if not isinstance(clause, str):
        raise ClauseError("clause must be a string")
    text = normalise(clause).strip()
    if not text:
        raise ClauseError("clause is empty")
    return _Parser(_tokenize(text)).parse()


def collect_fields(ast, from_fields=None):
    """Walk the AST and return the de-duplicated field specs it needs."""
    found = from_fields if from_fields is not None else []

    def walk(node):
        t = node.get("t")
        if t == "field":
            offset = offset_of(node)
            spec = {
                "field": node["field"],
                "params": _apply_defaults(node.get("params") or []),
                "state": offset["state"],
                "tf": offset["tf"],
            }
            spec["cache_key"] = spec["id"] = _spec_key(spec, offset)
            if all(existing["cache_key"] != spec["cache_key"] for existing in found):
                found.append(spec)
        elif t in ("and", "or"):
            for kid in node["kids"]:
                walk(kid)
        elif t == "not":
            walk(node["kid"])
        elif t == "cmp":
            walk(node["left"])
            if isinstance(node.get("right"), dict) and node["right"].get("t"):
                walk(node["right"])

    walk(ast)
    return found


def _apply_defaults(params):
    # defaults are attached later by the scanner once field defs are known
    return list(params)


def _spec_key(spec, offset=None):
    if offset is None:
        offset = make_offset(spec.get("state"), spec.get("tf"))
    return spec_id(spec["field"], spec["params"], offset)


def pretty(ast):
    """Render an AST back into clause text (used to show the normalised scan)."""
    t = ast.get("t")
    if t == "field":
        params = ",".join(str(p) for p in ast["params"])
        body = f"[{ast['field']}({params})]" if ast["params"] else f"[{ast['field']}]"
        prefix = offset_text(offset_of(ast))
        return f"{prefix} {body}" if prefix else body
    if t == "num":
        v = ast["v"]
        return str(int(v)) if float(v).is_integer() else str(v)
    if t == "and":
        return "(" + " and ".join(pretty(k) for k in ast["kids"]) + ")"
    if t == "or":
        return "(" + " or ".join(pretty(k) for k in ast["kids"]) + ")"
    if t == "not":
        return "not " + pretty(ast["kid"])
    if t == "cmp":
        return f"{pretty(ast['left'])} {ast['op']} {pretty(ast['right'])}"
    raise ClauseError(f"unknown node {t!r}")
