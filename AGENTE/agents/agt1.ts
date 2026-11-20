/**
 * AGT-1 — وكيل التوقع والتحضير (الجراف المعتمد في S1، DEC-8/DEC-9):
 *  UF-1 runCycle   : TL-1 → توقع (نموذج) → TL-2 → C-5 إلى HITL-1 (دفعة يومية + تنبيه فوري للفئة high — DEC-5 ج)
 *  UF-1 runPrepare : بعد اعتماد HITL-1 فقط → مسودة تحضير (TL-4) + مسودات فعل تنتظر HITL-3
 *  UF-2 compareOutcome : حساب حتمي بلا نموذج — مقارنة كل مقياس بتوقعه (EV-6) وتصعيد الخلاف حين توجد موارد محجوزة (EV-4/EV-7)
 * لا أداة تنفيذ إطلاقاً (DEC-9 / HR-6).
 */
import fs from "node:fs";
import type { AppContext } from "./context.ts";
import { buildModel, type ModelClient } from "./model.ts";
import { loadPrompt } from "./prompts.ts";
import { runToolLoop, asData, type AgentTool } from "./loop.ts";
import { Budget } from "../guards/caps.ts";
import { assertEnabled } from "../guards/killswitch.ts";
import { assertNoPII } from "../guards/pii.ts";
import { maxRisk, type RiskClass } from "../guards/validate.ts";
import { resolvePath } from "../config/config.ts";
import { AppError, asAppError, logServerError } from "../observability/errors.ts";
import { newRunId } from "../observability/trace.ts";
import { tx, nowIso, writeAudit } from "../storage/db.ts";
import { invoke, type ToolCtx } from "../tools/registry.ts";
import { TL1_READ, cycleCases } from "../tools/tl1_cases.ts";
import { TL2_WRITE, getPrediction, toDraft, listPredictions, type PredictionRow } from "../tools/tl2_predictions.ts";
import { TL3_DISCREPANCY, getOutcome, listDiscrepancies } from "../tools/tl3_outcomes.ts";
import { TL4_PREPARATION, TL4_ACTION, listDrafts } from "../tools/tl4_drafts.ts";
import { raiseAlert } from "../hitl/alerts.ts";

export function modelFor(app: AppContext): ModelClient {
  return app.modelOverride ?? buildModel(app.cfg);
}

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** MIT-8: لا تشغيل بنموذج/تعليمات تغيّرت منذ آخر تقييم ناجح */
export function evalStatus(app: AppContext, model: ModelClient, promptVersion: string): { ok: boolean; reason: string } {
  if (model.kind !== "live") return { ok: true, reason: model.kind };
  const file = resolvePath(app.cfg, app.cfg.paths.eval_baseline);
  try {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    if (b.model === app.cfg.model.model && b.fallback_model === app.cfg.model.fallback_model && b.prompt_version === promptVersion && b.passed === true) {
      return { ok: true, reason: `baseline ${b.at}` };
    }
    return { ok: false, reason: `آخر تقييم ناجح كان على ${b.model}/${b.prompt_version}` };
  } catch {
    return { ok: false, reason: "لا يوجد تقييم ناجح بعد" };
  }
}

function deadlineFor(app: AppContext, asOf: string): string {
  return new Date(`${asOf}T${app.cfg.schedule.batch_deadline_time}:00`).toISOString();
}

export interface CycleResult { cycle_id: string; status: string; prediction_ref?: string; error?: { code: string; message: string } }

