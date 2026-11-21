"""نقاط الإنسان HITL-1/2/3 — عرض C-5/C-6/C-7 بالأساس والنواقص (MIT-6 / HR-3)، وقرار مهيكل حصراً (C-8 / C-9).
لا نص حر كقرار، السبب إلزامي، هوية الموافق من الجلسة. كل قرار → decisions + hitl_log (BASE-A6) + audit (C-12) في معاملة واحدة.
HITL-3: الموافقة تُسجَّل وتنقل التنفيذ للإنسان خارج النظام (END-2)؛ الرفض END-1. لا تنفيذ آلي (DEC-9).

المتابعات (التحضير بعد الاعتماد، دورة جديدة بعد إعادة التقييم) تبدأ فوراً كمهام asyncio وتُعاد للمستدعي لينتظرها إن شاء
(كما تبدأ Promise في JavaScript).
"""
from __future__ import annotations

import asyncio
from typing import Any, Coroutine

from ..agents.agt1 import cases_for_cycle, run_cycle, run_prepare
from ..guards.pii import assert_no_pii
from ..guards.validate import validate_decision, validate_prediction
from ..jsutil import jdump
from ..observability.errors import AppError
from ..storage.db import Db, next_daily_ref, now_iso, q1, tx, write_audit
from ..tools.tl2_predictions import case_infos, get_prediction, to_draft
from ..tools.tl3_outcomes import get_discrepancy, get_outcome
from ..tools.tl4_drafts import get_draft, list_drafts
from .alerts import resolve_alerts


class _Done:
    """نتيجة منتهية قابلة للانتظار (await) — للاستدعاء المتزامن بلا حلقة asyncio جارية"""

    def __init__(self, result: Any):
        self._r = result

    def __await__(self):  # type: ignore[no-untyped-def]
        return self._r
        yield  # noqa: unreachable — يجعلها مولّداً

    def done(self) -> bool:
        return True

    def result(self) -> Any:
        return self._r


def spawn(coro: Coroutine[Any, Any, Any]) -> Any:
    """يبدأ المتابعة الآن على الحلقة الجارية؛ بلا حلقة جارية (استدعاء متزامن) تُنفَّذ حتى النهاية فوراً"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return _Done(asyncio.run(coro))
    return loop.create_task(coro)


def package_c5(app: Any, ref: str) -> dict[str, Any]:
    """C-5 — S2 حرفياً (+ تفاصيل الأساس والحالات للعرض)"""
    p = get_prediction(app.db, ref)
    if not p:
        raise AppError("NOT_FOUND", ref)
    c5 = {
        "cycle_id": p["cycle_id"], "prediction_ref": p["prediction_ref"], "count_value": p["count_value"], "risk_class": p["risk_class"],
        "per_infant": p["per_infant"], "basis_summary": p["basis"].get("weighting_note"), "missing_fields": p["missing_fields"],
        "critical_alert": p["risk_class"] == "high", "batch_deadline": p["batch_deadline"],
    }
    # HR-3: لا عرض لتوقع بلا أساس
    if not p["basis"] or not p["basis"].get("weighting_note") or not p["basis"].get("sources"):
        raise AppError("REJECTED_SCHEMA", "no basis", "لا يُعرض توقع بلا أساس موثق.")
    assert_no_pii(c5, list(app.identities), "C-5")
    return {"c5": c5, "prediction": p, "basis": p["basis"], "cases": cases_for_cycle(app, p["cycle_id"])}


def package_c6(app: Any, ref: str) -> dict[str, Any]:
    """C-6"""
    d = get_discrepancy(app.db, ref)
    if not d:
        raise AppError("NOT_FOUND", ref)
    o = get_outcome(app.db, d["actual_ref"])
    pr = d["predicted"]
    c6 = {
        "discrepancy_ref": d["discrepancy_ref"], "prediction_ref": d["prediction_ref"],
        "predicted": {"count_value": pr["count_value"], "risk_class": pr["risk_class"]} if pr else None,
        "actual": {"apgar_value": o["apgar_value"], "apgar_class": o["apgar_class"]},
        "class_mismatch": d["class_mismatch"], "resources_reserved": d["resources_reserved"], "escalate": d["escalated"],
    }
    unplanned = d["prediction_ref"] == "UNPLANNED"
    reserved = [] if unplanned else list_drafts(app.db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", d["prediction_ref"])
    return {"c6": c6, "discrepancy": d, "outcome": o, "reserved": reserved,
            "prediction": None if unplanned else get_prediction(app.db, d["prediction_ref"])}


def package_c7(app: Any, ref: str) -> dict[str, Any]:
    """C-7"""
    d = get_draft(app.db, ref)
    if not d or d["draft_type"] != "action":
        raise AppError("NOT_FOUND", ref)
    c7 = {"action_draft_ref": d["draft_ref"], "kind": d["action_kind"], "payload_summary": (d["payload"] or {}).get("summary", ""),
          "based_on": d["based_on"], "alternatives": d["alternatives"]}
    return {"c7": c7, "draft": d, "prediction": get_prediction(app.db, d["based_on"])}


def _decision_ref(db: Db) -> str:
    return next_daily_ref(db, "HD", "decisions", "decision_id")


def _log_hitl(db: Db, hitl: str, subject_ref: str, shown: Any, decision_id: str, decided_by: str, decision: str, reason: str, after: str) -> None:
    db.execute("""INSERT INTO hitl_log (ts, hitl, subject_ref, shown_json, decision_id, decided_by, decision, reason, after_effect)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", (now_iso(), hitl, subject_ref, jdump(shown), decision_id, decided_by, decision, reason, after))


