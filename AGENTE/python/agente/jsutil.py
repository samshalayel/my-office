"""مساعدات صغيرة تطابق سلوك JavaScript في النسخة الأصلية (TypeScript) حيث يهم التطابق:
JSON مضغوط بلا هروب للعربية، تحويل الأرقام والنصوص، التواريخ بصيغة toISOString، والتقريب.
"""
from __future__ import annotations

import json
import math
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

# المسافات التي يحذفها String.prototype.trim في JavaScript
_JS_WS = "\t\n\u000b\u000c\r                  　﻿"


def js_trim(s: str) -> str:
    return s.strip(_JS_WS)


def _norm(v: Any) -> Any:
    """أرقام عشرية صحيحة القيمة تُكتب كأعداد صحيحة (JavaScript لا يفرّق: 31.0 === 31)"""
    if isinstance(v, float) and math.isfinite(v) and v.is_integer() and abs(v) < 1e15:
        return int(v)
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_norm(x) for x in v]
    return v


def jdump(v: Any, indent: int | None = None) -> str:
    """JSON.stringify: مضغوط، والعربية كما هي"""
    if indent:
        return json.dumps(_norm(v), ensure_ascii=False, indent=indent)
    return json.dumps(_norm(v), ensure_ascii=False, separators=(",", ":"))


def js_str(v: Any) -> str:
    """String(v) في JavaScript"""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        if v.is_integer() and abs(v) < 1e21:
            return str(int(v))
        return repr(v)
    if isinstance(v, (list, tuple)):
        return ",".join("" if x is None else js_str(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


_NUM = re.compile(r"[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|Infinity)", re.ASCII)


def js_number(v: Any) -> float:
    """Number(v) في JavaScript (مبسّط: لا ست عشري)"""
    if v is None:
        return 0.0
    if v is True:
        return 1.0
    if v is False:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = js_trim(str(v))
    if s == "":
        return 0.0
    if re.fullmatch(r"0[xX][0-9a-fA-F]+", s):
        return float(int(s, 16))
    if _NUM.fullmatch(s):
        return float(s.replace("Infinity", "inf"))
    return math.nan


def is_finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def js_round(x: float) -> int:
    """Math.round: النصف يُقرَّب للأعلى"""
    return math.floor(x + 0.5)


def iso(dt: datetime) -> str:
    """Date.prototype.toISOString: 2026-11-20T03:40:00.000Z"""
    u = dt.astimezone(timezone.utc)
    return u.strftime("%Y-%m-%dT%H:%M:%S.") + f"{u.microsecond // 1000:03d}Z"


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def iso_from_ms(ms: float) -> str:
    return iso(datetime.fromtimestamp(ms / 1000, tz=timezone.utc))


_ISO_DT = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?", re.ASCII
)


def parse_date_ms(s: str) -> float | None:
    """Date.parse لصيغ ISO 8601 (التاريخ وحده = UTC، التاريخ والوقت بلا منطقة = توقيت الخادم المحلي، كما في JavaScript).
    صيغ غير ISO تُرفض (None)."""
    m = _ISO_DT.fullmatch(js_trim(s))
    if not m:
        return None
    y, mo, d, hh, mi, ss, frac, tz = m.groups()
    y, mo, d = int(y), int(mo), int(d)
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    try:
        base = date(y, mo, 1) + timedelta(days=d - 1)  # V8 يقبل 31 لكل شهر ويُرحّل الزائد
    except (ValueError, OverflowError):
        return None
    if hh is None:
        return datetime(base.year, base.month, base.day, tzinfo=timezone.utc).timestamp() * 1000
    h, mi_, s_ = int(hh), int(mi), int(ss or 0)
    if h > 24 or mi_ > 59 or s_ > 59 or (h == 24 and (mi_ or s_ or frac)):
        return None
    ms = int((frac or "0").ljust(3, "0")[:3])
    naive = datetime(base.year, base.month, base.day) + timedelta(hours=h, minutes=mi_, seconds=s_, milliseconds=ms)
    if tz is None:
        return naive.astimezone().timestamp() * 1000  # توقيت الخادم المحلي
    if tz == "Z":
        off = timedelta(0)
    else:
        sign = -1 if tz[0] == "-" else 1
        digits = tz[1:].replace(":", "")
        off = sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
    return naive.replace(tzinfo=timezone(off)).timestamp() * 1000


def local_date(d: datetime | None = None) -> str:
    d = (d or datetime.now()).astimezone()
    return f"{d.year}-{d.month:02d}-{d.day:02d}"


def encode_uri_component(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="-_.!~*'()")
