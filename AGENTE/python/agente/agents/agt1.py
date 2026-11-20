"""AGT-1 — وكيل التوقع والتحضير (الجراف المعتمد في S1، DEC-8/DEC-9):
 UF-1 run_cycle   : TL-1 → توقع (نموذج) → TL-2 → C-5 إلى HITL-1 (دفعة يومية + تنبيه فوري للفئة high — DEC-5 ج)
 UF-1 run_prepare : بعد اعتماد HITL-1 فقط → مسودة تحضير (TL-4) + مسودات فعل تنتظر HITL-3
 UF-2 compare_outcome : حساب حتمي بلا نموذج — مقارنة كل مقياس بتوقعه (EV-6) وتصعيد الخلاف حين توجد موارد محجوزة (EV-4/EV-7)
لا أداة تنفيذ إطلاقاً (DEC-9 / HR-6).
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from ..config.config import resolve_path
from ..guards.caps import Budget
from ..guards.killswitch import assert_enabled
from ..guards.pii import assert_no_pii
from ..guards.validate import max_risk
from ..hitl.alerts import raise_alert
from ..jsutil import iso, js_number, js_str, local_date
from ..observability.errors import AppError, as_app_error, log_server_error
from ..observability.trace import new_run_id
from ..storage.db import now_iso, q1, tx, write_audit
from ..tools.registry import ToolCtx, invoke
from ..tools.tl1_cases import TL1_READ, cycle_cases
from ..tools.tl2_predictions import TL2_WRITE, get_prediction, list_predictions, to_draft
from ..tools.tl3_outcomes import TL3_DISCREPANCY, get_outcome, list_discrepancies
from ..tools.tl4_drafts import TL4_ACTION, TL4_PREPARATION, list_drafts
from .context import AppContext
from .loop import AgentTool, as_data, run_tool_loop
from .model import build_model
from .prompts import load_prompt


def model_for(app: AppContext) -> Any:
    return app.model_override if app.model_override is not None else build_model(app.cfg)


def eval_status(app: AppContext, model: Any, prompt_version: str) -> dict[str, Any]:
    """MIT-8: لا تشغيل بنموذج/تعليمات تغيّرت منذ آخر تقييم ناجح"""
    if model.kind != "live":
        return {"ok": True, "reason": model.kind}
    file = resolve_path(app.cfg, app.cfg["paths"]["eval_baseline"])
    try:
        with open(file, encoding="utf-8") as fh:
            b = json.load(fh)
        if (b.get("model") == app.cfg["model"]["model"] and b.get("fallback_model") == app.cfg["model"]["fallback_model"]
                and b.get("prompt_version") == prompt_version and b.get("passed") is True):
            return {"ok": True, "reason": f"baseline {b.get('at')}"}
        return {"ok": False, "reason": f"آخر تقييم ناجح كان على {js_str(b.get('model'))}/{js_str(b.get('prompt_version'))}"}
    except (OSError, ValueError, AttributeError):
        return {"ok": False, "reason": "لا يوجد تقييم ناجح بعد"}


def _deadline_for(app: AppContext, as_of: str) -> str:
    """موعد دفعة HITL-1 بتوقيت الخادم المحلي (new Date(`${asOf}T09:00:00`) في النسخة الأصلية)"""
    try:
        return iso(datetime.fromisoformat(f"{as_of}T{app.cfg['schedule']['batch_deadline_time']}:00").astimezone())
    except ValueError as e:
        raise AppError("REJECTED_SCHEMA", "as_of", "تاريخ الدورة غير صالح.") from e


async def run_cycle(app: AppContext, as_of: str | None = None, trigger: str = "manual", actor: str | None = None) -> dict[str, Any]:
    """UF-1: دورة التوقع (مجدولة يومياً، أو يدوياً، أو إعادة تقييم من HITL-2)"""
    db, cfg = app.db, app.cfg
    as_of = as_of or local_date()
    n = q1(db, "SELECT COUNT(*) AS n FROM cycles WHERE as_of = ?", as_of)["n"]
    cycle_id = f"{as_of}#{n + 1}"
    run_id = new_run_id("c")
    deadline = _deadline_for(app, as_of)
    db.execute("INSERT INTO cycles (cycle_id, as_of, status, run_id, started_at, batch_deadline) VALUES (?, ?, 'running', ?, ?, ?)",
               (cycle_id, as_of, run_id, now_iso(), deadline))
    tx(db, lambda: write_audit(db, actor or "system", "cycle", cycle_id, f"start:{trigger}"))

    ctx = ToolCtx(app=app, run_id=run_id, actor="AGT-1", actor_name="AGT-1")
    model = model_for(app)
    try:
        assert_enabled(cfg, "model")
        prompt = load_prompt(cfg, "AGT-1")
        ev = eval_status(app, model, prompt.version)
        if not ev["ok"]:
            raise AppError("NEEDS_REEVAL", ev["reason"])
        state: dict[str, Any] = {"read": None, "submitted": None}

        async def read_cases(args: dict[str, Any]) -> Any:
            if state["read"] is not None:
                return state["read"]  # HR-4: استدعاء واحد لكل دورة — التكرار يعيد النتيجة نفسها
            if args.get("as_of") != as_of:
                raise AppError("REJECTED_SCHEMA", "as_of", f"تاريخ الدورة {as_of} حصراً.")
            wd = args.get("window_days")
            r = await invoke(TL1_READ, ctx, {"cycle_id": cycle_id, "as_of": as_of, "window_days": js_number(wd) if wd is not None or "window_days" in args else float("nan")})
            cases = r["cases"] if cfg["privacy"]["send_notes_to_model"] else [{**c, "notes_raw": None} for c in r["cases"]]
            state["read"] = as_data("TB-1 سجلات المشفى", {
                "cases": cases, "source_system": r["source_system"], "fetched_at": r["fetched_at"],
                "expected_infants_note": "indicators.expected_infants = عدد الأجنّة (null = غير مسجل، يُحسب 1)"})
            return state["read"]

        async def submit(args: dict[str, Any]) -> Any:
            if state["read"] is None:
                raise AppError("REJECTED_SCHEMA", "read first", "اقرأ الحالات أولاً بأداة read_pregnancy_cases.")
            r = await invoke(TL2_WRITE, ctx, {"cycle_id": cycle_id, "draft": args, "model": model.model_id,
                                              "prompt_version": prompt.version, "batch_deadline": deadline})
            state["submitted"] = r["prediction_ref"]
            return r

        tools = [
            AgentTool(spec={
                "name": "read_pregnancy_cases",
                "description": "TL-1: يقرأ حوامل نافذة الأسبوع الأخير من سجلات المشفى (مرة واحدة في الدورة). المدخل {as_of, window_days}.",
                "parameters": {"type": "object", "properties": {"as_of": {"type": "string"}, "window_days": {"type": "integer"}},
                               "required": ["as_of", "window_days"], "additionalProperties": False},
            }, run=read_cases),
            AgentTool(spec={
                "name": "submit_prediction",
                "description": "TL-2: يسجل مسودة التوقع {count_value, risk_class, per_infant[], basis{sources, weighting_note, confidence_flag}, missing_fields?}.",
                "parameters": {
                    "type": "object", "additionalProperties": False, "required": ["count_value", "risk_class", "per_infant", "basis"],
                    "properties": {
                        "count_value": {"type": "integer", "minimum": 0},
                        "risk_class": {"type": "string", "enum": ["low", "medium", "high"]},
                        "per_infant": {"type": "array", "items": {
                            "type": "object", "additionalProperties": False, "required": ["infant_ref", "apgar_value_estimate", "apgar_class", "basis_ref"],
                            "properties": {"infant_ref": {"type": "string"}, "apgar_value_estimate": {"type": ["integer", "null"], "minimum": 0, "maximum": 10},
                                           "apgar_class": {"type": "string", "enum": ["low", "medium", "high"]}, "basis_ref": {"type": "string"}}}},
                        "basis": {"type": "object", "additionalProperties": False, "required": ["sources", "weighting_note", "confidence_flag"],
                                  "properties": {"sources": {"type": "array", "items": {"type": "string", "enum": ["TL-1"]}},
                                                 "weighting_note": {"type": "string"}, "confidence_flag": {"type": "string", "enum": ["normal", "low"]}}},
                        "missing_fields": {"type": "array", "items": {"type": "string"}},
                    },
                },
            }, run=submit),
        ]
        await run_tool_loop(app, run_id=run_id, prompt=prompt, model=model, budget=Budget(cfg), tools=tools,
                            user=f'دورة {cycle_id}. as_of="{as_of}" window_days={cfg["window_days"]}. اقرأ الحالات ثم أرسل التوقع.')
        if not state["submitted"]:
            raise AppError("MODEL_ERROR", "no prediction submitted", "لم يسجل الوكيل توقعاً صالحاً ضمن سقف الدورة.")
        p = get_prediction(db, state["submitted"])
        # MIT-4 / HR-3 / HR-5 قبل العرض: الأساس موجود، النواقص معلّمة، لا معرفات
        assert_no_pii(to_draft(p), list(app.identities), "C-5 package")
        db.execute("UPDATE cycles SET status = 'awaiting_hitl1', finished_at = ? WHERE cycle_id = ?", (now_iso(), cycle_id))
        if p["risk_class"] == "high":
            raise_alert(app, "critical", p["prediction_ref"],
                        f"حالة حرجة: التوقع {p['prediction_ref']} فيه طفل متوقع بفئة high — يحتاج قرارك الآن (لا ينتظر دفعة الصباح).")
        return {"cycle_id": cycle_id, "status": "awaiting_hitl1", "prediction_ref": p["prediction_ref"]}
    except Exception as e:
        err = as_app_error(e)
        log_server_error(f"cycle {cycle_id}", e, app.tracer.scrub)
        status = "stopped" if err.code == "KILL_SWITCH" else "failed"
        db.execute("UPDATE cycles SET status = ?, finished_at = ?, error_code = ?, error_detail = ? WHERE cycle_id = ?",
                   (status, now_iso(), err.code, app.tracer.scrub(err.detail)[:500], cycle_id))
        raise_alert(app, "cycle_failed", cycle_id, f"الدورة {cycle_id} لم تكتمل: {err.user_message}")
        return {"cycle_id": cycle_id, "status": status, "error": {"code": err.code, "message": err.user_message}}


async def run_prepare(app: AppContext, prediction_ref: str) -> dict[str, Any]:
    """UF-1 الخطوة 5 + UF-3 الخطوة 1: مسودات على توقع معتمد حصراً"""
    cfg, db = app.cfg, app.db
    run_id = new_run_id("p")
    ctx = ToolCtx(app=app, run_id=run_id, actor="AGT-1", actor_name="AGT-1")
    model = model_for(app)
    drafts: list[str] = []
    try:
        prompt = load_prompt(cfg, "AGT-1")
        ev = eval_status(app, model, prompt.version)
        if not ev["ok"]:
            raise AppError("NEEDS_REEVAL", ev["reason"])
        p = get_prediction(db, prediction_ref)
        if not p or p["status"] not in ("approved", "modified"):
            raise AppError("REJECTED_NOT_APPROVED", prediction_ref)

        async def get_approved(_args: dict[str, Any]) -> Any:
            q = get_prediction(db, prediction_ref)
            return as_data("TB-3 توقع معتمد من الإنسان", dict(to_draft(q)))

        async def create_prep(args: dict[str, Any]) -> Any:
            r = await invoke(TL4_PREPARATION, ctx, {"based_on": prediction_ref, "draft": args})
            drafts.append(r["draft_ref"])
            return r

        async def create_action(args: dict[str, Any]) -> Any:
            r = await invoke(TL4_ACTION, ctx, {"based_on": prediction_ref, "draft": args})
            drafts.append(r["draft_ref"])
            raise_alert(app, "hitl3", r["draft_ref"], f"مسودة فعل لا رجعة فيه {r['draft_ref']} تنتظر موافقتك (HITL-3).")
            return r

        tools = [
            AgentTool(spec={"name": "get_approved_prediction", "description": "TL-2 (قراءة): التوقع المعتمد الذي يُبنى عليه التحضير.",
                            "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}, run=get_approved),
            AgentTool(spec={
                "name": "create_preparation_draft", "description": "TL-4: مسودة تحضير {items:[{item, qty}]} — مسودة فقط لا تنفيذ.",
                "parameters": {"type": "object", "additionalProperties": False, "required": ["items"], "properties": {"items": {
                    "type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["item"],
                                               "properties": {"item": {"type": "string"}, "qty": {"type": "integer", "minimum": 0}}}}}},
            }, run=create_prep),
            AgentTool(spec={
                "name": "create_action_draft",
                "description": "TL-4: مسودة فعل لا رجعة فيه تنتظر موافقة HITL-3 {kind: نقل|تجهيز|إبلاغ, payload:{summary, infant_refs[], justification}, alternatives[]}.",
                "parameters": {
                    "type": "object", "additionalProperties": False, "required": ["kind", "payload"],
                    "properties": {
                        "kind": {"type": "string", "enum": ["نقل", "تجهيز", "إبلاغ"]},
                        "payload": {"type": "object", "additionalProperties": False, "required": ["summary", "infant_refs", "justification"],
                                    "properties": {"summary": {"type": "string"}, "infant_refs": {"type": "array", "items": {"type": "string"}},
                                                   "justification": {"type": "string"}}},
                        "alternatives": {"type": "array", "items": {"type": "string"}},
                    },
                },
            }, run=create_action),
        ]
        await run_tool_loop(app, run_id=run_id, prompt=prompt, model=model, budget=Budget(cfg), tools=tools,
                            user=f"التوقع {prediction_ref} اعتمده الإنسان. جهّز مسودة التحضير، ومسودات الأفعال التي تحتاج موافقة إن لزم.")
        if not list_drafts(db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", prediction_ref):
            raise_alert(app, "model", prediction_ref, f"لم تُنشأ مسودة تحضير للتوقع {prediction_ref} — راجع وأعد المحاولة.")
        return {"ok": True, "drafts": drafts}
    except Exception as e:
        err = as_app_error(e)
        log_server_error(f"prepare {prediction_ref}", e, app.tracer.scrub)
        raise_alert(app, "model", prediction_ref, f"تعذّر تجهيز مسودات التوقع {prediction_ref}: {err.user_message}")
        return {"ok": False, "drafts": drafts, "error": err.user_message}


def _prediction_for_case(app: AppContext, case_ref: str) -> dict[str, Any] | None:
    """التوقع المعتمد الأحدث الذي يتضمن هذه الحالة"""
    for p in list_predictions(app.db, "status IN ('approved','modified')"):
        if any(i["infant_ref"].startswith(f"{case_ref}#") for i in p["per_infant"]):
            return p
    return None


async def compare_outcome(app: AppContext, actual_ref: str) -> dict[str, Any]:
    """UF-2 / EV-6 / EV-7 / EV-4: مقارنة حتمية (بلا نموذج) بعد كل ولادة.
    - الربط: infant_ref = "<case_ref>#<n>"؛ المولود الأول للحالة يقابل #1، الثاني #2... (لا عدّ مزدوج: مقارنة واحدة لكل زوج)
    - خلاف = فئة المولود الفعلية ≠ الفئة المتوقعة له؛ مولود لم يُتوقع = خلاف أيضاً
    - التصعيد إلى HITL-2 فقط إن كان للتوقع موارد محجوزة (مسودة تحضير نشطة) — وإلا يُسجَّل فقط (BR-2)
    - مقياس لحالة بلا توقع معتمد → «UNPLANNED» يُسجَّل وينبَّه عليه ولا يفتح HITL-2
    """
    db = app.db
    o = get_outcome(db, actual_ref)
    if not o:
        raise AppError("NOT_FOUND", actual_ref)
    ctx = ToolCtx(app=app, run_id=new_run_id("m"), actor="AGT-1", actor_name="AGT-1")
    p = _prediction_for_case(app, o["case_ref"])
    if not p:
        r = await invoke(TL3_DISCREPANCY, ctx, {"prediction_ref": "UNPLANNED", "actual_ref": actual_ref, "infant_ref": None, "predicted": None,
                                                 "class_mismatch": True, "resources_reserved": False, "escalated": False})
        raise_alert(app, "unplanned", actual_ref, f"ولادة للحالة {o['case_ref']} بلا توقع معتمد سابق — سُجّلت كفارق غير مبرمج.")
        return {"discrepancy_ref": r["discrepancy_ref"], "class_mismatch": True, "escalated": False}
    earlier = q1(db, "SELECT COUNT(*) AS n FROM outcomes WHERE case_ref = ? AND (birth_datetime < ? OR (birth_datetime = ? AND actual_ref < ?))",
                 o["case_ref"], o["birth_datetime"], o["birth_datetime"], actual_ref)["n"]
    infant_ref = f"{o['case_ref']}#{earlier + 1}"
    infant = next((i for i in p["per_infant"] if i["infant_ref"] == infant_ref), None)
    mismatch = not infant or infant["apgar_class"] != o["apgar_class"]
    reserved = len(list_drafts(db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", p["prediction_ref"])) > 0
    escalate = mismatch and reserved
    r = await invoke(TL3_DISCREPANCY, ctx, {
        "prediction_ref": p["prediction_ref"], "actual_ref": actual_ref, "infant_ref": infant_ref if infant else None,
        "predicted": {"count_value": p["count_value"], "risk_class": p["risk_class"],
                      "infant_class": infant["apgar_class"] if infant else None,
                      "apgar_value_estimate": infant["apgar_value_estimate"] if infant else None},
        "class_mismatch": mismatch, "resources_reserved": reserved, "escalated": escalate,
    })
    if escalate:
        raise_alert(app, "hitl2", r["discrepancy_ref"],
                    f"خلاف على توقع حُجزت له موارد ({p['prediction_ref']} ↔ {actual_ref}): المتوقع {infant['apgar_class'] if infant else 'لم يُتوقع'} والفعلي {o['apgar_class']} — يحتاج قرارك (HITL-2).")
    return {"discrepancy_ref": r["discrepancy_ref"], "class_mismatch": mismatch, "escalated": escalate}


def open_escalations(app: AppContext) -> list[dict[str, Any]]:
    """الخلافات المفتوحة التي تنتظر قرار HITL-2"""
    return list_discrepancies(app.db, "escalated = 1 AND discrepancy_ref NOT IN (SELECT subject_ref FROM decisions WHERE hitl = 'HITL-2')")


def cases_for_cycle(app: AppContext, cycle_id: str) -> list[dict[str, Any]]:
    """حالات الدورة للعرض (مع علم الملاحظات المشبوهة)"""
    return cycle_cases(app.db, cycle_id)


def risk_of(classes: list[str]) -> str:
    return max_risk(classes)
