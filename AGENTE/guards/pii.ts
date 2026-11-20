/**
 * MIT-5 / HR-5 / DEC-13 ب — إخفاء الهوية قبل النموذج، والمخرجات بالرقم المرجعي فقط.
 * + MIT-1 (جزء): كشف تعليمات مدسوسة داخل البيانات (تُعلَّم للإنسان ولا تُنفَّذ).
 */
import { PII_PATTERNS } from "../observability/trace.ts";
import { AppError } from "../observability/errors.ts";

/**
 * قيم الهوية من سجل المصدر:
 *  - strong: القيمة كاملة (الاسم الكامل، رقم الهوية، الجوال، رقم الملف) — ظهورها في أي مخرج = تسرّب يوقف العملية
 *  - weak: أجزاء الاسم (الاسم الأول، اسم العائلة) — تُحجب من النص الحر والسجلات فقط، ولا توقف شيئاً
 *    (أسماء عربية كثيرة كلمات عادية: «أمل»، «نور» — منعها من المخرجات يعطّل الوكيل بلا فائدة)
 */
export function identityTokens(values: unknown[]): { strong: string[]; weak: string[] } {
  const strong = new Set<string>();
  const weak = new Set<string>();
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length >= 3) strong.add(s);
    const parts = s.split(/[\s,،]+/).map((x) => x.trim()).filter((x) => x.length >= 3);
    if (parts.length > 1) for (const part of parts) weak.add(part);
  }
  const byLen = (a: string, b: string) => b.length - a.length;
  return { strong: [...strong].sort(byLen), weak: [...weak].filter((w) => !strong.has(w)).sort(byLen) };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** كلمة كاملة فقط: «حالة» لا تطابق داخل «الحالة» */
export function wholeWord(token: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(token)}(?![\\p{L}\\p{N}])`, "gu");
}

export function redactText(text: string, identities: string[]): { text: string; redacted: boolean } {
  let s = text;
  for (const id of identities) if (id) s = s.replace(wholeWord(id), "[محجوب]");
  for (const re of PII_PATTERNS) s = s.replace(re, "[محجوب]");
  return { text: s, redacted: s !== text };
}

/** يعيد ما وُجد من معرفات (فارغ = نظيف) */
export function findPII(text: string, identities: string[]): string[] {
  const found: string[] = [];
  for (const id of identities) if (id && wholeWord(id).test(text)) found.push(id);
  for (const re of PII_PATTERNS) for (const m of text.matchAll(re)) found.push(m[0]);
  return found;
}

/** يمنع خروج أي معرف شخصي (قبل استدعاء النموذج، وقبل عرض/كتابة مخرجاته) */
export function assertNoPII(payload: unknown, identities: string[], where: string): void {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const found = findPII(text, identities);
  if (found.length) throw new AppError("PII_DETECTED", `${where}: ${found.length} match(es)`);
}

/** MIT-1: عبارات أوامر داخل بيانات المصدر — للتنبيه البشري فقط (البيانات لا تُنفَّذ أصلاً) */
const INJECTION_HINTS = [
  /تجاهل|تجاوز (?:ال)?(?:تعليمات|حساب|قواعد)|صنّ?ف كل|احذف|أوص[ِي]? بحجز|اعتمد (?:التوقع|كل)|نفّ?ذ/,
  /ignore (?:all |the |previous |prior )?(?:instructions|rules)|system prompt|you are now|disregard|override|jailbreak/i,
];

export function injectionFlag(text: string | null | undefined): string | null {
  if (!text) return null;
  return INJECTION_HINTS.some((re) => re.test(text)) ? "تعليمات مشبوهة داخل البيانات — عوملت كنص فقط" : null;
}
