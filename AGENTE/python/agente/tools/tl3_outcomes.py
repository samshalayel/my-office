"""TL-3 / C-3 — سجل المقاييس الفعلية والفوارق.
كتابة المقياس للإنسان وحده عبر قناة الإدخال (DEC-4 أ / DEC-16) — نقطة TB-2 الوحيدة.
MIT-2: حقول مقيدة (apgar عدد صحيح 0..10)، الخارج عن المدى يُرفض ولا يُصحَّح، والملاحظة نص معزول لا يُقرأ كتعليمات.
entered_by من الجلسة (لا من النموذج أو النموذج المعبأ). إدخال واحد لكل ولادة. لا تعديل ولا حذف.
"""
from __future__ import annotations

import json
from typing import Any

from ..guards.pii import injection_flag
from ..guards.validate import apgar_class, validate_outcome_input
from ..jsutil import jdump
from ..observability.errors import AppError
from ..storage.db import Db, next_daily_ref, now_iso, q1, qall, tx, write_audit
from .registry import ToolCtx, ToolDef, actor_label


def get_outcome(db: Db, ref: str) -> dict[str, Any] | None:
    """ActualOutcome — S2 حرفياً (+ stored_at)؛ note فقط إن وُجدت"""
    r = q1(db, "SELECT * FROM outcomes WHERE actual_ref = ?", ref)
    if not r:
        return None
    note = r.pop("note")
    if note:
        r["note"] = note
    return r


def _record(ctx: ToolCtx, raw: dict[str, Any]) -> dict[str, Any]:
    db, cfg = ctx.app.db, ctx.app.cfg
    v = validate_outcome_input(raw)
    if not q1(db, "SELECT 1 AS x FROM pseudonym_map WHERE case_ref = ?", v["case_ref"]):
        raise AppError("UNKNOWN_CASE", v["case_ref"])
    cls = apgar_class(v["apgar_value"], cfg["apgar_bands"])
    at = now_iso()

    def write() -> dict[str, Any]:
        if q1(db, "SELECT actual_ref FROM outcomes WHERE case_ref = ? AND birth_datetime = ?", v["case_ref"], v["birth_datetime"]):
            raise AppError("DUPLICATE", f"{v['case_ref']}@{v['birth_datetime']}", "هذه الولادة مسجلة من قبل — إدخال واحد لكل ولادة.")
        ref = next_daily_ref(db, "ACT", "outcomes", "actual_ref", at[:10])
        db.execute("""INSERT INTO outcomes (actual_ref, case_ref, birth_datetime, apgar_value, apgar_class, entered_by, note, stored_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                   (ref, v["case_ref"], v["birth_datetime"], v["apgar_value"], cls, ctx.actor_name, v["note"], at))
        audit_id = write_audit(db, actor_label(ctx), "actual", ref, "record",
                               after={"case_ref": v["case_ref"], "birth_datetime": v["birth_datetime"], "apgar_value": v["apgar_value"],
                                      "apgar_class": cls, "note_flag": injection_flag(v["note"])})
        return {"actual_ref": ref, "stored_at": at, "audit_id": audit_id}

    return tx(db, write)


TL3_RECORD = ToolDef(tool="TL-3", op="record_outcome", actors=("human",), run=_record)


def _d_from_raw(r: dict[str, Any]) -> dict[str, Any]:
    out = {
        "discrepancy_ref": r["discrepancy_ref"], "prediction_ref": r["prediction_ref"], "actual_ref": r["actual_ref"], "infant_ref": r["infant_ref"],
        "predicted": json.loads(r["predicted_json"]),
    }
    if r["delta_count"] is not None:
        out["delta_count"] = r["delta_count"]
    out.update({"class_mismatch": r["class_mismatch"] == 1, "resources_reserved": r["resources_reserved"] == 1,
                "escalated": r["escalated"] == 1, "created_at": r["created_at"]})
    return out


def get_discrepancy(db: Db, ref: str) -> dict[str, Any] | None:
    r = q1(db, "SELECT * FROM discrepancies WHERE discrepancy_ref = ?", ref)
    return _d_from_raw(r) if r else None


def list_discrepancies(db: Db, where: str = "1=1", *params: Any) -> list[dict[str, Any]]:
    return [_d_from_raw(r) for r in qall(db, f"SELECT * FROM discrepancies WHERE {where} ORDER BY created_at DESC", *params)]


def _discrepancy(ctx: ToolCtx, d: dict[str, Any]) -> dict[str, Any]:
    """الوكيل يسجل نتيجة المقارنة (C-6) — مرة واحدة لكل زوج (توقع، مقياس)"""
    db = ctx.app.db

    def write() -> dict[str, Any]:
        ref = next_daily_ref(db, "DIS", "discrepancies", "discrepancy_ref")
        db.execute("""INSERT INTO discrepancies (discrepancy_ref, prediction_ref, actual_ref, infant_ref, predicted_json, delta_count,
                      class_mismatch, resources_reserved, escalated, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)""",
                   (ref, d["prediction_ref"], d["actual_ref"], d["infant_ref"], jdump(d["predicted"]), 1 if d["class_mismatch"] else 0,
                    1 if d["resources_reserved"] else 0, 1 if d["escalated"] else 0, now_iso()))
        audit_id = write_audit(db, actor_label(ctx), "discrepancy", ref, "compare", after=d)
        return {"discrepancy_ref": ref, "audit_id": audit_id}

    return tx(db, write)


TL3_DISCREPANCY = ToolDef(tool="TL-3", op="record_discrepancy", actors=("AGT-1",), run=_discrepancy)
