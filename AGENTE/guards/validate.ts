/**
 * MIT-4 / HR-2 / HR-3 — تحقق صارم من كل مخرج نموذج قبل أي كتابة أو عرض، ومن كل إدخال يدوي (MIT-2).
 * القاعدة: الرفض لا التصحيح — مخرج غير مطابق يُرفض بسبب واضح ويُعاد للنموذج أو يُصعَّد (ضمن سقف HR-4).
 * لا حقول مخترعة: أي حقل غير موجود في عقد S2 يُرفض.
 */
import { AppError } from "../observability/errors.ts";

export type RiskClass = "low" | "medium" | "high";
export const RISK_CLASSES: RiskClass[] = ["low", "medium", "high"];
export const RISK_RANK: Record<RiskClass, number> = { low: 0, medium: 1, high: 2 };
export const ACTION_KINDS = ["نقل", "تجهيز", "إبلاغ"] as const;
export type ActionKind = typeof ACTION_KINDS[number];

export interface BasisDoc { sources: "TL-1"[]; weighting_note: string; confidence_flag: "normal" | "low" }
export interface PerInfant { infant_ref: string; apgar_value_estimate: number | null; apgar_class: RiskClass; basis_ref: string }
export interface PredictionInput {
  count_value: number;
  risk_class: RiskClass;
  per_infant: PerInfant[];
  basis: BasisDoc;
  missing_fields: string[];
}
export interface PreparationInput { items: { item: string; qty?: number }[] }
export interface ActionInput {
  kind: ActionKind;
  payload: { summary: string; infant_refs: string[]; justification: string };
  alternatives: string[];
}

const reject = (why: string): never => { throw new AppError("REJECTED_SCHEMA", why, `رُفض: ${why}`); };

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) reject(`${what} يجب أن يكون كائناً`);
  return v as Record<string, unknown>;
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) reject(`${what}: حقول غير موجودة في العقد (${extra.join(", ")})`);
}

/** نص آمن: طول محدود وبلا محارف تحكم (لا HTML خام يُنفَّذ — العرض كله مُهرَّب أصلاً) */
export function text(v: unknown, what: string, min: number, max: number): string {
  if (typeof v !== "string") reject(`${what} نص مطلوب`);
  const s = (v as string).trim();
  if (s.length < min || s.length > max) reject(`${what} طوله بين ${min} و ${max}`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) reject(`${what} يحوي محارف تحكم`);
  return s;
}

function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) reject(`${what} عدد صحيح بين ${min} و ${max}`);
  return v as number;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], what: string): T {
  if (typeof v !== "string" || !options.includes(v as T)) reject(`${what} يجب أن يكون واحداً من: ${options.join(" / ")}`);
  return v as T;
}

export interface CaseInfo { case_ref: string; expected_infants: number; missing: string[] }

/** infant_ref = "<case_ref>#<n>" — يربط الطفل المتوقع بحالته (أساس المقارنة EV-6) */
export const INFANT_REF = /^(H-\d{4,6})#([1-9]\d?)$/;

export function maxRisk(classes: RiskClass[]): RiskClass {
  return classes.reduce<RiskClass>((m, c) => (RISK_RANK[c] > RISK_RANK[m] ? c : m), "low");
}

/**
 * PredictionDraft من النموذج (C-2): يُتحقق منه مقابل حالات الدورة نفسها.
 * - count_value = عدد الأطفال المتوقع وصولهم = طول per_infant (اتساق القيمة والقائمة)
 * - risk_class = أعلى فئة بين الأطفال («حرجة» = high — DEC-5 ج)
 * - كل infant_ref لحالة في الدورة وبحدود عدد أجنّتها؛ لا تكرار
 * - basis.sources = ["TL-1"] حصراً (EV-3 / BR-3)
 * - missing_fields: إن ذكرها النموذج فلا يذكر ما ليس ناقصاً؛ القائمة المعتمدة تُحسب من البيانات (EV-2)
 */
