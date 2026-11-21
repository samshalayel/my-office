"""الجدولة داخل الخادم: الدورة اليومية (DEC-5 ج)، تذكير بما تأخر (تنبيه متكرر — K-2 / BR-4)، والنسخة الاحتياطية اليومية (BASE-7)."""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Callable

from ..agents.agt1 import open_escalations, run_cycle
from ..hitl.alerts import raise_alert
from ..jsutil import local_date, now_ms, parse_date_ms
from ..observability.errors import log_server_error
from ..storage.backup import create_backup
from ..storage.db import get_meta, set_meta
from ..tools.tl2_predictions import list_predictions
from ..tools.tl4_drafts import list_drafts


def _hhmm(d: datetime) -> str:
    d = d.astimezone()
    return f"{d.hour:02d}:{d.minute:02d}"


def remind_overdue(app: Any, now: float | None = None) -> int:
    now = now_ms() if now is None else now
    n = 0
    for p in list_predictions(app.db, "status = 'draft'"):
        t = parse_date_ms(p["batch_deadline"]) if p["batch_deadline"] else None
        if t is not None and t < now:
            raise_alert(app, "overdue", p["prediction_ref"], f"التوقع {p['prediction_ref']} تجاوز موعد القرار ولم يُعتمد — لا يُستخدم قبل قرارك (BR-1).")
            n += 1
    for d in open_escalations(app):
        raise_alert(app, "hitl2", d["discrepancy_ref"], f"تذكير: الخلاف {d['discrepancy_ref']} على موارد محجوزة ما زال بلا قرار (HITL-2).")
        n += 1
    for a in list_drafts(app.db, "draft_type = 'action' AND status = 'pending'"):
        raise_alert(app, "hitl3", a["draft_ref"], f"تذكير: مسودة الفعل {a['draft_ref']} بانتظار موافقتك — لن يُنفَّذ شيء بدونك (BR-4).")
        n += 1
    return n


async def scheduler_tick(app: Any, now: datetime | None = None) -> None:
    now = now or datetime.now().astimezone()
    s = app.cfg["schedule"]
    today = local_date(now)
    t = _hhmm(now)
    if t >= s["daily_cycle_time"] and get_meta(app.db, "last_scheduled_cycle") != today:
        set_meta(app.db, "last_scheduled_cycle", today)
        await run_cycle(app, as_of=today, trigger="schedule")
    if t >= s["backup_time"] and get_meta(app.db, "last_backup") != today:
        set_meta(app.db, "last_backup", today)
        try:
            create_backup(app.cfg, app.db)
        except Exception as e:
            log_server_error("backup", e)
            raise_alert(app, "backup", today, f"فشلت النسخة الاحتياطية اليومية {today} — راجع الخادم.")
    now_ms_ = int(now.timestamp() * 1000)
    last = int(get_meta(app.db, "last_reminder_ms") or 0)
    if now_ms_ - last >= s["reminder_every_minutes"] * 60_000:
        set_meta(app.db, "last_reminder_ms", str(now_ms_))
        remind_overdue(app, now_ms_)


def start_scheduler(app: Any, loop: asyncio.AbstractEventLoop) -> Callable[[], None]:
    """مهمة على حلقة التطبيق: نبضة كل 30 ثانية (لا تتداخل نبضتان)"""
    if not app.cfg["schedule"]["enabled"]:
        return lambda: None

    async def ticker() -> None:
        while True:
            await asyncio.sleep(30)
            try:
                await scheduler_tick(app)
            except Exception as e:
                log_server_error("scheduler", e, app.tracer.scrub)

    fut = asyncio.run_coroutine_threadsafe(ticker(), loop)
    return lambda: fut.cancel()