/** UF-1: دورة التوقع (مجدولة يومياً، أو يدوياً، أو إعادة تقييم من HITL-2) */
export async function runCycle(app: AppContext, opts: { as_of?: string; trigger: "schedule" | "manual" | "reassess"; actor?: string } = { trigger: "manual" }): Promise<CycleResult> {
  const { db, cfg } = app;
  const asOf = opts.as_of || localDate();
  const n = (db.prepare("SELECT COUNT(*) AS n FROM cycles WHERE as_of = ?").get(asOf) as { n: number }).n;
  const cycleId = `${asOf}#${n + 1}`;
  const runId = newRunId("c");
  const deadline = deadlineFor(app, asOf);
  db.prepare("INSERT INTO cycles (cycle_id, as_of, status, run_id, started_at, batch_deadline) VALUES (?, ?, 'running', ?, ?, ?)")
    .run(cycleId, asOf, runId, nowIso(), deadline);
  tx(db, () => writeAudit(db, { actor: opts.actor || "system", entity: "cycle", ref: cycleId, action: `start:${opts.trigger}` }));

  const ctx: ToolCtx = { app, run_id: runId, actor: "AGT-1", actorName: "AGT-1" };
  const model = modelFor(app);
  try {
    assertEnabled(cfg, "model");
    const prompt = loadPrompt(cfg, "AGT-1");
    const ev = evalStatus(app, model, prompt.version);
    if (!ev.ok) throw new AppError("NEEDS_REEVAL", ev.reason);
    let readDone: unknown = null;
    let submitted: string | null = null;
    const tools: AgentTool[] = [
      {
        spec: {
          name: "read_pregnancy_cases",
          description: "TL-1: يقرأ حوامل نافذة الأسبوع الأخير من سجلات المشفى (مرة واحدة في الدورة). المدخل {as_of, window_days}.",
          parameters: { type: "object", properties: { as_of: { type: "string" }, window_days: { type: "integer" } }, required: ["as_of", "window_days"], additionalProperties: false },
        },
        async run(args) {
          if (readDone) return readDone; // HR-4: استدعاء واحد لكل دورة — التكرار يعيد النتيجة نفسها
          if (args.as_of !== asOf) throw new AppError("REJECTED_SCHEMA", "as_of", `تاريخ الدورة ${asOf} حصراً.`);
          const r = await invoke(TL1_READ, ctx, { cycle_id: cycleId, as_of: asOf, window_days: Number(args.window_days) });
          const cases = r.cases.map((c) => (cfg.privacy.send_notes_to_model ? c : { ...c, notes_raw: null }));
          readDone = asData("TB-1 سجلات المشفى", { cases, source_system: r.source_system, fetched_at: r.fetched_at,
            expected_infants_note: "indicators.expected_infants = عدد الأجنّة (null = غير مسجل، يُحسب 1)" });
          return readDone;
        },
      },
      {
        spec: {
          name: "submit_prediction",
          description: "TL-2: يسجل مسودة التوقع {count_value, risk_class, per_infant[], basis{sources, weighting_note, confidence_flag}, missing_fields?}.",
          parameters: {
            type: "object", additionalProperties: false, required: ["count_value", "risk_class", "per_infant", "basis"],
            properties: {
              count_value: { type: "integer", minimum: 0 },
              risk_class: { type: "string", enum: ["low", "medium", "high"] },
              per_infant: { type: "array", items: { type: "object", additionalProperties: false, required: ["infant_ref", "apgar_value_estimate", "apgar_class", "basis_ref"],
                properties: { infant_ref: { type: "string" }, apgar_value_estimate: { type: ["integer", "null"], minimum: 0, maximum: 10 },
                  apgar_class: { type: "string", enum: ["low", "medium", "high"] }, basis_ref: { type: "string" } } } },
              basis: { type: "object", additionalProperties: false, required: ["sources", "weighting_note", "confidence_flag"],
                properties: { sources: { type: "array", items: { type: "string", enum: ["TL-1"] } }, weighting_note: { type: "string" }, confidence_flag: { type: "string", enum: ["normal", "low"] } } },
              missing_fields: { type: "array", items: { type: "string" } },
            },
          },
        },
        async run(args) {
          if (!readDone) throw new AppError("REJECTED_SCHEMA", "read first", "اقرأ الحالات أولاً بأداة read_pregnancy_cases.");
          const r = await invoke(TL2_WRITE, ctx, { cycle_id: cycleId, draft: args, model: model.modelId, prompt_version: prompt.version, batch_deadline: deadline });
          submitted = r.prediction_ref;
          return r;
        },
      },
    ];
    await runToolLoop(app, {
      run_id: runId, prompt, model, budget: new Budget(cfg), tools,
      user: `دورة ${cycleId}. as_of="${asOf}" window_days=${cfg.window_days}. اقرأ الحالات ثم أرسل التوقع.`,
    });
    if (!submitted) throw new AppError("MODEL_ERROR", "no prediction submitted", "لم يسجل الوكيل توقعاً صالحاً ضمن سقف الدورة.");
    const p = getPrediction(db, submitted)!;
    // MIT-4 / HR-3 / HR-5 قبل العرض: الأساس موجود، النواقص معلّمة، لا معرفات
    assertNoPII(toDraft(p), [...app.identities], "C-5 package");
    db.prepare("UPDATE cycles SET status = 'awaiting_hitl1', finished_at = ? WHERE cycle_id = ?").run(nowIso(), cycleId);
    if (p.risk_class === "high") {
      raiseAlert(app, "critical", p.prediction_ref, `حالة حرجة: التوقع ${p.prediction_ref} فيه طفل متوقع بفئة high — يحتاج قرارك الآن (لا ينتظر دفعة الصباح).`);
    }
    return { cycle_id: cycleId, status: "awaiting_hitl1", prediction_ref: p.prediction_ref };
  } catch (e) {
    const err = asAppError(e);
    logServerError(`cycle ${cycleId}`, e, (s) => app.tracer.scrub(s));
    const status = err.code === "KILL_SWITCH" ? "stopped" : "failed";
    db.prepare("UPDATE cycles SET status = ?, finished_at = ?, error_code = ?, error_detail = ? WHERE cycle_id = ?")
      .run(status, nowIso(), err.code, app.tracer.scrub(err.detail).slice(0, 500), cycleId);
    raiseAlert(app, "cycle_failed", cycleId, `الدورة ${cycleId} لم تكتمل: ${err.userMessage}`);
    return { cycle_id: cycleId, status, error: { code: err.code, message: err.userMessage } };
  }
}

