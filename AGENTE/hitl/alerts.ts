/**
 * التنبيهات: حرجة فورية (DEC-5 ج)، خلاف يحتاج قراراً (HITL-2)، تأخر الرد، فشل دورة أو نسخة احتياطية.
 * تظهر في الواجهة دائماً، وتُرسل اختيارياً إلى webhook داخلي (alerts.webhook_url) بالمراجع فقط — بلا أي معرف شخصي.
 */
import type { AppContext } from "../agents/context.ts";
import { nowIso, randomRef } from "../storage/db.ts";

export type AlertKind = "critical" | "hitl2" | "hitl3" | "overdue" | "cycle_failed" | "source" | "backup" | "unplanned" | "model";

export interface AlertRow {
  alert_id: string; kind: AlertKind; ref: string; message: string;
  created_at: string; last_notified_at: string | null; acknowledged_at: string | null; acknowledged_by: string | null;
}

/** تنبيه واحد مفتوح لكل (نوع، مرجع) — التكرار يحدّث وقت الإشعار فقط */
export function raiseAlert(app: AppContext, kind: AlertKind, ref: string, message: string): string {
  const open = app.db.prepare("SELECT alert_id FROM alerts WHERE kind = ? AND ref = ? AND acknowledged_at IS NULL").get(kind, ref) as { alert_id: string } | undefined;
  const at = nowIso();
  if (open) {
    app.db.prepare("UPDATE alerts SET last_notified_at = ?, message = ? WHERE alert_id = ?").run(at, message, open.alert_id);
    void notify(app, { kind, ref, message, at, repeat: true });
    return open.alert_id;
  }
  const id = randomRef("AL");
  app.db.prepare("INSERT INTO alerts (alert_id, kind, ref, message, created_at, last_notified_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, kind, ref, message, at, at);
  void notify(app, { kind, ref, message, at, repeat: false });
  return id;
}

export function openAlerts(app: AppContext): AlertRow[] {
  return app.db.prepare("SELECT * FROM alerts WHERE acknowledged_at IS NULL ORDER BY CASE kind WHEN 'critical' THEN 0 WHEN 'hitl2' THEN 1 WHEN 'hitl3' THEN 1 ELSE 2 END, created_at DESC").all() as unknown as AlertRow[];
}

export function acknowledgeAlert(app: AppContext, alertId: string, user: string): void {
  app.db.prepare("UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE alert_id = ? AND acknowledged_at IS NULL").run(nowIso(), user, alertId);
}

/** يغلق تنبيهات مرجع انتهى سببه (مثلاً: قُرر التوقع) */
export function resolveAlerts(app: AppContext, ref: string, user: string): void {
  app.db.prepare("UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE ref = ? AND acknowledged_at IS NULL").run(nowIso(), user, ref);
}

async function notify(app: AppContext, body: { kind: string; ref: string; message: string; at: string; repeat: boolean }): Promise<void> {
  const url = app.cfg.alerts.webhook_url;
  if (!url) return;
  try {
    // الرسالة نفسها مبنية من مراجع (H-0001، P-...) — والتتبع ينقّي أي معرف احتياطاً
    const payload = app.tracer.scrub(JSON.stringify({ source: "AGENTE", ...body }));
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: AbortSignal.timeout(5000) });
  } catch (e) {
    console.error(`[AGENTE] alert webhook failed: ${(e as Error).message}`);
  }
}