def _apply_edit(db: Db, p: dict[str, Any], edit: dict[str, Any], max_infants: int) -> dict[str, Any]:
    """تعديل الإنسان: قائمة الأطفال بعد تعديله (الفئة/التقدير/الحذف) → PredictionDraft يمر بنفس تحقق MIT-4.
    edit = {per_infant: [{infant_ref, apgar_class, apgar_value_estimate, keep}], note}"""
    kept = [i for i in edit["per_infant"] if i["keep"]]
    original = {i["infant_ref"]: i for i in p["per_infant"]}
    for k in edit["per_infant"]:
        if k["infant_ref"] not in original:
            raise AppError("REJECTED_SCHEMA", f"unknown infant {k['infant_ref']}")
    order = ["low", "medium", "high"]
    per = [{"infant_ref": k["infant_ref"], "apgar_value_estimate": k["apgar_value_estimate"], "apgar_class": k["apgar_class"],
            "basis_ref": original[k["infant_ref"]]["basis_ref"]} for k in kept]
    risk = "low"
    for x in per:
        if (order.index(x["apgar_class"]) if x["apgar_class"] in order else -1) > order.index(risk):
            risk = x["apgar_class"]
    return validate_prediction({
        "count_value": len(per), "risk_class": risk, "per_infant": per,
        "basis": {**p["basis"], "weighting_note": f"{p['basis']['weighting_note']}\n— عدّله الإنسان: {edit['note']}"[:2000]},
    }, case_infos(db, p["cycle_id"]), max_infants)


