/**
 * الجدولة داخل الخادم: الدورة اليومية (DEC-5 ج)، تذكير بما تأخر (تنبيه متكرر — K-2 / BR-4)، والنسخة الاحتياطية اليومية (BASE-7).
 */
import type { AppContext } from "../agents/context.ts";
import { runCycle, localDate, openEscalations } from "../agents/agt1.ts";
import { raiseAlert } from "../hitl/alerts.ts";
import { listPredictions } from "../tools/tl2_predictions.ts";
import { listDrafts } from "../tools/tl4_drafts.ts";
import { createBackup } from "../storage/backup.ts";
import { getMeta, setMeta } from "../storage/db.ts";
import { logServerError } from "../observability/errors.ts";

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function remindOverdue(app: AppContext, now = Date.now()): number {
  let n = 0;
  for (const p of listPredictions(app.db, "status = 'draft'")) {
    if (p.batch_deadline && Date.parse(p.batch_deadline) < now) {
      raiseAlert(app, "overdue", p.prediction_ref, `التوقع ${p.prediction_ref} تجاوز موعد القرار ولم يُعتمد — لا يُستخدم قبل قرارك (BR-1).`);
      n++;
    }
  }
  for (const d of openEscalations(app)) {
    raiseAlert(app, "hitl2", d.discrepancy_ref, `تذكير: الخلاف ${d.discrepancy_ref} على موارد محجوزة ما زال بلا قرار (HITL-2).`);
    n++;
  }
  for (const a of listDrafts(app.db, "draft_type = 'action' AND status = 'pending'")) {
    raiseAlert(app, "hitl3", a.draft_ref, `تذكير: مسودة الفعل ${a.draft_ref} بانتظار موافقتك — لن يُنفَّذ شيء بدونك (BR-4).`);
    n++;
  }
  return n;
}

export async function schedulerTick(app: AppContext, now = new Date()): Promise<void> {
  const s = app.cfg.schedule;
  const today = localDate(now);
  const t = hhmm(now);
  if (t >= s.daily_cycle_time && getMeta(app.db, "last_scheduled_cycle") !== today) {
    setMeta(app.db, "last_scheduled_cycle", today);
    await runCycle(app, { as_of: today, trigger: "schedule" });
  }
  if (t >= s.backup_time && getMeta(app.db, "last_backup") !== today) {
    setMeta(app.db, "last_backup", today);
    try { createBackup(app.cfg, app.db); } catch (e) {
      logServerError("backup", e);
      raiseAlert(app, "backup", today, `فشلت النسخة الاحتياطية اليومية ${today} — راجع الخادم.`);
    }
  }
  const last = Number(getMeta(app.db, "last_reminder_ms") || 0);
  if (now.getTime() - last >= s.reminder_every_minutes * 60_000) {
    setMeta(app.db, "last_reminder_ms", String(now.getTime()));
    remindOverdue(app, now.getTime());
  }
}

export function startScheduler(app: AppContext): () => void {
  if (!app.cfg.schedule.enabled) return () => {};
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    schedulerTick(app).catch((e) => logServerError("scheduler", e, (x) => app.tracer.scrub(x))).finally(() => { busy = false; });
  }, 30_000);
  return () => clearInterval(timer);
}
