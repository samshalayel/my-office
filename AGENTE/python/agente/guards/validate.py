"""MIT-4 / HR-2 / HR-3 — تحقق صارم من كل مخرج نموذج قبل أي كتابة أو عرض، ومن كل إدخال يدوي (MIT-2).
القاعدة: الرفض لا التصحيح — مخرج غير مطابق يُرفض بسبب واضح ويُعاد للنموذج أو يُصعَّد (ضمن سقف HR-4).
لا حقول مخترعة: أي حقل غير موجود في عقد S2 يُرفض.
"""
from __future__ import annotations

import math
import re
from typing import Any, NoReturn, Sequence

from ..jsutil import iso_from_ms, js_str, js_trim, now_ms, parse_date_ms
from ..observability.errors import AppError

RISK_CLASSES = ["low", "medium", "high"]
RISK_RANK = {"low": 0, "medium": 1, "high": 2}
ACTION_KINDS = ["نقل", "تجهيز", "إبلاغ"]


def _reject(why: str) -> NoReturn:
    raise AppError("REJECTED_SCHEMA", why, f"رُفض: {why}")


def _obj(v: Any, what: str) -> dict[str, Any]:
    if not isinstance(v, dict):
        _reject(f"{what} يجب أن يكون كائناً")
    return v


def _only_keys(o: dict[str, Any], allowed: Sequence[str], what: str) -> None:
    extra = [k for k in o if k not in allowed]
    if extra:
        _reject(f"{what}: حقول غير موجودة في العقد ({', '.join(extra)})")


_CTRL = re.compile(r"[\u0000-\u0008\u000B\u000C\u000E-\u001F]")


def text(v: Any, what: str, lo: int, hi: int) -> str:
    """نص آمن: طول محدود وبلا محارف تحكم (لا HTML خام يُنفَّذ — العرض كله مُهرَّب أصلاً)"""
    if not isinstance(v, str):
        _reject(f"{what} نص مطلوب")
    s = js_trim(v)
    if len(s) < lo or len(s) > hi:
        _reject(f"{what} طوله بين {lo} و {hi}")
    if _CTRL.search(s):
        _reject(f"{what} يحوي محارف تحكم")
    return s


