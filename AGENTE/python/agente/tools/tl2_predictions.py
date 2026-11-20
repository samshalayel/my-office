"""TL-2 / C-2 — سجل التوقعات.
المدخل PredictionDraft بحالة draft → { prediction_ref, stored_at, audit_id } — فشل: REJECTED_SCHEMA · FORBIDDEN_MODIFY_APPROVED.
الكتابة للوكيل وحده؛ التعديل مسموح قبل الاعتماد فقط (HR-7 — مفروض أيضاً بـ trigger في القاعدة)؛ لا حذف.
كل مخرج نموذج يمر بـ MIT-4 (validate_prediction) + فحص معرفات شخصية (HR-5) قبل الكتابة.
"""
from __future__ import annotations

import json
from typing import Any

from ..guards.pii import assert_no_pii
from ..guards.validate import validate_prediction
from ..jsutil import jdump
from ..observability.errors import AppError
from ..storage.db import Db, next_daily_ref, now_iso, q1, qall, tx, write_audit
from .registry import ToolCtx, ToolDef, actor_label
from .tl1_cases import cycle_cases

DRAFT_KEYS = ["prediction_ref", "cycle_id", "count_value", "risk_class", "per_infant", "basis", "missing_fields", "status"]


def from_raw(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "prediction_ref": r["prediction_ref"], "cycle_id": r["cycle_id"], "count_value": r["count_value"], "risk_class": r["risk_class"],
        "per_infant": json.loads(r["per_infant_json"]), "basis": json.loads(r["basis_json"]), "missing_fields": json.loads(r["missing_fields_json"]),
        "status": r["status"], "origin": r["origin"], "supersedes": r["supersedes"], "run_id": r["run_id"], "model": r["model"],
        "prompt_version": r["prompt_version"], "batch_deadline": r["batch_deadline"], "created_at": r["created_at"], "updated_at": r["updated_at"],
    }


def get_prediction(db: Db, ref: str) -> dict[str, Any] | None:
    r = q1(db, "SELECT * FROM predictions WHERE prediction_ref = ?", ref)
    return from_raw(r) if r else None


def list_predictions(db: Db, where: str = "1=1", *params: Any) -> list[dict[str, Any]]:
    return [from_raw(r) for r in qall(db, f"SELECT * FROM predictions WHERE {where} ORDER BY created_at DESC", *params)]


def to_draft(p: dict[str, Any]) -> dict[str, Any]:
    """PredictionDraft — S2 حرفياً"""
    return {k: p[k] for k in DRAFT_KEYS}


def case_infos(db: Db, cycle_id: str) -> list[dict[str, Any]]:
    """معلومات حالات الدورة اللازمة للتحقق: عدد الأجنّة + الحقول الناقصة (EV-2)"""
    return [
        {"case_ref": x["case"]["case_ref"], "expected_infants": x["expected_infants"],
         "missing": [k for k, v in x["case"]["indicators"].items() if v is None]}
        for x in cycle_cases(db, cycle_id)
    ]


def _write(ctx: ToolCtx, inp: dict[str, Any]) -> dict[str, Any]:
    db, cfg = ctx.app.db, ctx.app.cfg
    infos = case_infos(db, inp["cycle_id"])
    draft = inp["draft"]
    if not infos and isinstance(draft, dict) and isinstance(draft.get("per_infant"), list) and draft["per_infant"]:
        raise AppError("REJECTED_SCHEMA", "no cases read", "لا حالات مقروءة لهذه الدورة — اقرأ TL-1 أولاً.")
    v = validate_prediction(draft, infos, cfg["caps"]["max_infants_per_case"])
    assert_no_pii(v, list(ctx.app.identities), "TL-2 prediction")
    at = now_iso()

    def write() -> dict[str, Any]:
        # تعديل قبل الاعتماد فقط: مسودة الوكيل لنفس الدورة تُحدَّث؛ المعتمد مقفل (trigger)
        existing = q1(db, "SELECT * FROM predictions WHERE cycle_id = ? AND origin = 'agent' ORDER BY created_at DESC LIMIT 1", inp["cycle_id"])
        if existing and existing["status"] != "draft":
            raise AppError("FORBIDDEN_MODIFY_APPROVED", existing["prediction_ref"])
        if existing:
            db.execute(
                """UPDATE predictions SET count_value = ?, risk_class = ?, per_infant_json = ?, basis_json = ?, missing_fields_json = ?,
                   run_id = ?, model = ?, prompt_version = ?, updated_at = ? WHERE prediction_ref = ?""",
                (v["count_value"], v["risk_class"], jdump(v["per_infant"]), jdump(v["basis"]), jdump(v["missing_fields"]),
                 ctx.run_id, inp["model"], inp["prompt_version"], at, existing["prediction_ref"]))
            audit_id = write_audit(db, actor_label(ctx), "prediction", existing["prediction_ref"], "update_draft",
                                   before=to_draft(from_raw(existing)), after=v)
            return {"prediction_ref": existing["prediction_ref"], "stored_at": at, "audit_id": audit_id}
        ref = next_daily_ref(db, "P", "predictions", "prediction_ref", inp["cycle_id"][:10])
        db.execute(
            """INSERT INTO predictions (prediction_ref, cycle_id, count_value, risk_class, per_infant_json, basis_json, missing_fields_json,
               status, origin, supersedes, run_id, model, prompt_version, batch_deadline, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 'agent', NULL, ?, ?, ?, ?, ?, ?)""",
            (ref, inp["cycle_id"], v["count_value"], v["risk_class"], jdump(v["per_infant"]), jdump(v["basis"]),
             jdump(v["missing_fields"]), ctx.run_id, inp["model"], inp["prompt_version"], inp["batch_deadline"], at, at))
        audit_id = write_audit(db, actor_label(ctx), "prediction", ref, "create_draft", after=v)
        return {"prediction_ref": ref, "stored_at": at, "audit_id": audit_id}

    return tx(db, write)


TL2_WRITE = ToolDef(tool="TL-2", op="write_prediction", actors=("AGT-1",), run=_write)