/** UF-1 الخطوة 5 + UF-3 الخطوة 1: مسودات على توقع معتمد حصراً */
export async function runPrepare(app: AppContext, predictionRef: string): Promise<{ ok: boolean; drafts: string[]; error?: string }> {
  const { cfg, db } = app;
  const runId = newRunId("p");
  const ctx: ToolCtx = { app, run_id: runId, actor: "AGT-1", actorName: "AGT-1" };
  const model = modelFor(app);
  const drafts: string[] = [];
  try {
    const prompt = loadPrompt(cfg, "AGT-1");
    const ev = evalStatus(app, model, prompt.version);
    if (!ev.ok) throw new AppError("NEEDS_REEVAL", ev.reason);
    const p = getPrediction(db, predictionRef);
    if (!p || (p.status !== "approved" && p.status !== "modified")) throw new AppError("REJECTED_NOT_APPROVED", predictionRef);
    const tools: AgentTool[] = [
      {
        spec: { name: "get_approved_prediction", description: "TL-2 (قراءة): التوقع المعتمد الذي يُبنى عليه التحضير.", parameters: { type: "object", properties: {}, additionalProperties: false } },
        async run() { const q = getPrediction(db, predictionRef)!; return asData("TB-3 توقع معتمد من الإنسان", { ...toDraft(q) }); },
      },
      {
        spec: {
          name: "create_preparation_draft", description: "TL-4: مسودة تحضير {items:[{item, qty}]} — مسودة فقط لا تنفيذ.",
          parameters: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["item"], properties: { item: { type: "string" }, qty: { type: "integer", minimum: 0 } } } } } },
        },
        async run(args) { const r = await invoke(TL4_PREPARATION, ctx, { based_on: predictionRef, draft: args }); drafts.push(r.draft_ref); return r; },
      },
      {
        spec: {
          name: "create_action_draft", description: "TL-4: مسودة فعل لا رجعة فيه تنتظر موافقة HITL-3 {kind: نقل|تجهيز|إبلاغ, payload:{summary, infant_refs[], justification}, alternatives[]}.",
          parameters: {
            type: "object", additionalProperties: false, required: ["kind", "payload"],
            properties: {
              kind: { type: "string", enum: ["نقل", "تجهيز", "إبلاغ"] },
              payload: { type: "object", additionalProperties: false, required: ["summary", "infant_refs", "justification"],
                properties: { summary: { type: "string" }, infant_refs: { type: "array", items: { type: "string" } }, justification: { type: "string" } } },
              alternatives: { type: "array", items: { type: "string" } },
            },
          },
        },
        async run(args) {
          const r = await invoke(TL4_ACTION, ctx, { based_on: predictionRef, draft: args });
          drafts.push(r.draft_ref);
          raiseAlert(app, "hitl3", r.draft_ref, `مسودة فعل لا رجعة فيه ${r.draft_ref} تنتظر موافقتك (HITL-3).`);
          return r;
        },
      },
    ];
    await runToolLoop(app, { run_id: runId, prompt, model, budget: new Budget(cfg), tools,
      user: `التوقع ${predictionRef} اعتمده الإنسان. جهّز مسودة التحضير، ومسودات الأفعال التي تحتاج موافقة إن لزم.` });
    if (!listDrafts(db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", predictionRef).length) {
      raiseAlert(app, "model", predictionRef, `لم تُنشأ مسودة تحضير للتوقع ${predictionRef} — راجع وأعد المحاولة.`);
    }
    return { ok: true, drafts };
  } catch (e) {
    const err = asAppError(e);
    logServerError(`prepare ${predictionRef}`, e, (s) => app.tracer.scrub(s));
    raiseAlert(app, "model", predictionRef, `تعذّر تجهيز مسودات التوقع ${predictionRef}: ${err.userMessage}`);
    return { ok: false, drafts, error: err.userMessage };
  }
}