def decide_hitl1(app: Any, inp: dict[str, Any], user: str) -> dict[str, Any]:
    """HITL-1: اعتماد / تعديل / رفض التوقع. الاعتماد أو التعديل يفعّل مسودة التحضير (run_prepare)"""
    db, cfg = app.db, app.cfg
    d = validate_decision(inp)
    p = get_prediction(db, inp.get("prediction_ref"))
    if not p:
        raise AppError("NOT_FOUND", str(inp.get("prediction_ref")))
    if p["status"] != "draft":
        raise AppError("FORBIDDEN_MODIFY_APPROVED", p["prediction_ref"], "قُرر هذا التوقع من قبل.")
    shown = package_c5(app, p["prediction_ref"])["c5"]
    modified = _apply_edit(db, p, inp.get("edit") or {"per_infant": [], "note": ""}, cfg["caps"]["max_infants_per_case"]) if d["decision"] == "modify" else None
    status = {"approve": "approved", "modify": "modified"}.get(d["decision"], "rejected")

    def write() -> str:
        did = _decision_ref(db)
        at = now_iso()
        if modified:
            db.execute("""UPDATE predictions SET count_value = ?, risk_class = ?, per_infant_json = ?, basis_json = ?, missing_fields_json = ?,
                          status = 'modified', updated_at = ? WHERE prediction_ref = ?""",
                       (modified["count_value"], modified["risk_class"], jdump(modified["per_infant"]), jdump(modified["basis"]),
                        jdump(modified["missing_fields"]), at, p["prediction_ref"]))
        else:
            db.execute("UPDATE predictions SET status = ?, updated_at = ? WHERE prediction_ref = ?", (status, at, p["prediction_ref"]))
        db.execute("""INSERT INTO decisions (decision_id, hitl, subject_ref, decision, modified_payload_json, reason, decided_by, decided_at)
                      VALUES (?, 'HITL-1', ?, ?, ?, ?, ?, ?)""",
                   (did, p["prediction_ref"], d["decision"], jdump({**to_draft(p), **modified, "status": "modified"}) if modified else None,
                    d["reason"], user, at))
        db.execute("UPDATE cycles SET status = ? WHERE cycle_id = ?", ("rejected" if status == "rejected" else "approved", p["cycle_id"]))
        after = "التوقع مرفوض — لا استخدام له (BR-1)؛ يمكن تشغيل دورة جديدة" if status == "rejected" else "التوقع معتمد — بدأ تجهيز مسودة التحضير (TL-4)"
        _log_hitl(db, "HITL-1", p["prediction_ref"], shown, did, user, d["decision"], d["reason"], after)
        write_audit(db, f"human:{user}", "decision", p["prediction_ref"], f"HITL-1:{d['decision']}", before={"status": p["status"]},
                    after={"status": status, "decision_id": did, **({"modified": modified} if modified else {})}, reason=d["reason"])
        return did

    did = tx(db, write)
    resolve_alerts(app, p["prediction_ref"], user)
    return {"decision_id": did, "prepare": None if status == "rejected" else spawn(run_prepare(app, p["prediction_ref"]))}