def _is_int(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and float(v).is_integer()


def _int(v: Any, what: str, lo: int, hi: int) -> int:
    if not _is_int(v) or v < lo or v > hi:
        _reject(f"{what} عدد صحيح بين {lo} و {hi}")
    return int(v)


def _one_of(v: Any, options: Sequence[str], what: str) -> str:
    if not isinstance(v, str) or v not in options:
        _reject(f"{what} يجب أن يكون واحداً من: {' / '.join(options)}")
    return v


# infant_ref = "<case_ref>#<n>" — يربط الطفل المتوقع بحالته (أساس المقارنة EV-6)
INFANT_REF = re.compile(r"(H-[0-9]{4,6})#([1-9][0-9]?)")


def max_risk(classes: Sequence[str]) -> str:
    m = "low"
    for c in classes:
        if RISK_RANK[c] > RISK_RANK[m]:
            m = c
    return m


def validate_prediction(raw: Any, cases: list[dict[str, Any]], max_infants_per_case: int) -> dict[str, Any]:
    """PredictionDraft من النموذج (C-2): يُتحقق منه مقابل حالات الدورة نفسها.
    - count_value = عدد الأطفال المتوقع وصولهم = طول per_infant (اتساق القيمة والقائمة)
    - risk_class = أعلى فئة بين الأطفال («حرجة» = high — DEC-5 ج)
    - كل infant_ref لحالة في الدورة وبحدود عدد أجنّتها؛ لا تكرار
    - basis.sources = ["TL-1"] حصراً (EV-3 / BR-3)
    - missing_fields: إن ذكرها النموذج فلا يذكر ما ليس ناقصاً؛ القائمة المعتمدة تُحسب من البيانات (EV-2)
    cases: [{case_ref, expected_infants, missing}]
    """
    o = _obj(raw, "التوقع")
    _only_keys(o, ["count_value", "risk_class", "per_infant", "basis", "missing_fields"], "التوقع")
    if not isinstance(o.get("per_infant"), list):
        _reject("per_infant قائمة مطلوبة")
    by_case = {c["case_ref"]: c for c in cases}
    seen: set[str] = set()
    per_infant: list[dict[str, Any]] = []
    for i, p in enumerate(o["per_infant"]):
        e = _obj(p, f"per_infant[{i}]")
        _only_keys(e, ["infant_ref", "apgar_value_estimate", "apgar_class", "basis_ref"], f"per_infant[{i}]")
        ref = text(e.get("infant_ref"), f"per_infant[{i}].infant_ref", 3, 20)
        m = INFANT_REF.fullmatch(ref)
        if not m:
            _reject(f"per_infant[{i}].infant_ref بصيغة H-0001#1")
        c = by_case.get(m.group(1))
        if not c:
            _reject(f"per_infant[{i}]: الحالة {m.group(1)} ليست من حالات الدورة (لا حالات مخترعة)")
        n = int(m.group(2))
        if n > min(c["expected_infants"], max_infants_per_case):
            _reject(f"per_infant[{i}]: {ref} يتجاوز عدد الأجنّة المسجل للحالة")
        if ref in seen:
            _reject(f"per_infant: {ref} مكرر")
        seen.add(ref)
        # null صريح = لا تقدير؛ غياب الحقل = رفض (كما في JavaScript: undefined ليس null)
        if "apgar_value_estimate" in e and e["apgar_value_estimate"] is None:
            est = None
        else:
            est = _int(e.get("apgar_value_estimate"), f"per_infant[{i}].apgar_value_estimate", 0, 10)
        per_infant.append({
            "infant_ref": ref,
            "apgar_value_estimate": est,
            "apgar_class": _one_of(e.get("apgar_class"), RISK_CLASSES, f"per_infant[{i}].apgar_class"),
            "basis_ref": text(e.get("basis_ref"), f"per_infant[{i}].basis_ref", 1, 300),
        })
    count = _int(o.get("count_value"), "count_value", 0, 10_000)
    if count != len(per_infant):
        _reject(f"count_value ({count}) يجب أن يساوي عدد الأطفال في per_infant ({len(per_infant)})")
    derived = max_risk([p["apgar_class"] for p in per_infant])
    risk = _one_of(o.get("risk_class"), RISK_CLASSES, "risk_class")
    if risk != derived:
        _reject(f"risk_class ({risk}) يجب أن يساوي أعلى فئة بين الأطفال ({derived})")

    b = _obj(o.get("basis"), "basis")
    _only_keys(b, ["sources", "weighting_note", "confidence_flag"], "basis")
    src = b.get("sources")
    if not isinstance(src, list) or len(src) != 1 or src[0] != "TL-1":
        _reject('basis.sources يجب أن يكون ["TL-1"] حصراً — لا مصدر خارج سجلات المشفى (EV-3)')
    basis = {
        "sources": ["TL-1"],
        "weighting_note": text(b.get("weighting_note"), "basis.weighting_note", 10, 2000),
        "confidence_flag": _one_of(b.get("confidence_flag"), ["normal", "low"], "basis.confidence_flag"),
    }

    real_missing = {f"{c['case_ref']}.{f}" for c in cases for f in c["missing"]}
    if "missing_fields" in o:
        mf = o["missing_fields"]
        if not isinstance(mf, list):
            _reject("missing_fields قائمة")
        for f in mf:
            if not isinstance(f, str) or f not in real_missing:
                _reject(f"missing_fields: «{js_str(f)}» ليس حقلاً ناقصاً فعلاً")
    # القائمة المعتمدة من البيانات نفسها: الناقص يُعلَّم دائماً ولا يُملأ (EV-2 / HR-3)
    missing = sorted(real_missing)
    if missing and basis["confidence_flag"] != "low":
        _reject("توجد حقول ناقصة: basis.confidence_flag يجب أن يكون low (لا ثقة عادية مع نقص — RT-5)")
    return {"count_value": count, "risk_class": risk, "per_infant": per_infant, "basis": basis, "missing_fields": missing}


def validate_preparation(raw: Any) -> dict[str, Any]:
    """C-4 PreparationDraft.items"""
    o = _obj(raw, "مسودة التحضير")
    _only_keys(o, ["items"], "مسودة التحضير")
    items_raw = o.get("items")
    if not isinstance(items_raw, list) or len(items_raw) < 1 or len(items_raw) > 30:
        _reject("items بين 1 و 30 بنداً")
    items = []
    for i, it in enumerate(items_raw):
        e = _obj(it, f"items[{i}]")
        _only_keys(e, ["item", "qty"], f"items[{i}]")
        item = text(e.get("item"), f"items[{i}].item", 2, 200)
        qty = e.get("qty")
        items.append({"item": item} if qty is None else {"item": item, "qty": _int(qty, f"items[{i}].qty", 0, 100)})
    return {"items": items}


def validate_action(raw: Any, approved: dict[str, Any]) -> dict[str, Any]:
    """C-4/C-7 ActionDraft — مسودة فقط؛ كل فعل مربوط بأطفال من التوقع المعتمد ومبرَّر (EV-4)"""
    o = _obj(raw, "مسودة الفعل")
    _only_keys(o, ["kind", "payload", "alternatives"], "مسودة الفعل")
    kind = _one_of(o.get("kind"), ACTION_KINDS, "kind")
    p = _obj(o.get("payload"), "payload")
    _only_keys(p, ["summary", "infant_refs", "justification"], "payload")
    if not isinstance(p.get("infant_refs"), list) or len(p["infant_refs"]) < 1:
        _reject("payload.infant_refs قائمة غير فارغة")
    known = {x["infant_ref"]: x for x in approved["per_infant"]}
    refs = []
    for i, r in enumerate(p["infant_refs"]):
        s = text(r, f"payload.infant_refs[{i}]", 3, 20)
        if s not in known:
            _reject(f"payload.infant_refs: {s} ليس في التوقع المعتمد")
        refs.append(s)
    # EV-4: لا حجز/نقل لموارد أعلى بلا مبرر من البيانات — يلزم طفل واحد على الأقل بفئة medium أو high
    if kind in ("نقل", "تجهيز") and not any(known[r]["apgar_class"] != "low" for r in refs):
        _reject("لا نقل/تجهيز لموارد أعلى لأطفال كلهم بفئة low — بلا مبرر من البيانات (EV-4)")
    alternatives: list[str] = []
    if "alternatives" in o:
        alts = o["alternatives"]
        if not isinstance(alts, list) or len(alts) > 5:
            _reject("alternatives قائمة حتى 5 بنود")
        alternatives = [text(a, f"alternatives[{i}]", 2, 200) for i, a in enumerate(alts)]
    return {
        "kind": kind,
        "payload": {
            "summary": text(p.get("summary"), "payload.summary", 5, 500),
            "infant_refs": refs,
            "justification": text(p.get("justification"), "payload.justification", 5, 500),
        },
        "alternatives": alternatives,
    }


def validate_decision(raw: dict[str, Any]) -> dict[str, str]:
    """C-8 قرار الإنسان — أزرار ونماذج فقط، السبب إلزامي"""
    return {
        "decision": _one_of(raw.get("decision"), ["approve", "modify", "reject"], "decision"),
        "reason": text(raw.get("reason"), "السبب", 3, 1000),
    }


def validate_outcome_input(raw: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    """MIT-2 — إدخال المقياس الفعلي (TB-2): حقول مقيدة، والنص الحر معزول في الملاحظة"""
    now = now_ms() if now is None else now
    _only_keys(raw, ["case_ref", "birth_datetime", "apgar_value", "note"], "المقياس")
    case_ref = text(raw.get("case_ref"), "رقم الحالة", 3, 12)
    if not re.fullmatch(r"H-[0-9]{4,6}", case_ref):
        _reject("رقم الحالة بصيغة H-0001")
    dt = text(raw.get("birth_datetime"), "وقت الولادة", 10, 40)
    t = parse_date_ms(dt)
    if t is None:
        _reject("وقت الولادة غير صالح")
    if t > now + 10 * 60_000:
        _reject("وقت الولادة في المستقبل")
    if t < parse_date_ms("2020-01-01"):
        _reject("وقت الولادة قديم جداً")
    apgar_raw = raw.get("apgar_value")
    if isinstance(apgar_raw, (int, float)) and not isinstance(apgar_raw, bool):
        apgar_str = js_str(apgar_raw)
    elif isinstance(apgar_raw, str):
        apgar_str = js_trim(apgar_raw)
    else:
        apgar_str = ""
    # رقم صحيح فقط — «17» أو «٧» أو «7.5» أو نص تُرفض ولا تُصحَّح (HR-2 / RT-2)
    if not re.fullmatch(r"[0-9]{1,2}", apgar_str):
        raise AppError("REJECTED_RANGE", f"apgar={apgar_str[:20]}", "مقياس Apgar عدد صحيح من 0 إلى 10 — رُفض ولم يُصحَّح.")
    apgar = int(apgar_str)
    if apgar < 0 or apgar > 10:
        raise AppError("REJECTED_RANGE", f"apgar={apgar}", "مقياس Apgar عدد صحيح من 0 إلى 10 — رُفض ولم يُصحَّح.")
    note_raw = raw.get("note")
    note = None if note_raw is None or js_trim(js_str(note_raw)) == "" else text(note_raw, "الملاحظة", 1, 500)
    return {"case_ref": case_ref, "birth_datetime": iso_from_ms(t), "apgar_value": apgar, "note": note}


def apgar_class(value: int, bands: dict[str, int]) -> str:
    """فئة الخطر من قيمة Apgar وفق نطاقات الإعدادات (قيمة منخفضة = خطر أعلى)"""
    if value <= bands["high_risk_max"]:
        return "high"
    if value <= bands["medium_risk_max"]:
        return "medium"
    return "low"