/** التوقع المعتمد الأحدث الذي يتضمن هذه الحالة */
function predictionForCase(app: AppContext, caseRef: string): PredictionRow | null {
  for (const p of listPredictions(app.db, "status IN ('approved','modified')")) {
    if (p.per_infant.some((i) => i.infant_ref.startsWith(`${caseRef}#`))) return p;
  }
  return null;
}

/**
 * UF-2 / EV-6 / EV-7 / EV-4: مقارنة حتمية (بلا نموذج) بعد كل ولادة.
 * - الربط: infant_ref = "<case_ref>#<n>"؛ المولود الأول للحالة يقابل #1، الثاني #2... (لا عدّ مزدوج: مقارنة واحدة لكل زوج)
 * - خلاف = فئة المولود الفعلية ≠ الفئة المتوقعة له؛ مولود لم يُتوقع = خلاف أيضاً
 * - التصعيد إلى HITL-2 فقط إن كان للتوقع موارد محجوزة (مسودة تحضير نشطة) — وإلا يُسجَّل فقط (BR-2)
 * - مقياس لحالة بلا توقع معتمد → «UNPLANNED» يُسجَّل وينبَّه عليه ولا يفتح HITL-2
 */
export async function compareOutcome(app: AppContext, actualRef: string): Promise<{ discrepancy_ref: string; class_mismatch: boolean; escalated: boolean }> {
  const { db } = app;
  const o = getOutcome(db, actualRef);
  if (!o) throw new AppError("NOT_FOUND", actualRef);
  const ctx: ToolCtx = { app, run_id: newRunId("m"), actor: "AGT-1", actorName: "AGT-1" };
  const p = predictionForCase(app, o.case_ref);
  if (!p) {
    const r = await invoke(TL3_DISCREPANCY, ctx, { prediction_ref: "UNPLANNED", actual_ref: actualRef, infant_ref: null, predicted: null, class_mismatch: true, resources_reserved: false, escalated: false });
    raiseAlert(app, "unplanned", actualRef, `ولادة للحالة ${o.case_ref} بلا توقع معتمد سابق — سُجّلت كفارق غير مبرمج.`);
    return { discrepancy_ref: r.discrepancy_ref, class_mismatch: true, escalated: false };
  }
  const earlier = (db.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE case_ref = ? AND (birth_datetime < ? OR (birth_datetime = ? AND actual_ref < ?))")
    .get(o.case_ref, o.birth_datetime, o.birth_datetime, actualRef) as { n: number }).n;
  const infantRef = `${o.case_ref}#${earlier + 1}`;
  const infant = p.per_infant.find((i) => i.infant_ref === infantRef) || null;
  const mismatch = !infant || infant.apgar_class !== o.apgar_class;
  const reserved = listDrafts(db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", p.prediction_ref).length > 0;
  const escalate = mismatch && reserved;
  const r = await invoke(TL3_DISCREPANCY, ctx, {
    prediction_ref: p.prediction_ref, actual_ref: actualRef, infant_ref: infant ? infantRef : null,
    predicted: { count_value: p.count_value, risk_class: p.risk_class, infant_class: infant?.apgar_class ?? null, apgar_value_estimate: infant?.apgar_value_estimate ?? null },
    class_mismatch: mismatch, resources_reserved: reserved, escalated: escalate,
  });
  if (escalate) {
    raiseAlert(app, "hitl2", r.discrepancy_ref, `خلاف على توقع حُجزت له موارد (${p.prediction_ref} ↔ ${actualRef}): المتوقع ${infant?.apgar_class ?? "لم يُتوقع"} والفعلي ${o.apgar_class} — يحتاج قرارك (HITL-2).`);
  }
  return { discrepancy_ref: r.discrepancy_ref, class_mismatch: mismatch, escalated: escalate };
}

/** الخلافات المفتوحة التي تنتظر قرار HITL-2 */
export function openEscalations(app: AppContext) {
  return listDiscrepancies(app.db, "escalated = 1 AND discrepancy_ref NOT IN (SELECT subject_ref FROM decisions WHERE hitl = 'HITL-2')");
}

/** حالات الدورة للعرض (مع علم الملاحظات المشبوهة) */
export function casesForCycle(app: AppContext, cycleId: string) {
  return cycleCases({ app }, cycleId);
}

export function riskOf(classes: RiskClass[]): RiskClass {
  return maxRisk(classes);
}
