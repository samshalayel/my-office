/**
 * مؤشرات النجاح بعتبات DEC-3 (≥80% عدد، ≥85% فئة، صفر خلاف بلا تصعيد) — تُحسب على فترة، لا على توقع واحد (DEV-4):
 *  - مطابقة الفئة: من كل مقارنات المواليد بتوقعاتهم، كم طابقت فئته المتوقعة.
 *  - مطابقة العدد: لكل دورة انتهت نافذتها وتوقعها معتمد: 1 − |الفعلي − المتوقع| / max(الفعلي، المتوقع، 1) — المتوسط.
 *  - خلاف بلا تصعيد: خلاف على توقع له موارد محجوزة لم يُصعَّد — يجب أن يكون صفراً.
 */
import type { AppContext } from "../agents/context.ts";
import { listPredictions } from "../tools/tl2_predictions.ts";

export interface Metrics {
  days: number;
  class_match: { matched: number; compared: number; pct: number | null; threshold: number; pass: boolean | null };
  count_match: { cycles: number; pct: number | null; threshold: number; pass: boolean | null; detail: { prediction_ref: string; predicted: number; actual: number }[] };
  unescalated: number;
  unplanned: number;
}

const DAY = 86_400_000;

export function computeMetrics(app: AppContext, days = 30, now = Date.now()): Metrics {
  const { db, cfg } = app;
  const since = new Date(now - days * DAY).toISOString();
  const cmp = db.prepare("SELECT class_mismatch, prediction_ref FROM discrepancies WHERE created_at >= ? AND prediction_ref <> 'UNPLANNED'").all(since) as { class_mismatch: number }[];
  const matched = cmp.filter((r) => r.class_mismatch === 0).length;
  const classPct = cmp.length ? Math.round((matched / cmp.length) * 1000) / 10 : null;

  const detail: { prediction_ref: string; predicted: number; actual: number }[] = [];
  for (const p of listPredictions(db, "status IN ('approved','modified') AND created_at >= ?", since)) {
    // التوقع الذي حلّ محله توقع أحدث (HITL-2 تعديل) لا يُحسب مرتين
    if (db.prepare("SELECT 1 FROM predictions WHERE supersedes = ?").get(p.prediction_ref)) continue;
    const asOf = (db.prepare("SELECT as_of FROM cycles WHERE cycle_id = ?").get(p.cycle_id) as { as_of: string } | undefined)?.as_of;
    if (!asOf) continue;
    const start = Date.parse(`${asOf}T00:00:00Z`);
    const end = start + (cfg.window_days + 1) * DAY;
    if (end > now) continue; // النافذة لم تنتهِ — لا حكم بعد
    const refs = db.prepare("SELECT case_ref FROM cycle_cases WHERE cycle_id = ?").all(p.cycle_id) as { case_ref: string }[];
    if (!refs.length) continue;
    const marks = refs.map(() => "?").join(",");
    const actual = (db.prepare(`SELECT COUNT(*) AS n FROM outcomes WHERE case_ref IN (${marks}) AND birth_datetime >= ? AND birth_datetime < ?`)
      .get(...refs.map((r) => r.case_ref), new Date(start).toISOString(), new Date(end).toISOString()) as { n: number }).n;
    detail.push({ prediction_ref: p.prediction_ref, predicted: p.count_value, actual });
  }
  const accs = detail.map((d) => 1 - Math.abs(d.actual - d.predicted) / Math.max(d.actual, d.predicted, 1));
  const countPct = accs.length ? Math.round((accs.reduce((a, b) => a + b, 0) / accs.length) * 1000) / 10 : null;
  const unescalated = (db.prepare("SELECT COUNT(*) AS n FROM discrepancies WHERE class_mismatch = 1 AND resources_reserved = 1 AND escalated = 0 AND created_at >= ?").get(since) as { n: number }).n;
  const unplanned = (db.prepare("SELECT COUNT(*) AS n FROM discrepancies WHERE prediction_ref = 'UNPLANNED' AND created_at >= ?").get(since) as { n: number }).n;
  return {
    days,
    class_match: { matched, compared: cmp.length, pct: classPct, threshold: cfg.thresholds.class_match_pct, pass: classPct === null ? null : classPct >= cfg.thresholds.class_match_pct },
    count_match: { cycles: detail.length, pct: countPct, threshold: cfg.thresholds.count_match_pct, pass: countPct === null ? null : countPct >= cfg.thresholds.count_match_pct, detail },
    unescalated,
    unplanned,
  };
}
