/**
 * نقاط الإنسان HITL-1/2/3 — عرض C-5/C-6/C-7 بالأساس والنواقص (MIT-6 / HR-3)، وقرار مهيكل حصراً (C-8 / C-9).
 * لا نص حر كقرار، السبب إلزامي، هوية الموافق من الجلسة. كل قرار → decisions + hitl_log (BASE-A6) + audit (C-12) في معاملة واحدة.
 * HITL-3: الموافقة تُسجَّل وتنقل التنفيذ للإنسان خارج النظام (END-2)؛ الرفض END-1. لا تنفيذ آلي (DEC-9).
 */
import type { AppContext } from "../agents/context.ts";
import { runPrepare, runCycle, casesForCycle } from "../agents/agt1.ts";
import { AppError } from "../observability/errors.ts";
import { tx, nowIso, writeAudit, nextDailyRef, type Db } from "../storage/db.ts";
import { validateDecision, validatePrediction } from "../guards/validate.ts";
import { assertNoPII } from "../guards/pii.ts";
import { getPrediction, toDraft, caseInfos, type PredictionRow } from "../tools/tl2_predictions.ts";
import { getDiscrepancy, getOutcome } from "../tools/tl3_outcomes.ts";
import { getDraft, listDrafts } from "../tools/tl4_drafts.ts";
import { resolveAlerts } from "./alerts.ts";

/** C-5 — S2 حرفياً (+ تفاصيل الأساس والحالات للعرض) */
export function packageC5(app: AppContext, ref: string) {
  const p = getPrediction(app.db, ref);
  if (!p) throw new AppError("NOT_FOUND", ref);
  const c5 = {
    cycle_id: p.cycle_id, prediction_ref: p.prediction_ref, count_value: p.count_value, risk_class: p.risk_class,
    per_infant: p.per_infant, basis_summary: p.basis.weighting_note, missing_fields: p.missing_fields,
    critical_alert: p.risk_class === "high", batch_deadline: p.batch_deadline,
  };
  // HR-3: لا عرض لتوقع بلا أساس
  if (!p.basis?.weighting_note || !p.basis.sources?.length) throw new AppError("REJECTED_SCHEMA", "no basis", "لا يُعرض توقع بلا أساس موثق.");
  assertNoPII(c5, [...app.identities], "C-5");
  return { c5, prediction: p, basis: p.basis, cases: casesForCycle(app, p.cycle_id) };
}

