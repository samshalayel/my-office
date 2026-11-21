"""MIT-5 / HR-5 / DEC-13 ب — إخفاء الهوية قبل النموذج، والمخرجات بالرقم المرجعي فقط.
+ MIT-1 (جزء): كشف تعليمات مدسوسة داخل البيانات (تُعلَّم للإنسان ولا تُنفَّذ).
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from ..jsutil import jdump, js_trim
from ..observability.errors import AppError
from ..observability.trace import PII_PATTERNS, whole_word

__all__ = ["identity_tokens", "whole_word", "redact_text", "find_pii", "assert_no_pii", "injection_flag"]


def identity_tokens(values: Iterable[Any]) -> dict[str, list[str]]:
    """قيم الهوية من سجل المصدر:
    - strong: القيمة كاملة (الاسم الكامل، رقم الهوية، الجوال، رقم الملف) — ظهورها في أي مخرج = تسرّب يوقف العملية
    - weak: أجزاء الاسم (الاسم الأول، اسم العائلة) — تُحجب من النص الحر والسجلات فقط، ولا توقف شيئاً
      (أسماء عربية كثيرة كلمات عادية: «أمل»، «نور» — منعها من المخرجات يعطّل الوكيل بلا فائدة)
    """
    strong: dict[str, None] = {}
    weak: dict[str, None] = {}
    for v in values:
        if v is None:
            continue
        s = js_trim(v if isinstance(v, str) else _js_string(v))
        if len(s) >= 3:
            strong[s] = None
        parts = [js_trim(x) for x in re.split(r"[\s,،]+", s)]
        parts = [x for x in parts if len(x) >= 3]
        if len(parts) > 1:
            for part in parts:
                weak[part] = None
    by_len = lambda x: -len(x)  # noqa: E731
    return {
        "strong": sorted(strong, key=by_len),
        "weak": sorted((w for w in weak if w not in strong), key=by_len),
    }


def _js_string(v: Any) -> str:
    from ..jsutil import js_str

    return js_str(v)


def redact_text(text: str, identities: Iterable[str]) -> dict[str, Any]:
    s = text
    for ident in identities:
        if ident:
            s = whole_word(ident).sub("[محجوب]", s)
    for rx in PII_PATTERNS:
        s = rx.sub("[محجوب]", s)
    return {"text": s, "redacted": s != text}


def find_pii(text: str, identities: Iterable[str]) -> list[str]:
    """يعيد ما وُجد من معرفات (فارغ = نظيف)"""
    found: list[str] = []
    for ident in identities:
        if ident and whole_word(ident).search(text):
            found.append(ident)
    for rx in PII_PATTERNS:
        found.extend(m.group(0) for m in rx.finditer(text))
    return found


def assert_no_pii(payload: Any, identities: Iterable[str], where: str) -> None:
    """يمنع خروج أي معرف شخصي (قبل استدعاء النموذج، وقبل عرض/كتابة مخرجاته)"""
    text = payload if isinstance(payload, str) else jdump(payload)
    found = find_pii(text, identities)
    if found:
        raise AppError("PII_DETECTED", f"{where}: {len(found)} match(es)")


# MIT-1: عبارات أوامر داخل بيانات المصدر — للتنبيه البشري فقط (البيانات لا تُنفَّذ أصلاً)
INJECTION_HINTS = [
    re.compile(r"تجاهل|تجاوز (?:ال)?(?:تعليمات|حساب|قواعد)|صنّ?ف كل|احذف|أوص[ِي]? بحجز|اعتمد (?:التوقع|كل)|نفّ?ذ"),
    re.compile(r"ignore (?:all |the |previous |prior )?(?:instructions|rules)|system prompt|you are now|disregard|override|jailbreak", re.I),
]


def injection_flag(text: str | None) -> str | None:
    if not text:
        return None
    return "تعليمات مشبوهة داخل البيانات — عوملت كنص فقط" if any(rx.search(text) for rx in INJECTION_HINTS) else None