def decide_hitl2(app: Any, inp: dict[str, Any], user: str) -> dict[str, Any]:
    """HITL-2: قرار الخلاف — الخيارات الثلاثة تُسجَّل على Decision.decision (DEV-5):
    إبقاء = approve (السبب إلزامي — EV-7) · تعديل توزيع = modify (توقع جديد يعدّله الإنسان + تحضير جديد) · إعادة تقييم = reject (دورة توقع جديدة)
    """
    db, cfg = app.db, app.cfg
    d = validate_decision(inp)
    pk = package_c6(app, inp.get("discrepancy_ref"))
    if not pk["discrepancy"]["escalated"]:
        raise AppError("BAD_REQUEST", "not escalated", "هذا الفارق لم يُصعَّد — لا يحتاج قرار HITL-2.")
    if q1(db, "SELECT 1 AS x FROM decisions WHERE hitl = 'HITL-2' AND subject_ref = ?", inp["discrepancy_ref"]):
        raise AppError("FORBIDDEN_MODIFY_APPROVED", inp["discrepancy_ref"], "قُرر هذا الخلاف من قبل.")
    p = pk["prediction"]
    new_ref: list[str | None] = [None]
    modified = _apply_edit(db, p, inp.get("edit") or {"per_infant": [], "note": ""}, cfg["caps"]["max_infants_per_case"]) \
        if d["decision"] == "modify" and p else None
    if d["decision"] == "modify" and not modified:
        raise AppError("BAD_REQUEST", "nothing to modify", "لا توقع معتمد لتعديل توزيعه.")

    def write() -> str:
        did = _decision_ref(db)
        at = now_iso()
        if modified and p:
            new_ref[0] = next_daily_ref(db, "P", "predictions", "prediction_ref")
            db.execute("""INSERT INTO predictions (prediction_ref, cycle_id, count_value, risk_class, per_infant_json, basis_json, missing_fields_json,
                          status, origin, supersedes, run_id, model, prompt_version, batch_deadline, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, 'modified', 'human', ?, ?, NULL, NULL, NULL, ?, ?)""",
                       (new_ref[0], p["cycle_id"], modified["count_value"], modified["risk_class"], jdump(modified["per_infant"]),
                        jdump(modified["basis"]), jdump(modified["missing_fields"]), p["prediction_ref"], f"hitl2-{did}", at, at))
            for old in list_drafts(db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", p["prediction_ref"]):
                db.execute("UPDATE drafts SET status = 'superseded', updated_at = ? WHERE draft_ref = ?", (at, old["draft_ref"]))
                write_audit(db, f"human:{user}", "draft", old["draft_ref"], "supersede", after={"by_prediction": new_ref[0]})
        db.execute("""INSERT INTO decisions (decision_id, hitl, subject_ref, decision, modified_payload_json, reason, decided_by, decided_at, outcome)
                      VALUES (?, 'HITL-2', ?, ?, ?, ?, ?, ?, ?)""",
                   (did, inp["discrepancy_ref"], d["decision"], jdump(modified) if modified else None, d["reason"], user, at, new_ref[0]))
        if d["decision"] == "approve":
            after = "إبقاء التوزيع مع السبب المسجل"
        elif d["decision"] == "modify":
            after = f"توقع معدَّل {new_ref[0]} يحل محل {p['prediction_ref'] if p else 'undefined'} — تحضير جديد"
        else:
            after = "إعادة تقييم — دورة توقع جديدة تنتظر HITL-1"
        _log_hitl(db, "HITL-2", inp["discrepancy_ref"], pk["c6"], did, user, d["decision"], d["reason"], after)
        write_audit(db, f"human:{user}", "decision", inp["discrepancy_ref"], f"HITL-2:{d['decision']}",
                    after={"decision_id": did, "new_prediction": new_ref[0]}, reason=d["reason"])
        return did

    did = tx(db, write)
    resolve_alerts(app, inp["discrepancy_ref"], user)
    followup = None
    if d["decision"] == "modify" and new_ref[0]:
        followup = spawn(run_prepare(app, new_ref[0]))
    elif d["decision"] == "reject":
        followup = spawn(run_cycle(app, trigger="reassess", actor=f"human:{user}"))
    return {"decision_id": did, "followup": followup}


def decide_hitl3(app: Any, inp: dict[str, Any], user: str) -> dict[str, Any]:
    """HITL-3: موافقة → END-2 (تنفيذ بيد الإنسان خارج النظام) / رفض → END-1. لا عودة للوكيل (DEC-8)"""
    db = app.db
    d = validate_decision(inp)
    if d["decision"] == "modify":
        raise AppError("BAD_REQUEST", "HITL-3 modify", "HITL-3: موافقة أو رفض فقط.")
    pk = package_c7(app, inp.get("draft_ref"))
    if pk["draft"]["status"] != "pending":
        raise AppError("FORBIDDEN_MODIFY_APPROVED", inp["draft_ref"], "قُررت هذه المسودة من قبل.")
    end = "END_2_HUMAN_EXECUTES" if d["decision"] == "approve" else "END_1_NOT_EXECUTED"

    def write() -> str:
        did = _decision_ref(db)
        at = now_iso()
        db.execute("UPDATE drafts SET status = ?, updated_at = ? WHERE draft_ref = ?", ("approved" if d["decision"] == "approve" else "rejected", at, inp["draft_ref"]))
        db.execute("INSERT INTO decisions (decision_id, hitl, subject_ref, decision, reason, decided_by, decided_at, outcome) VALUES (?, 'HITL-3', ?, ?, ?, ?, ?, ?)",
                   (did, inp["draft_ref"], d["decision"], d["reason"], user, at, end))
        after = "END-2: التنفيذ بيد الإنسان خارج النظام — النظام لم ينفّذ شيئاً" if end == "END_2_HUMAN_EXECUTES" else "END-1: لا تنفيذ"
        _log_hitl(db, "HITL-3", inp["draft_ref"], pk["c7"], did, user, d["decision"], d["reason"], after)
        write_audit(db, f"human:{user}", "decision", inp["draft_ref"], f"HITL-3:{d['decision']}", after={"decision_id": did, "end_state": end}, reason=d["reason"])
        return did

    did = tx(db, write)
    resolve_alerts(app, inp["draft_ref"], user)
    return {"decision_id": did, "end_state": end}


def c9_for(db: Db, draft_ref: str) -> dict[str, Any] | None:
    """C-9 — نهاية الدورة لمسودة فعل"""
    return q1(db, "SELECT decision_id, decision, decided_by, decided_at, outcome FROM decisions WHERE hitl = 'HITL-3' AND subject_ref = ?", draft_ref)


def decision_for(db: Db, hitl: str, subject: str) -> dict[str, Any] | None:
    return q1(db, "SELECT * FROM decisions WHERE hitl = ? AND subject_ref = ? ORDER BY decided_at DESC LIMIT 1", hitl, subject)
