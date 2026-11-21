"""TL-4 / C-4 — مسودة التحضير ومسودة الفعل. مسودات فقط: لا أداة تنفيذ في النظام كله (DEC-9 / HR-6).
القيد: based_on توقع معتمد حصراً (approved أو modified بقرار الإنسان) — وإلا REJECTED_NOT_APPROVED (BR-1 / EV-8).
مسودة تحضير نشطة واحدة لكل توقع: الجديدة تحل محل السابقة (superseded) وتُسجَّل في التدقيق.
"""
from __future__ import annotations

import json
from typing import Any

from ..guards.pii import assert_no_pii
from ..guards.validate import validate_action, validate_preparation
from ..jsutil import jdump
from ..observability.errors import AppError
from ..storage.db import Db, next_daily_ref, now_iso, q1, qall, tx, write_audit
from .registry import ToolCtx, ToolDef, actor_label
from .tl2_predictions import get_prediction


def _from_raw(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "draft_ref": r["draft_ref"], "draft_type": r["draft_type"], "based_on": r["based_on"],
        "items": json.loads(r["items_json"]) if r["items_json"] else None, "action_kind": r["action_kind"],
        "payload": json.loads(r["payload_json"]) if r["payload_json"] else None,
        "alternatives": json.loads(r["alternatives_json"]) if r["alternatives_json"] else [],
        "status": r["status"], "origin": r["origin"], "run_id": r["run_id"], "created_at": r["created_at"], "updated_at": r["updated_at"],
    }


def get_draft(db: Db, ref: str) -> dict[str, Any] | None:
    r = q1(db, "SELECT * FROM drafts WHERE draft_ref = ?", ref)
    return _from_raw(r) if r else None


def list_drafts(db: Db, where: str = "1=1", *params: Any) -> list[dict[str, Any]]:
    return [_from_raw(r) for r in qall(db, f"SELECT * FROM drafts WHERE {where} ORDER BY created_at DESC", *params)]


def approved_prediction(db: Db, ref: str) -> dict[str, Any]:
    p = get_prediction(db, ref)
    if not p:
        raise AppError("NOT_FOUND", ref)
    if p["status"] not in ("approved", "modified"):
        raise AppError("REJECTED_NOT_APPROVED", f"{ref} status={p['status']}")
    return p


def _preparation(ctx: ToolCtx, inp: dict[str, Any]) -> dict[str, Any]:
    db = ctx.app.db
    approved_prediction(db, inp["based_on"])
    v = validate_preparation(inp["draft"])
    assert_no_pii(v, list(ctx.app.identities), "TL-4 preparation")
    at = now_iso()

    def write() -> dict[str, Any]:
        for old in list_drafts(db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", inp["based_on"]):
            db.execute("UPDATE drafts SET status = 'superseded', updated_at = ? WHERE draft_ref = ?", (at, old["draft_ref"]))
            write_audit(db, actor_label(ctx), "draft", old["draft_ref"], "supersede", before={"status": "active"}, after={"status": "superseded"})
        ref = next_daily_ref(db, "PD", "drafts", "draft_ref")
        db.execute("""INSERT INTO drafts (draft_ref, draft_type, based_on, items_json, status, origin, run_id, created_at, updated_at)
                      VALUES (?, 'preparation', ?, ?, 'active', 'agent', ?, ?, ?)""", (ref, inp["based_on"], jdump(v["items"]), ctx.run_id, at, at))
        write_audit(db, actor_label(ctx), "draft", ref, "create_preparation", after={"based_on": inp["based_on"], **v})
        return {"draft_ref": ref, "stored_at": at}

    return tx(db, write)


TL4_PREPARATION = ToolDef(tool="TL-4", op="create_preparation_draft", actors=("AGT-1",), run=_preparation)


def _action(ctx: ToolCtx, inp: dict[str, Any]) -> dict[str, Any]:
    db = ctx.app.db
    p = approved_prediction(db, inp["based_on"])
    v = validate_action(inp["draft"], p)
    assert_no_pii(v, list(ctx.app.identities), "TL-4 action")
    at = now_iso()

    def write() -> dict[str, Any]:
        ref = next_daily_ref(db, "AD", "drafts", "draft_ref")
        db.execute("""INSERT INTO drafts (draft_ref, draft_type, based_on, action_kind, payload_json, alternatives_json, status, origin, run_id, created_at, updated_at)
                      VALUES (?, 'action', ?, ?, ?, ?, 'pending', 'agent', ?, ?, ?)""",
                   (ref, inp["based_on"], v["kind"], jdump(v["payload"]), jdump(v["alternatives"]), ctx.run_id, at, at))
        write_audit(db, actor_label(ctx), "draft", ref, "create_action", after={"based_on": inp["based_on"], **v})
        return {"draft_ref": ref, "stored_at": at}

    return tx(db, write)


TL4_ACTION = ToolDef(tool="TL-4", op="create_action_draft", actors=("AGT-1",), run=_action)