/** C-6 */
export function packageC6(app: AppContext, ref: string) {
  const d = getDiscrepancy(app.db, ref);
  if (!d) throw new AppError("NOT_FOUND", ref);
  const o = getOutcome(app.db, d.actual_ref)!;
  const c6 = {
    discrepancy_ref: d.discrepancy_ref, prediction_ref: d.prediction_ref,
    predicted: d.predicted ? { count_value: d.predicted.count_value, risk_class: d.predicted.risk_class } : null,
    actual: { apgar_value: o.apgar_value, apgar_class: o.apgar_class },
    class_mismatch: d.class_mismatch, resources_reserved: d.resources_reserved, escalate: d.escalated,
  };
  const reserved = d.prediction_ref === "UNPLANNED" ? [] : listDrafts(app.db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", d.prediction_ref);
  return { c6, discrepancy: d, outcome: o, reserved, prediction: d.prediction_ref === "UNPLANNED" ? null : getPrediction(app.db, d.prediction_ref) };
}

/** C-7 */
export function packageC7(app: AppContext, ref: string) {
  const d = getDraft(app.db, ref);
  if (!d || d.draft_type !== "action") throw new AppError("NOT_FOUND", ref);
  const c7 = { action_draft_ref: d.draft_ref, kind: d.action_kind, payload_summary: d.payload?.summary ?? "", based_on: d.based_on, alternatives: d.alternatives };
  return { c7, draft: d, prediction: getPrediction(app.db, d.based_on) };
}

function decisionRef(db: Db): string {
  return nextDailyRef(db, "HD", "decisions", "decision_id");
}

function logHitl(db: Db, e: { hitl: string; subject_ref: string; shown: unknown; decision_id: string; decided_by: string; decision: string; reason: string; after: string }) {
  db.prepare(`INSERT INTO hitl_log (ts, hitl, subject_ref, shown_json, decision_id, decided_by, decision, reason, after_effect)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nowIso(), e.hitl, e.subject_ref, JSON.stringify(e.shown), e.decision_id, e.decided_by, e.decision, e.reason, e.after);
}

/** تعديل الإنسان: قائمة الأطفال بعد تعديله (الفئة/التقدير/الحذف) → PredictionDraft يمر بنفس تحقق MIT-4 */
export interface HumanEdit { per_infant: { infant_ref: string; apgar_class: string; apgar_value_estimate: number | null; keep: boolean }[]; note: string }

function applyEdit(db: Db, p: PredictionRow, edit: HumanEdit, maxInfants: number) {
  const kept = edit.per_infant.filter((i) => i.keep);
  const original = new Map(p.per_infant.map((i) => [i.infant_ref, i]));
  for (const k of edit.per_infant) if (!original.has(k.infant_ref)) throw new AppError("REJECTED_SCHEMA", `unknown infant ${k.infant_ref}`);
  const order = ["low", "medium", "high"];
  const per = kept.map((k) => ({ infant_ref: k.infant_ref, apgar_value_estimate: k.apgar_value_estimate, apgar_class: k.apgar_class, basis_ref: original.get(k.infant_ref)!.basis_ref }));
  const risk = per.reduce((m, x) => (order.indexOf(x.apgar_class) > order.indexOf(m) ? x.apgar_class : m), "low");
  return validatePrediction({
    count_value: per.length, risk_class: risk, per_infant: per,
    basis: { ...p.basis, weighting_note: `${p.basis.weighting_note}\n— عدّله الإنسان: ${edit.note}`.slice(0, 2000) },
  }, caseInfos(db, p.cycle_id), maxInfants);
}

/** HITL-1: اعتماد / تعديل / رفض التوقع. الاعتماد أو التعديل يفعّل مسودة التحضير (runPrepare) */
export function decideHitl1(app: AppContext, input: { prediction_ref: string; decision: string; reason: string; edit?: HumanEdit }, user: string):
  { decision_id: string; prepare?: Promise<unknown> } {
  const { db, cfg } = app;
  const d = validateDecision(input);
  const p = getPrediction(db, input.prediction_ref);
  if (!p) throw new AppError("NOT_FOUND", input.prediction_ref);
  if (p.status !== "draft") throw new AppError("FORBIDDEN_MODIFY_APPROVED", p.prediction_ref, "قُرر هذا التوقع من قبل.");
  const shown = packageC5(app, p.prediction_ref).c5;
  const modified = d.decision === "modify" ? applyEdit(db, p, input.edit ?? { per_infant: [], note: "" }, cfg.caps.max_infants_per_case) : null;
  const status = d.decision === "approve" ? "approved" : d.decision === "modify" ? "modified" : "rejected";
  const id = tx(db, () => {
    const id = decisionRef(db);
    const at = nowIso();
    if (modified) {
      db.prepare(`UPDATE predictions SET count_value = ?, risk_class = ?, per_infant_json = ?, basis_json = ?, missing_fields_json = ?, status = 'modified', updated_at = ? WHERE prediction_ref = ?`)
        .run(modified.count_value, modified.risk_class, JSON.stringify(modified.per_infant), JSON.stringify(modified.basis), JSON.stringify(modified.missing_fields), at, p.prediction_ref);
    } else {
      db.prepare("UPDATE predictions SET status = ?, updated_at = ? WHERE prediction_ref = ?").run(status, at, p.prediction_ref);
    }
    db.prepare(`INSERT INTO decisions (decision_id, hitl, subject_ref, decision, modified_payload_json, reason, decided_by, decided_at)
                VALUES (?, 'HITL-1', ?, ?, ?, ?, ?, ?)`).run(id, p.prediction_ref, d.decision, modified ? JSON.stringify({ ...toDraft(p), ...modified, status: "modified" }) : null, d.reason, user, at);
    db.prepare("UPDATE cycles SET status = ? WHERE cycle_id = ?").run(status === "rejected" ? "rejected" : "approved", p.cycle_id);
    const after = status === "rejected" ? "التوقع مرفوض — لا استخدام له (BR-1)؛ يمكن تشغيل دورة جديدة" : "التوقع معتمد — بدأ تجهيز مسودة التحضير (TL-4)";
    logHitl(db, { hitl: "HITL-1", subject_ref: p.prediction_ref, shown, decision_id: id, decided_by: user, decision: d.decision, reason: d.reason, after });
    writeAudit(db, { actor: `human:${user}`, entity: "decision", ref: p.prediction_ref, action: `HITL-1:${d.decision}`, before: { status: p.status }, after: { status, decision_id: id, ...(modified ? { modified } : {}) }, reason: d.reason });
    return id;
  });
  resolveAlerts(app, p.prediction_ref, user);
  return { decision_id: id, prepare: status === "rejected" ? undefined : runPrepare(app, p.prediction_ref) };
}

/**
 * HITL-2: قرار الخلاف — الخيارات الثلاثة تُسجَّل على Decision.decision (DEV-5):
 *  إبقاء = approve (السبب إلزامي — EV-7) · تعديل توزيع = modify (توقع جديد يعدّله الإنسان + تحضير جديد) · إعادة تقييم = reject (دورة توقع جديدة)
 */
export function decideHitl2(app: AppContext, input: { discrepancy_ref: string; decision: string; reason: string; edit?: HumanEdit }, user: string):
  { decision_id: string; followup?: Promise<unknown> } {
  const { db, cfg } = app;
  const d = validateDecision(input);
  const pk = packageC6(app, input.discrepancy_ref);
  if (!pk.discrepancy.escalated) throw new AppError("BAD_REQUEST", "not escalated", "هذا الفارق لم يُصعَّد — لا يحتاج قرار HITL-2.");
  const done = db.prepare("SELECT 1 FROM decisions WHERE hitl = 'HITL-2' AND subject_ref = ?").get(input.discrepancy_ref);
  if (done) throw new AppError("FORBIDDEN_MODIFY_APPROVED", input.discrepancy_ref, "قُرر هذا الخلاف من قبل.");
  const p = pk.prediction;
  let newRef: string | null = null;
  const modified = d.decision === "modify" && p ? applyEdit(db, p, input.edit ?? { per_infant: [], note: "" }, cfg.caps.max_infants_per_case) : null;
  if (d.decision === "modify" && !modified) throw new AppError("BAD_REQUEST", "nothing to modify", "لا توقع معتمد لتعديل توزيعه.");
  const id = tx(db, () => {
    const id = decisionRef(db);
    const at = nowIso();
    if (modified && p) {
      newRef = nextDailyRef(db, "P", "predictions", "prediction_ref");
      db.prepare(`INSERT INTO predictions (prediction_ref, cycle_id, count_value, risk_class, per_infant_json, basis_json, missing_fields_json,
                  status, origin, supersedes, run_id, model, prompt_version, batch_deadline, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'modified', 'human', ?, ?, NULL, NULL, NULL, ?, ?)`)
        .run(newRef, p.cycle_id, modified.count_value, modified.risk_class, JSON.stringify(modified.per_infant), JSON.stringify(modified.basis),
          JSON.stringify(modified.missing_fields), p.prediction_ref, `hitl2-${id}`, at, at);
      for (const old of listDrafts(db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", p.prediction_ref)) {
        db.prepare("UPDATE drafts SET status = 'superseded', updated_at = ? WHERE draft_ref = ?").run(at, old.draft_ref);
        writeAudit(db, { actor: `human:${user}`, entity: "draft", ref: old.draft_ref, action: "supersede", after: { by_prediction: newRef } });
      }
    }
    db.prepare(`INSERT INTO decisions (decision_id, hitl, subject_ref, decision, modified_payload_json, reason, decided_by, decided_at, outcome)
                VALUES (?, 'HITL-2', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.discrepancy_ref, d.decision, modified ? JSON.stringify(modified) : null, d.reason, user, at, newRef);
    const after = d.decision === "approve" ? "إبقاء التوزيع مع السبب المسجل"
      : d.decision === "modify" ? `توقع معدَّل ${newRef} يحل محل ${p?.prediction_ref} — تحضير جديد`
      : "إعادة تقييم — دورة توقع جديدة تنتظر HITL-1";
    logHitl(db, { hitl: "HITL-2", subject_ref: input.discrepancy_ref, shown: pk.c6, decision_id: id, decided_by: user, decision: d.decision, reason: d.reason, after });
    writeAudit(db, { actor: `human:${user}`, entity: "decision", ref: input.discrepancy_ref, action: `HITL-2:${d.decision}`, after: { decision_id: id, new_prediction: newRef }, reason: d.reason });
    return id;
  });
  resolveAlerts(app, input.discrepancy_ref, user);
  const followup = d.decision === "modify" && newRef ? runPrepare(app, newRef)
    : d.decision === "reject" ? runCycle(app, { trigger: "reassess", actor: `human:${user}` }) : undefined;
  return { decision_id: id, followup };
}