export function validatePrediction(raw: unknown, cases: CaseInfo[], maxInfantsPerCase: number): PredictionInput {
  const o = obj(raw, "التوقع");
  onlyKeys(o, ["count_value", "risk_class", "per_infant", "basis", "missing_fields"], "التوقع");
  if (!Array.isArray(o.per_infant)) reject("per_infant قائمة مطلوبة");
  const byCase = new Map(cases.map((c) => [c.case_ref, c]));
  const seen = new Set<string>();
  const perCase = new Map<string, number>();
  const perInfant: PerInfant[] = (o.per_infant as unknown[]).map((p, i) => {
    const e = obj(p, `per_infant[${i}]`);
    onlyKeys(e, ["infant_ref", "apgar_value_estimate", "apgar_class", "basis_ref"], `per_infant[${i}]`);
    const ref = text(e.infant_ref, `per_infant[${i}].infant_ref`, 3, 20);
    const m = INFANT_REF.exec(ref);
    if (!m) reject(`per_infant[${i}].infant_ref بصيغة H-0001#1`);
    const c = byCase.get(m![1]);
    if (!c) reject(`per_infant[${i}]: الحالة ${m![1]} ليست من حالات الدورة (لا حالات مخترعة)`);
    const n = Number(m![2]);
    if (n > Math.min(c!.expected_infants, maxInfantsPerCase)) reject(`per_infant[${i}]: ${ref} يتجاوز عدد الأجنّة المسجل للحالة`);
    if (seen.has(ref)) reject(`per_infant: ${ref} مكرر`);
    seen.add(ref);
    perCase.set(c!.case_ref, (perCase.get(c!.case_ref) || 0) + 1);
    const est = e.apgar_value_estimate === null ? null : int(e.apgar_value_estimate, `per_infant[${i}].apgar_value_estimate`, 0, 10);
    return {
      infant_ref: ref,
      apgar_value_estimate: est,
      apgar_class: oneOf(e.apgar_class, RISK_CLASSES, `per_infant[${i}].apgar_class`),
      basis_ref: text(e.basis_ref, `per_infant[${i}].basis_ref`, 1, 300),
    };
  });
  const count = int(o.count_value, "count_value", 0, 10_000);
  if (count !== perInfant.length) reject(`count_value (${count}) يجب أن يساوي عدد الأطفال في per_infant (${perInfant.length})`);
  const derived = maxRisk(perInfant.map((p) => p.apgar_class));
  const risk = oneOf(o.risk_class, RISK_CLASSES, "risk_class");
  if (risk !== derived) reject(`risk_class (${risk}) يجب أن يساوي أعلى فئة بين الأطفال (${derived})`);

  const b = obj(o.basis, "basis");
  onlyKeys(b, ["sources", "weighting_note", "confidence_flag"], "basis");
  if (!Array.isArray(b.sources) || b.sources.length !== 1 || b.sources[0] !== "TL-1") {
    reject("basis.sources يجب أن يكون [\"TL-1\"] حصراً — لا مصدر خارج سجلات المشفى (EV-3)");
  }
  const basis: BasisDoc = {
    sources: ["TL-1"],
    weighting_note: text(b.weighting_note, "basis.weighting_note", 10, 2000),
    confidence_flag: oneOf(b.confidence_flag, ["normal", "low"] as const, "basis.confidence_flag"),
  };

  const realMissing = new Set(cases.flatMap((c) => c.missing.map((f) => `${c.case_ref}.${f}`)));
  if (o.missing_fields !== undefined) {
    if (!Array.isArray(o.missing_fields)) reject("missing_fields قائمة");
    for (const f of o.missing_fields as unknown[]) {
      if (typeof f !== "string" || !realMissing.has(f)) reject(`missing_fields: «${String(f)}» ليس حقلاً ناقصاً فعلاً`);
    }
  }
  // القائمة المعتمدة من البيانات نفسها: الناقص يُعلَّم دائماً ولا يُملأ (EV-2 / HR-3)
  const missing = [...realMissing].sort();
  if (missing.length && basis.confidence_flag !== "low") {
    reject("توجد حقول ناقصة: basis.confidence_flag يجب أن يكون low (لا ثقة عادية مع نقص — RT-5)");
  }
  return { count_value: count, risk_class: risk, per_infant: perInfant, basis, missing_fields: missing };
}

/** C-4 PreparationDraft.items */
export function validatePreparation(raw: unknown): PreparationInput {
  const o = obj(raw, "مسودة التحضير");
  onlyKeys(o, ["items"], "مسودة التحضير");
  if (!Array.isArray(o.items) || o.items.length < 1 || o.items.length > 30) reject("items بين 1 و 30 بنداً");
  const items = (o.items as unknown[]).map((it, i) => {
    const e = obj(it, `items[${i}]`);
    onlyKeys(e, ["item", "qty"], `items[${i}]`);
    const item = text(e.item, `items[${i}].item`, 2, 200);
    return e.qty === undefined || e.qty === null ? { item } : { item, qty: int(e.qty, `items[${i}].qty`, 0, 100) };
  });
  return { items };
}

