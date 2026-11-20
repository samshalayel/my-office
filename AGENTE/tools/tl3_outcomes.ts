/**
 * TL-3 / C-3 — سجل المقاييس الفعلية والفوارق.
 * كتابة المقياس للإنسان وحده عبر قناة الإدخال (DEC-4 أ / DEC-16) — نقطة TB-2 الوحيدة.
 * MIT-2: حقول مقيدة (apgar عدد صحيح 0..10)، الخارج عن المدى يُرفض ولا يُصحَّح، والملاحظة نص معزول لا يُقرأ كتعليمات.
 * entered_by من الجلسة (لا من النموذج أو النموذج المعبأ). إدخال واحد لكل ولادة. لا تعديل ولا حذف.
 */
import { AppError } from "../observability/errors.ts";
import { tx, nowIso, writeAudit, nextDailyRef, type Db } from "../storage/db.ts";
import { validateOutcomeInput, apgarClass, type RiskClass } from "../guards/validate.ts";
import { injectionFlag } from "../guards/pii.ts";
import { defineTool, actorLabel, type ToolCtx } from "./registry.ts";

/** ActualOutcome — S2 حرفياً */
export interface ActualOutcome {
  actual_ref: string; case_ref: string; birth_datetime: string; apgar_value: number; apgar_class: RiskClass; entered_by: string; note?: string;
}

export interface OutcomeResult { actual_ref: string; stored_at: string; audit_id: string }

export function getOutcome(db: Db, ref: string): (ActualOutcome & { stored_at: string }) | null {
  const r = db.prepare("SELECT * FROM outcomes WHERE actual_ref = ?").get(ref) as (ActualOutcome & { note: string | null; stored_at: string }) | undefined;
  if (!r) return null;
  const { note, ...rest } = r;
  return note ? { ...rest, note } : rest;
}

export const TL3_RECORD = defineTool<Record<string, unknown>, OutcomeResult>({
  tool: "TL-3",
  op: "record_outcome",
  actors: ["human"],
  run(ctx: ToolCtx, raw: Record<string, unknown>): OutcomeResult {
    const { db, cfg } = ctx.app;
    const v = validateOutcomeInput(raw);
    const known = db.prepare("SELECT 1 FROM pseudonym_map WHERE case_ref = ?").get(v.case_ref);
    if (!known) throw new AppError("UNKNOWN_CASE", v.case_ref);
    const cls = apgarClass(v.apgar_value, cfg.apgar_bands);
    const at = nowIso();
    return tx(db, () => {
      const dup = db.prepare("SELECT actual_ref FROM outcomes WHERE case_ref = ? AND birth_datetime = ?").get(v.case_ref, v.birth_datetime);
      if (dup) throw new AppError("DUPLICATE", `${v.case_ref}@${v.birth_datetime}`, "هذه الولادة مسجلة من قبل — إدخال واحد لكل ولادة.");
      const ref = nextDailyRef(db, "ACT", "outcomes", "actual_ref", at.slice(0, 10));
      db.prepare(`INSERT INTO outcomes (actual_ref, case_ref, birth_datetime, apgar_value, apgar_class, entered_by, note, stored_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(ref, v.case_ref, v.birth_datetime, v.apgar_value, cls, ctx.actorName, v.note, at);
      const auditId = writeAudit(db, {
        actor: actorLabel(ctx), entity: "actual", ref, action: "record",
        after: { case_ref: v.case_ref, birth_datetime: v.birth_datetime, apgar_value: v.apgar_value, apgar_class: cls, note_flag: injectionFlag(v.note) },
      });
      return { actual_ref: ref, stored_at: at, audit_id: auditId };
    });
  },
});

/** Discrepancy — S2 حرفياً (+ infant_ref و predicted للعرض في HITL-2) */
export interface Discrepancy {
  discrepancy_ref: string; prediction_ref: string; actual_ref: string; delta_count?: number;
  class_mismatch: boolean; resources_reserved: boolean; escalated: boolean;
}

export interface DiscrepancyRow extends Discrepancy {
  infant_ref: string | null;
  predicted: { count_value: number; risk_class: RiskClass; infant_class: RiskClass | null; apgar_value_estimate: number | null } | null;
  created_at: string;
}

interface DRaw {
  discrepancy_ref: string; prediction_ref: string; actual_ref: string; infant_ref: string | null; predicted_json: string;
  delta_count: number | null; class_mismatch: number; resources_reserved: number; escalated: number; created_at: string;
}

function dFromRaw(r: DRaw): DiscrepancyRow {
  return {
    discrepancy_ref: r.discrepancy_ref, prediction_ref: r.prediction_ref, actual_ref: r.actual_ref, infant_ref: r.infant_ref,
    predicted: JSON.parse(r.predicted_json), ...(r.delta_count === null ? {} : { delta_count: r.delta_count }),
    class_mismatch: r.class_mismatch === 1, resources_reserved: r.resources_reserved === 1, escalated: r.escalated === 1, created_at: r.created_at,
  };
}

export function getDiscrepancy(db: Db, ref: string): DiscrepancyRow | null {
  const r = db.prepare("SELECT * FROM discrepancies WHERE discrepancy_ref = ?").get(ref) as DRaw | undefined;
  return r ? dFromRaw(r) : null;
}

export function listDiscrepancies(db: Db, where = "1=1", ...params: (string | number)[]): DiscrepancyRow[] {
  return (db.prepare(`SELECT * FROM discrepancies WHERE ${where} ORDER BY created_at DESC`).all(...params) as unknown as DRaw[]).map(dFromRaw);
}

export interface DiscrepancyInput {
  prediction_ref: string; actual_ref: string; infant_ref: string | null;
  predicted: DiscrepancyRow["predicted"]; class_mismatch: boolean; resources_reserved: boolean; escalated: boolean;
}

/** الوكيل يسجل نتيجة المقارنة (C-6) — مرة واحدة لكل زوج (توقع، مقياس) */
export const TL3_DISCREPANCY = defineTool<DiscrepancyInput, { discrepancy_ref: string; audit_id: string }>({
  tool: "TL-3",
  op: "record_discrepancy",
  actors: ["AGT-1"],
  run(ctx: ToolCtx, d: DiscrepancyInput) {
    const { db } = ctx.app;
    return tx(db, () => {
      const ref = nextDailyRef(db, "DIS", "discrepancies", "discrepancy_ref");
      db.prepare(`INSERT INTO discrepancies (discrepancy_ref, prediction_ref, actual_ref, infant_ref, predicted_json, delta_count,
                  class_mismatch, resources_reserved, escalated, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
        .run(ref, d.prediction_ref, d.actual_ref, d.infant_ref, JSON.stringify(d.predicted), d.class_mismatch ? 1 : 0,
          d.resources_reserved ? 1 : 0, d.escalated ? 1 : 0, nowIso());
      const auditId = writeAudit(db, { actor: actorLabel(ctx), entity: "discrepancy", ref, action: "compare", after: d });
      return { discrepancy_ref: ref, audit_id: auditId };
    });
  },
});
