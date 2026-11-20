"""التشغيل: النسخ والاستعادة (BASE-7)، التذكير بالمتأخر، مفتاح الإيقاف (BASE-A3)، المؤشرات (DEC-3)"""
import asyncio
import os
import sqlite3
from pathlib import Path

import pytest

from agente.agents.agt1 import run_cycle
from agente.agents.model import DemoModel
from agente.guards.killswitch import read_controls, set_controls
from agente.hitl.alerts import open_alerts
from agente.hitl.metrics import compute_metrics
from agente.jsutil import parse_date_ms
from agente.observability.errors import AppError
from agente.scripts.scheduler import remind_overdue
from agente.storage.backup import create_backup, restore_backup, verify_backup
from agente.tools.registry import ToolCtx, invoke
from agente.tools.tl3_outcomes import TL3_RECORD

from .helpers import AS_OF, make_app


def test_backup_is_consistent_checksummed_and_restorable_tampering_is_detected():
    app = make_app(model=DemoModel())
    asyncio.run(run_cycle(app, as_of=AS_OF, trigger="manual"))
    b = create_backup(app.cfg, app.db)
    assert verify_backup(b["file"])["ok"] is True
    copy = sqlite3.connect(Path(b["file"]).as_uri() + "?mode=ro", uri=True)
    assert copy.execute("SELECT COUNT(*) FROM predictions").fetchone()[0] == 1
    copy.close()
    app.db.close()
    r = restore_backup(app.cfg, b["file"])
    assert os.path.exists(r["restored_to"]) and r["previous_saved_as"]
    with open(b["file"], "ab") as fh:
        fh.write(b"x")
    assert verify_backup(b["file"])["ok"] is False, "tampered backup is rejected"


def test_overdue_decisions_raise_repeated_reminders():
    app = make_app(model=DemoModel())
    c = asyncio.run(run_cycle(app, as_of=AS_OF, trigger="manual"))
    n = remind_overdue(app, parse_date_ms("2026-12-01T00:00:00Z"))
    assert n >= 1
    assert any(a["kind"] == "overdue" and a["ref"] == c["prediction_ref"] for a in open_alerts(app))


def test_kill_switch_stops_tools_immediately_per_tool_or_globally_and_is_audited():
    app = make_app(model=DemoModel())
    set_controls(app.cfg, app.db, {"enabled": False, "disabled_tools": ["TL-3"]}, "human:owner", "صيانة")
    with pytest.raises(AppError, match="KILL_SWITCH"):
        asyncio.run(invoke(TL3_RECORD, ToolCtx(app=app, run_id="r", actor="human", actor_name="owner"),
                           {"case_ref": "H-0001", "birth_datetime": "2026-11-20T01:00:00Z", "apgar_value": "8"}))
    assert read_controls(app.cfg)["disabled_tools"] == ["TL-3"]
    set_controls(app.cfg, app.db, {"enabled": True, "disabled_tools": []}, "human:owner", "إيقاف كامل")
    r = asyncio.run(run_cycle(app, as_of=AS_OF, trigger="manual"))
    assert r["status"] == "stopped"
    assert app.db.execute("SELECT COUNT(*) AS n FROM audit WHERE entity = 'control'").fetchone()["n"] == 2


def test_metrics_follow_dec3_thresholds_over_a_period():
    app = make_app(model=DemoModel())
    m = compute_metrics(app, 30)
    assert m["class_match"]["pct"] is None, "no data → no verdict"
    assert m["class_match"]["threshold"] == 85
    assert m["count_match"]["threshold"] == 80
    assert m["unescalated"] == 0


def test_a_bad_model_id_or_missing_key_fails_with_a_clear_message_never_silently():
    app = make_app(overrides={"model": {"provider": "openai_compatible", "model": ""}})
    r = asyncio.run(run_cycle(app, as_of=AS_OF, trigger="manual"))
    assert r["status"] == "failed"
    assert r["error"]["code"] == "NEEDS_REEVAL", "live model without a passing eval never runs (MIT-8)"
