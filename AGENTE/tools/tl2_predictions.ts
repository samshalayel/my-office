/**
 * TL-2 / C-2 — سجل التوقعات.
 * المدخل PredictionDraft بحالة draft → { prediction_ref, stored_at, audit_id } — فشل: REJECTED_SCHEMA · FORBIDDEN_MODIFY_APPROVED.
 * الكتابة للوكيل وحده؛ التعديل مسموح قبل الاعتماد فقط (HR-7 — مفروض أيضاً بـ trigger في القاعدة)؛ لا حذف.
 * كل مخرج نموذج يمر بـ MIT-4 (validatePrediction) + فحص معرفات شخصية (HR-5) قبل الكتابة.
 */
import { AppError } from "../observability/errors.ts";
import { tx, nowIso, writeAudit, nextDailyRef, type Db } from "../storage/db.ts";
import { validatePrediction, type PredictionInput, type CaseInfo, type PerInfant, type BasisDoc, type RiskClass } from "../guards/validate.ts";
import { assertNoPII } from "../guards/pii.ts";
import { defineTool, actorLabel, type ToolCtx } from "./registry.ts";
import { cycleCases } from "./tl1_cases.ts";

export type PredictionStatus = "draft" | "approved" | "modified" | "rejected";

/** PredictionDraft — S2 حرفياً */
export interface PredictionDraft {
  prediction_ref: string;
  cycle_id: string;
  count_value: number;
  risk_class: RiskClass;
  per_infant: PerInfant[];
  basis: BasisDoc;
  missing_fields: string[];
  status: PredictionStatus;
}

export interface PredictionRow extends PredictionDraft {
  origin: "agent" | "human";
  supersedes: string | null;
  run_id: string;
  model: string | null;
  prompt_version: string | null;
  batch_deadline: string | null;
  created_at: string;
  updated_at: string;
}

interface Raw {
  prediction_ref: string; cycle_id: string; count_value: number; risk_class: RiskClass; per_infant_json: string; basis_json: string;
  missing_fields_json: string; status: PredictionStatus; origin: "agent" | "human"; supersedes: string | null; run_id: string;
  model: string | null; prompt_version: string | null; batch_deadline: string | null; created_at: string; updated_at: string;
}

function fromRaw(r: Raw): PredictionRow {
  return {
    prediction_ref: r.prediction_ref, cycle_id: r.cycle_id, count_value: r.count_value, risk_class: r.risk_class,
    per_infant: JSON.parse(r.per_infant_json), basis: JSON.parse(r.basis_json), missing_fields: JSON.parse(r.missing_fields_json),
    status: r.status, origin: r.origin, supersedes: r.supersedes, run_id: r.run_id, model: r.model, prompt_version: r.prompt_version,
    batch_deadline: r.batch_deadline, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function getPrediction(db: Db, ref: string): PredictionRow | null {
  const r = db.prepare("SELECT * FROM predictions WHERE prediction_ref = ?").get(ref) as Raw | undefined;
  return r ? fromRaw(r) : null;
}

export function listPredictions(db: Db, where = "1=1", ...params: (string | number)[]): PredictionRow[] {
  return (db.prepare(`SELECT * FROM predictions WHERE ${where} ORDER BY created_at DESC`).all(...params) as unknown as Raw[]).map(fromRaw);
}

export function toDraft(p: PredictionRow): PredictionDraft {
  const { prediction_ref, cycle_id, count_value, risk_class, per_infant, basis, missing_fields, status } = p;
  return { prediction_ref, cycle_id, count_value, risk_class, per_infant, basis, missing_fields, status };
}

/** معلومات حالات الدورة اللازمة للتحقق: عدد الأجنّة + الحقول الناقصة (EV-2) */
export function caseInfos(db: Db, cycleId: string): CaseInfo[] {
  return cycleCases({ app: { db } }, cycleId).map(({ case: c, expected_infants }) => ({
    case_ref: c.case_ref,
    expected_infants,
    missing: Object.entries(c.indicators).filter(([, v]) => v === null).map(([k]) => k),
  }));
}

export interface WriteInput {
  cycle_id: string;
  draft: unknown;
  model: string | null;
  prompt_version: string | null;
  batch_deadline: string | null;
}

export interface WriteResult { prediction_ref: string; stored_at: string; audit_id: string }

export const TL2_WRITE = defineTool<WriteInput, WriteResult>({
  tool: "TL-2",
  op: "write_prediction",
  actors: ["AGT-1"],
  run(ctx: ToolCtx, input: WriteInput): WriteResult {
    const { db, cfg } = ctx.app;
    const infos = caseInfos(db, input.cycle_id);
    if (!infos.length && Array.isArray((input.draft as { per_infant?: unknown[] })?.per_infant) && (input.draft as { per_infant: unknown[] }).per_infant.length) {
      throw new AppError("REJECTED_SCHEMA", "no cases read", "لا حالات مقروءة لهذه الدورة — اقرأ TL-1 أولاً.");
    }
    const v: PredictionInput = validatePrediction(input.draft, infos, cfg.caps.max_infants_per_case);
    assertNoPII(v, [...ctx.app.identities], "TL-2 prediction");
    const at = nowIso();
    return tx(db, () => {
      // تعديل قبل الاعتماد فقط: مسودة الوكيل لنفس الدورة تُحدَّث؛ المعتمد مقفل (trigger)
      const existing = db.prepare("SELECT * FROM predictions WHERE cycle_id = ? AND origin = 'agent' ORDER BY created_at DESC LIMIT 1").get(input.cycle_id) as Raw | undefined;
      if (existing && existing.status !== "draft") throw new AppError("FORBIDDEN_MODIFY_APPROVED", existing.prediction_ref);
      if (existing) {
        db.prepare(`UPDATE predictions SET count_value = ?, risk_class = ?, per_infant_json = ?, basis_json = ?, missing_fields_json = ?,
                    run_id = ?, model = ?, prompt_version = ?, updated_at = ? WHERE prediction_ref = ?`)
          .run(v.count_value, v.risk_class, JSON.stringify(v.per_infant), JSON.stringify(v.basis), JSON.stringify(v.missing_fields),
            ctx.run_id, input.model, input.prompt_version, at, existing.prediction_ref);
        const auditId = writeAudit(db, { actor: actorLabel(ctx), entity: "prediction", ref: existing.prediction_ref, action: "update_draft", before: toDraft(fromRaw(existing)), after: v });
        return { prediction_ref: existing.prediction_ref, stored_at: at, audit_id: auditId };
      }
      const ref = nextDailyRef(db, "P", "predictions", "prediction_ref", input.cycle_id.slice(0, 10));
      db.prepare(`INSERT INTO predictions (prediction_ref, cycle_id, count_value, risk_class, per_infant_json, basis_json, missing_fields_json,
                  status, origin, supersedes, run_id, model, prompt_version, batch_deadline, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 'agent', NULL, ?, ?, ?, ?, ?, ?)`)
        .run(ref, input.cycle_id, v.count_value, v.risk_class, JSON.stringify(v.per_infant), JSON.stringify(v.basis),
          JSON.stringify(v.missing_fields), ctx.run_id, input.model, input.prompt_version, input.batch_deadline, at, at);
      const auditId = writeAudit(db, { actor: actorLabel(ctx), entity: "prediction", ref, action: "create_draft", after: v });
      return { prediction_ref: ref, stored_at: at, audit_id: auditId };
    });
  },
});
