"""BASE-10 — معالجة أخطاء موحدة: رمز ثابت (للعقود والاختبارات) + رسالة عربية مفهومة للمستخدم.
التفاصيل التقنية تبقى في سجل الخادم ولا تظهر في الواجهة (لا stack trace).
"""
from __future__ import annotations

import sys
import traceback
from datetime import datetime, timezone
from typing import Callable

from ..jsutil import iso

MESSAGES: dict[str, str] = {
    "SOURCE_UNAVAILABLE": "سجلات المشفى غير متاحة الآن — توقفت الدورة بلا توقع (لا مصدر بديل).",
    "REJECTED_SCHEMA": "البيانات لا تطابق البنية المعتمدة — رُفضت ولم يُكتب شيء.",
    "FORBIDDEN_MODIFY_APPROVED": "هذا السجل معتمد ولا يُعدَّل — أي تصحيح يمر بقرار إنساني مسجل.",
    "REJECTED_RANGE": "قيمة خارج المدى المسموح — رُفضت ولم تُصحَّح.",
    "UNKNOWN_CASE": "رقم الحالة غير معروف في سجلات الدورة.",
    "REJECTED_NOT_APPROVED": "المسودة يجب أن تُبنى على توقع معتمد من الإنسان.",
    "KILL_SWITCH": "مفتاح الإيقاف مفعّل — العملية متوقفة حتى يعيد صاحب الحضانة تشغيلها.",
    "CAP_EXCEEDED": "تجاوزت الدورة سقفها المحدد — توقفت بأمان وصُعّد الأمر للإنسان.",
    "TIMEOUT": "انتهت المهلة المحددة — توقفت العملية بأمان.",
    "PII_DETECTED": "اكتُشف معرف شخصي في بيانات خارجة — أُوقفت العملية حمايةً للخصوصية.",
    "FORBIDDEN_TOOL": "الأداة غير مسموحة لهذا الطرف أو في هذه المرحلة.",
    "NEEDS_REEVAL": "النموذج أو التعليمات تغيّرت منذ آخر تقييم ناجح — شغّل التقييم أولاً (python -m agente eval --live).",
    "MODEL_ERROR": "تعذّر الحصول على رد صالح من النموذج.",
    "CONFIG_INVALID": "الإعدادات ناقصة أو غير صالحة.",
    "TRACE_FAILED": "تعذّر تسجيل التتبع — لا تشغيل بلا تتبّع، توقفت العملية.",
    "DUPLICATE": "هذا الإدخال مسجل من قبل.",
    "NOT_FOUND": "غير موجود.",
    "UNAUTHORIZED": "يلزم تسجيل الدخول.",
    "CSRF": "انتهت صلاحية النموذج — حدّث الصفحة وحاول مرة ثانية.",
    "RATE_LIMITED": "محاولات كثيرة — انتظر قليلاً ثم حاول.",
    "BAD_REQUEST": "طلب غير صالح.",
    "INTERNAL": "حدث خطأ غير متوقع — سُجّل للمراجعة.",
}

STATUS: dict[str, int] = {
    "NOT_FOUND": 404, "UNAUTHORIZED": 401, "CSRF": 403, "FORBIDDEN_TOOL": 403, "RATE_LIMITED": 429,
    "BAD_REQUEST": 400, "REJECTED_SCHEMA": 422, "REJECTED_RANGE": 422, "UNKNOWN_CASE": 422, "DUPLICATE": 409,
    "FORBIDDEN_MODIFY_APPROVED": 409, "REJECTED_NOT_APPROVED": 409, "KILL_SWITCH": 503, "SOURCE_UNAVAILABLE": 503,
}


class AppError(Exception):
    def __init__(self, code: str, detail: str = "", user_message: str | None = None):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail
        self.user_message = user_message or MESSAGES[code]
        self.status = STATUS.get(code, 500)


def as_app_error(e: BaseException) -> AppError:
    if isinstance(e, AppError):
        return e
    msg = str(e) or type(e).__name__
    return AppError("INTERNAL", msg)


def log_server_error(where: str, e: BaseException, scrub: Callable[[str], str] = lambda s: s) -> None:
    """سطر سجل الخادم: تفاصيل كاملة للمطوّر — يمر عبر منقّي الأسرار قبل الكتابة"""
    err = as_app_error(e)
    lines = "".join(traceback.format_exception(type(e), e, e.__traceback__)).strip().split("\n")
    stack = " | ".join(lines[-6:]) if len(lines) > 1 else ""
    ts = iso(datetime.now(timezone.utc))
    print(scrub(f"[AGENTE] {ts} {where} {err.code} {err.detail}{' :: ' + stack if stack else ''}"), file=sys.stderr)
