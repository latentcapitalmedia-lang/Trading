"""Turn the live-TradingView icon capture into static/tvicons.js.

Reads the raw JSON the browser returned (every flyout row's verbatim SVG)
and emits `window.TV_ICONS = { ourToolId: '<svg …>' }` so chartview.js can
merge them into its ICON table without anyone retyping path data.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DUMP = os.path.join(
    os.environ.get("USERPROFILE", ""),
    r".local\share\opencode\tool-output\tool_10eed8c1c0010gi2ICbJIWNsUn",
)
OUT = os.path.join(ROOT, "static", "tvicons.js")

# TradingView's data-name  ->  our tool id (ids we already own stay put)
MAP = {
    # G0 cursors
    "cursor": "cursor", "dot": "dot", "arrow": "cursarrow",
    "demonstration": "demo", "performance": "magic", "eraser": "delete",
    # G1 trend tools
    "LineToolTrendLine": "trend", "LineToolRay": "ray",
    "LineToolInfoLine": "infoline", "LineToolExtended": "extline",
    "LineToolTrendAngle": "trendangle", "LineToolHorzLine": "hline",
    "LineToolHorzRay": "hray", "LineToolVertLine": "vline",
    "LineToolCrossLine": "crossline", "LineToolParallelChannel": "channel",
    "LineToolRegressionTrend": "regression", "LineToolFlatBottom": "flattop",
    "LineToolDisjointAngle": "disjoint", "LineToolPitchfork": "pitchfork",
    "LineToolSchiffPitchfork2": "schiff", "LineToolSchiffPitchfork": "schiffmod",
    "LineToolInsidePitchfork": "insidepf",
    # G2 gann + fibonacci
    "LineToolFibRetracement": "fib", "LineToolTrendBasedFibExtension": "fibext",
    "LineToolFibChannel": "fibchannel", "LineToolFibTimeZone": "fibtime",
    "LineToolFibSpeedResistanceFan": "fibfan",
    "LineToolTrendBasedFibTime": "fibtimeext",
    "LineToolFibCircles": "fibcircles", "LineToolFibSpiral": "fibspiral",
    "LineToolFibSpeedResistanceArcs": "fibarcs", "LineToolFibWedge": "fibwedge",
    "LineToolPitchfan": "pitchfan", "LineToolGannSquare": "gannbox",
    "LineToolGannFixed": "gannfixed", "LineToolGannComplex": "gannsquare",
    "LineToolGannFan": "gannfan",
    # G3 patterns
    "LineTool5PointsPattern": "xabcd", "LineToolCypherPattern": "cypher",
    "LineToolHeadAndShoulders": "headshoulders", "LineToolABCD": "abcd",
    "LineToolTrianglePattern": "tripattern",
    "LineToolThreeDrivers": "threedrivers",
    "LineToolElliottImpulse": "elliot5", "LineToolElliottCorrection": "elliot3",
    "LineToolElliottTriangle": "elliottri",
    "LineToolElliottDoubleCombo": "elliotwxy",
    "LineToolElliottTripleCombo": "elliotwxyxz",
    "LineToolCircleLines": "cycliclines", "LineToolTimeCycles": "timecycles",
    "LineToolSineLine": "sine",
    # G4 forecasting / volume / measurers
    "LineToolRiskRewardLong": "longpos", "LineToolRiskRewardShort": "shortpos",
    "LineToolPrediction": "forecast", "LineToolBarsPattern": "barspattern",
    "LineToolGhostFeed": "ghostfeed", "LineToolProjection": "sector",
    "LineToolAnchoredVWAP": "avwap",
    "LineToolFixedRangeVolumeProfile": "frvp",
    "LineToolAnchoredVolumeProfile": "avp",
    "LineToolPriceRange": "pricerange", "LineToolDateRange": "daterange",
    "LineToolDateAndPriceRange": "dpr",
    # G5 geometric shapes
    "LineToolBrush": "brush", "LineToolHighlighter": "highlighter",
    "LineToolArrowMarker": "marker", "LineToolArrow": "arrow",
    "LineToolArrowMarkUp": "arrowup", "LineToolArrowMarkDown": "arrowdown",
    "LineToolRectangle": "rect", "LineToolRotatedRectangle": "rotrect",
    "LineToolPath": "path", "LineToolCircle": "circle",
    "LineToolEllipse": "ellipse", "LineToolPolyline": "polyline",
    "LineToolTriangle": "tri", "LineToolArc": "arc",
    "LineToolBezierQuadro": "curve", "LineToolBezierCubic": "doublecurve",
    # G6 annotations
    "LineToolText": "text", "LineToolTextNote": "note",
    "LineToolPriceNote": "pricenote", "LineToolNote": "pin",
    "LineToolTable": "table", "LineToolCallout": "callout",
    "LineToolComment": "comment", "LineToolPriceLabel": "pricelabel",
    "LineToolSignpost": "signpost", "LineToolFlagMark": "flag",
    "LineToolImage": "image", "LineToolTweet": "post",
    "LineToolIdea": "idea",
    # G7 icons
    "LineToolStickers": "sticker",
}

SELF_CLOSING = {"circle", "rect", "line", "ellipse", "polygon", "polyline"}


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


def element(spec):
    """'path:M0 0h10|' -> <path d="M0 0h10"/> ; 'circle:|cx=2,cy=3,r=1' -> …"""
    tag, _, rest = spec.partition(":")
    content, _, attr_text = rest.partition("|")
    if tag in SELF_CLOSING:
        attrs = "".join(
            ' %s="%s"' % (k, esc(v))
            for k, v in (p.split("=", 1) for p in attr_text.split(",") if "=" in p)
        )
        return "<%s%s/>" % (tag, attrs)
    return '<path d="%s"/>' % esc(content)


def build():
    with open(DUMP, encoding="utf-8") as fh:
        raw = json.load(fh)
    out = {}
    for tv_name, spec in sorted(raw.items()):
        our = MAP.get(tv_name)
        if not our or not spec:
            continue
        vb = (spec.get("vb") or "0 0 28 28").strip() or "0 0 28 28"
        body = "".join(element(s) for s in spec.get("body") or [])
        out[our] = '<svg viewBox="%s" fill="currentColor">%s</svg>' % (vb, body)

    js = (
        "/* TradingView's own drawing-tool glyphs, captured verbatim from the\n"
        "   live rail flyouts (28px grid). Generated by tools/gen_tvicons.py —\n"
        "   edit that, not this file. chartview.js merges it into ICON. */\n"
        "window.TV_ICONS = " + json.dumps(out, indent=0, sort_keys=True) + ";\n"
    )
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(js)
    return out


if __name__ == "__main__":
    if not os.path.exists(DUMP):
        print("dump not found:", DUMP)
        sys.exit(1)
    icons = build()
    print("wrote %s with %d icons" % (OUT, len(icons)))
    print(", ".join(sorted(icons)))