/** HITL-3: موافقة → END-2 (تنفيذ بيد الإنسان خارج النظام) / رفض → END-1. لا عودة للوكيل (DEC-8) */
export function decideHitl3(app: AppContext, input: { draft_ref: string; decision: string; reason: string }, user: string): { decision_id: string; end_state: string } {
  const { db } = app;
  const d = validateDecision(input);
  if (d.decision === "modify") throw new AppError("BAD_REQUEST", "HITL-3 modify", "HITL-3: موافقة أو رفض فقط.");
  const pk = packageC7(app, input.draft_ref);
  if (pk.draft.status !== "pending") throw new AppError("FORBIDDEN_MODIFY_APPROVED", input.draft_ref, "قُررت هذه المسودة من قبل.");
  const end = d.decision === "approve" ? "END_2_HUMAN_EXECUTES" : "END_1_NOT_EXECUTED";
  const id = tx(db, () => {
    const id = decisionRef(db);
    const at = nowIso();
    db.prepare("UPDATE drafts SET status = ?, updated_at = ? WHERE draft_ref = ?").run(d.decision === "approve" ? "approved" : "rejected", at, input.draft_ref);
    db.prepare(`INSERT INTO decisions (decision_id, hitl, subject_ref, decision, reason, decided_by, decided_at, outcome) VALUES (?, 'HITL-3', ?, ?, ?, ?, ?, ?)`)
      .run(id, input.draft_ref, d.decision, d.reason, user, at, end);
    const after = end === "END_2_HUMAN_EXECUTES" ? "END-2: التنفيذ بيد الإنسان خارج النظام — النظام لم ينفّذ شيئاً" : "END-1: لا تنفيذ";
    logHitl(db, { hitl: "HITL-3", subject_ref: input.draft_ref, shown: pk.c7, decision_id: id, decided_by: user, decision: d.decision, reason: d.reason, after });
    writeAudit(db, { actor: `human:${user}`, entity: "decision", ref: input.draft_ref, action: `HITL-3:${d.decision}`, after: { decision_id: id, end_state: end }, reason: d.reason });
    return id;
  });
  resolveAlerts(app, input.draft_ref, user);
  return { decision_id: id, end_state: end };
}

/** C-9 — نهاية الدورة لمسودة فعل */
export function c9For(db: Db, draftRef: string) {
  return db.prepare("SELECT decision_id, decision, decided_by, decided_at, outcome FROM decisions WHERE hitl = 'HITL-3' AND subject_ref = ?").get(draftRef) as
    { decision_id: string; decision: string; decided_by: string; decided_at: string; outcome: string } | undefined;
}

export function decisionFor(db: Db, hitl: string, subject: string) {
  return db.prepare("SELECT * FROM decisions WHERE hitl = ? AND subject_ref = ? ORDER BY decided_at DESC LIMIT 1").get(hitl, subject) as Record<string, string> | undefined;
}
