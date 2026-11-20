/**
 * BASE-10 — معالجة أخطاء موحدة: رمز ثابت (للعقود والاختبارات) + رسالة عربية مفهومة للمستخدم.
 * التفاصيل التقنية تبقى في سجل الخادم ولا تظهر في الواجهة (لا stack trace).
 */
export type ErrorCode =
  // رموز العقود C-1..C-4 (S2 حرفياً)
  | "SOURCE_UNAVAILABLE" | "REJECTED_SCHEMA" | "FORBIDDEN_MODIFY_APPROVED" | "REJECTED_RANGE"
  | "UNKNOWN_CASE" | "REJECTED_NOT_APPROVED"
  // الحمايات والتشغيل
  | "KILL_SWITCH" | "CAP_EXCEEDED" | "TIMEOUT" | "PII_DETECTED" | "FORBIDDEN_TOOL" | "NEEDS_REEVAL"
  | "MODEL_ERROR" | "CONFIG_INVALID" | "TRACE_FAILED" | "DUPLICATE" | "NOT_FOUND"
  // الواجهة
  | "UNAUTHORIZED" | "CSRF" | "RATE_LIMITED" | "BAD_REQUEST" | "INTERNAL";

const MESSAGES: Record<ErrorCode, string> = {
  SOURCE_UNAVAILABLE: "سجلات المشفى غير متاحة الآن — توقفت الدورة بلا توقع (لا مصدر بديل).",
  REJECTED_SCHEMA: "البيانات لا تطابق البنية المعتمدة — رُفضت ولم يُكتب شيء.",
  FORBIDDEN_MODIFY_APPROVED: "هذا السجل معتمد ولا يُعدَّل — أي تصحيح يمر بقرار إنساني مسجل.",
  REJECTED_RANGE: "قيمة خارج المدى المسموح — رُفضت ولم تُصحَّح.",
  UNKNOWN_CASE: "رقم الحالة غير معروف في سجلات الدورة.",
  REJECTED_NOT_APPROVED: "المسودة يجب أن تُبنى على توقع معتمد من الإنسان.",
  KILL_SWITCH: "مفتاح الإيقاف مفعّل — العملية متوقفة حتى يعيد صاحب الحضانة تشغيلها.",
  CAP_EXCEEDED: "تجاوزت الدورة سقفها المحدد — توقفت بأمان وصُعّد الأمر للإنسان.",
  TIMEOUT: "انتهت المهلة المحددة — توقفت العملية بأمان.",
  PII_DETECTED: "اكتُشف معرف شخصي في بيانات خارجة — أُوقفت العملية حمايةً للخصوصية.",
  FORBIDDEN_TOOL: "الأداة غير مسموحة لهذا الطرف أو في هذه المرحلة.",
  NEEDS_REEVAL: "النموذج أو التعليمات تغيّرت منذ آخر تقييم ناجح — شغّل التقييم أولاً (npm run eval:live).",
  MODEL_ERROR: "تعذّر الحصول على رد صالح من النموذج.",
  CONFIG_INVALID: "الإعدادات ناقصة أو غير صالحة.",
  TRACE_FAILED: "تعذّر تسجيل التتبع — لا تشغيل بلا تتبّع، توقفت العملية.",
  DUPLICATE: "هذا الإدخال مسجل من قبل.",
  NOT_FOUND: "غير موجود.",
  UNAUTHORIZED: "يلزم تسجيل الدخول.",
  CSRF: "انتهت صلاحية النموذج — حدّث الصفحة وحاول مرة ثانية.",
  RATE_LIMITED: "محاولات كثيرة — انتظر قليلاً ثم حاول.",
  BAD_REQUEST: "طلب غير صالح.",
  INTERNAL: "حدث خطأ غير متوقع — سُجّل للمراجعة.",
};

const STATUS: Partial<Record<ErrorCode, number>> = {
  NOT_FOUND: 404, UNAUTHORIZED: 401, CSRF: 403, FORBIDDEN_TOOL: 403, RATE_LIMITED: 429,
  BAD_REQUEST: 400, REJECTED_SCHEMA: 422, REJECTED_RANGE: 422, UNKNOWN_CASE: 422, DUPLICATE: 409,
  FORBIDDEN_MODIFY_APPROVED: 409, REJECTED_NOT_APPROVED: 409, KILL_SWITCH: 503, SOURCE_UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly status: number;
  readonly detail: string;
  constructor(code: ErrorCode, detail = "", userMessage?: string) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.userMessage = userMessage || MESSAGES[code];
    this.status = STATUS[code] ?? 500;
  }
}

export function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new AppError("INTERNAL", msg);
}

/** سطر سجل الخادم: تفاصيل كاملة للمطوّر — يمر عبر منقّي الأسرار قبل الكتابة (observability/trace.ts) */
export function logServerError(where: string, e: unknown, scrub: (s: string) => string = (s) => s): void {
  const err = asAppError(e);
  const stack = e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : "";
  console.error(scrub(`[AGENTE] ${new Date().toISOString()} ${where} ${err.code} ${err.detail}${stack ? " :: " + stack : ""}`));
}
