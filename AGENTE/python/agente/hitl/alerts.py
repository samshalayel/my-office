"""التنبيهات: حرجة فورية (DEC-5 ج)، خلاف يحتاج قراراً (HITL-2)، تأخر الرد، فشل دورة أو نسخة احتياطية.
تظهر في الواجهة دائماً، وتُرسل اختيارياً إلى webhook داخلي (alerts.webhook_url) بالمراجع فقط — بلا أي معرف شخصي.
"""
from __future__ import annotations

import sys
import threading
import urllib.request
from typing import Any

from ..jsutil import jdump
from ..storage.db import now_iso, q1, qall, random_ref

ALERT_KINDS = ("critical", "hitl2", "hitl3", "overdue", "cycle_failed", "source", "backup", "unplanned", "model")


def raise_alert(app: Any, kind: str, ref: str, message: str) -> str:
    """تنبيه واحد مفتوح لكل (نوع، مرجع) — التكرار يحدّث وقت الإشعار فقط"""
    db = app.db
    opened = q1(db, "SELECT alert_id FROM alerts WHERE kind = ? AND ref = ? AND acknowledged_at IS NULL", kind, ref)
    at = now_iso()
    if opened:
        db.execute("UPDATE alerts SET last_notified_at = ?, message = ? WHERE alert_id = ?", (at, message, opened["alert_id"]))
        _notify(app, {"kind": kind, "ref": ref, "message": message, "at": at, "repeat": True})
        return opened["alert_id"]
    aid = random_ref("AL")
    db.execute("INSERT INTO alerts (alert_id, kind, ref, message, created_at, last_notified_at) VALUES (?, ?, ?, ?, ?, ?)",
               (aid, kind, ref, message, at, at))
    _notify(app, {"kind": kind, "ref": ref, "message": message, "at": at, "repeat": False})
    return aid


def open_alerts(app: Any) -> list[dict[str, Any]]:
    return qall(app.db, "SELECT * FROM alerts WHERE acknowledged_at IS NULL ORDER BY CASE kind WHEN 'critical' THEN 0 WHEN 'hitl2' THEN 1 WHEN 'hitl3' THEN 1 ELSE 2 END, created_at DESC")


def acknowledge_alert(app: Any, alert_id: str, user: str) -> None:
    app.db.execute("UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE alert_id = ? AND acknowledged_at IS NULL", (now_iso(), user, alert_id))


def resolve_alerts(app: Any, ref: str, user: str) -> None:
    """يغلق تنبيهات مرجع انتهى سببه (مثلاً: قُرر التوقع)"""
    app.db.execute("UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE ref = ? AND acknowledged_at IS NULL", (now_iso(), user, ref))


def _notify(app: Any, body: dict[str, Any]) -> None:
    url = app.cfg["alerts"]["webhook_url"]
    if not url:
        return
    # الرسالة نفسها مبنية من مراجع (H-0001، P-...) — والتتبع ينقّي أي معرف احتياطاً
    payload = app.tracer.scrub(jdump({"source": "AGENTE", **body})).encode("utf-8")

    def send() -> None:
        try:
            req = urllib.request.Request(url, data=payload, method="POST", headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=5):
                pass
        except Exception as e:  # لا يوقف شيئاً — يُسجَّل فقط
            print(f"[AGENTE] alert webhook failed: {e}", file=sys.stderr)

    threading.Thread(target=send, daemon=True).start()