/** C-4/C-7 ActionDraft — مسودة فقط؛ كل فعل مربوط بأطفال من التوقع المعتمد ومبرَّر (EV-4) */
export function validateAction(raw: unknown, approved: { per_infant: PerInfant[] }): ActionInput {
  const o = obj(raw, "مسودة الفعل");
  onlyKeys(o, ["kind", "payload", "alternatives"], "مسودة الفعل");
  const kind = oneOf(o.kind, ACTION_KINDS, "kind");
  const p = obj(o.payload, "payload");
  onlyKeys(p, ["summary", "infant_refs", "justification"], "payload");
  if (!Array.isArray(p.infant_refs) || p.infant_refs.length < 1) reject("payload.infant_refs قائمة غير فارغة");
  const known = new Map(approved.per_infant.map((x) => [x.infant_ref, x]));
  const refs = (p.infant_refs as unknown[]).map((r, i) => {
    const s = text(r, `payload.infant_refs[${i}]`, 3, 20);
    if (!known.has(s)) reject(`payload.infant_refs: ${s} ليس في التوقع المعتمد`);
    return s;
  });
  // EV-4: لا حجز/نقل لموارد أعلى بلا مبرر من البيانات — يلزم طفل واحد على الأقل بفئة medium أو high
  if ((kind === "نقل" || kind === "تجهيز") && !refs.some((r) => known.get(r)!.apgar_class !== "low")) {
    reject("لا نقل/تجهيز لموارد أعلى لأطفال كلهم بفئة low — بلا مبرر من البيانات (EV-4)");
  }
  const alternatives = o.alternatives === undefined ? [] : (() => {
    if (!Array.isArray(o.alternatives) || o.alternatives.length > 5) reject("alternatives قائمة حتى 5 بنود");
    return (o.alternatives as unknown[]).map((a, i) => text(a, `alternatives[${i}]`, 2, 200));
  })();
  return {
    kind,
    payload: {
      summary: text(p.summary, "payload.summary", 5, 500),
      infant_refs: refs,
      justification: text(p.justification, "payload.justification", 5, 500),
    },
    alternatives,
  };
}

/** C-8 قرار الإنسان — أزرار ونماذج فقط، السبب إلزامي */
export function validateDecision(raw: { decision?: unknown; reason?: unknown }): { decision: "approve" | "modify" | "reject"; reason: string } {
  return {
    decision: oneOf(raw.decision, ["approve", "modify", "reject"] as const, "decision"),
    reason: text(raw.reason, "السبب", 3, 1000),
  };
}

/** MIT-2 — إدخال المقياس الفعلي (TB-2): حقول مقيدة، والنص الحر معزول في الملاحظة */
export function validateOutcomeInput(raw: Record<string, unknown>, now = Date.now()): {
  case_ref: string; birth_datetime: string; apgar_value: number; note: string | null;
} {
  onlyKeys(raw, ["case_ref", "birth_datetime", "apgar_value", "note"], "المقياس");
  const caseRef = text(raw.case_ref, "رقم الحالة", 3, 12);
  if (!/^H-\d{4,6}$/.test(caseRef)) reject("رقم الحالة بصيغة H-0001");
  const dt = text(raw.birth_datetime, "وقت الولادة", 10, 40);
  const t = Date.parse(dt);
  if (Number.isNaN(t)) reject("وقت الولادة غير صالح");
  if (t > now + 10 * 60_000) reject("وقت الولادة في المستقبل");
  if (t < Date.parse("2020-01-01")) reject("وقت الولادة قديم جداً");
  const apgarRaw = raw.apgar_value;
  const apgarStr = typeof apgarRaw === "number" ? String(apgarRaw) : typeof apgarRaw === "string" ? apgarRaw.trim() : "";
  // رقم صحيح فقط — «17» أو «٧» أو «7.5» أو نص تُرفض ولا تُصحَّح (HR-2 / RT-2)
  if (!/^\d{1,2}$/.test(apgarStr)) throw new AppError("REJECTED_RANGE", `apgar=${apgarStr.slice(0, 20)}`, "مقياس Apgar عدد صحيح من 0 إلى 10 — رُفض ولم يُصحَّح.");
  const apgar = Number(apgarStr);
  if (apgar < 0 || apgar > 10) throw new AppError("REJECTED_RANGE", `apgar=${apgar}`, "مقياس Apgar عدد صحيح من 0 إلى 10 — رُفض ولم يُصحَّح.");
  const note = raw.note === undefined || raw.note === null || String(raw.note).trim() === "" ? null : text(raw.note, "الملاحظة", 1, 500);
  return { case_ref: caseRef, birth_datetime: new Date(t).toISOString(), apgar_value: apgar, note };
}

/** فئة الخطر من قيمة Apgar وفق نطاقات الإعدادات (قيمة منخفضة = خطر أعلى) */
export function apgarClass(value: number, bands: { high_risk_max: number; medium_risk_max: number }): RiskClass {
  if (value <= bands.high_risk_max) return "high";
  if (value <= bands.medium_risk_max) return "medium";
  return "low";
}
