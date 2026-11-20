/**
 * C-10 TraceRecord (BASE-A1): سطر JSONL لكل استدعاء نموذج أو أداة أو قرار — append-only في data/trace/.
 * كل سطر يحمل إصدار التعليمات والنموذج (BASE-A5). الأسرار تُنقّى قبل الكتابة (BASE-A7)،
 * وأي معرف شخصي يُحجب كطبقة دفاع ثانية بعد إخفاء الهوية (MIT-5 / HR-5).
 * فشل الكتابة → محاولة واحدة ثم توقف آمن: لا تشغيل بلا تتبّع.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppError } from "./errors.ts";

export type TraceComponent = "AGT-1" | "TL-1" | "TL-2" | "TL-3" | "TL-4" | "hitl" | "eval" | "system";

export interface TraceLine {
  run_id: string;
  ts: string;
  component: TraceComponent;
  model?: string;
  prompt_version?: string;
  input_digest: string;
  output_digest: string;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  ms: number;
  outcome: string;
  /** المدخل والمخرج نفسيهما (بعد إخفاء الهوية والتنقية) — للتحقيق والتقييم */
  input?: unknown;
  output?: unknown;
}

export function digest(v: unknown): string {
  return "sha256:" + crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v ?? null)).digest("hex").slice(0, 32);
}

/** معرّف تشغيل بمجموعات أرقام قصيرة (لا يشبه رقم هوية فلا يحجبه منقّي المعرفات) */
export function newRunId(prefix = "r"): string {
  const iso = new Date().toISOString();
  return `${prefix}-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}-${crypto.randomBytes(3).toString("hex")}`;
}

/** أنماط أسرار شائعة — تُحجب حتى لو لم تكن معروفة مسبقاً */
const SECRET_PATTERNS = [/\bsk-[A-Za-z0-9_-]{12,}\b/g, /\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi, /\bAIza[0-9A-Za-z_-]{20,}\b/g];
/**
 * معرفات شخصية عامة: أرقام هوية/ملف/هاتف (7+ أرقام متتالية، لاتينية أو عربية)، هاتف بفواصل، بريد إلكتروني.
 * التواريخ (2026-11-20) والمعرّفات الداخلية (P-2026-11-20-01، مجموعات ≤4 أرقام) لا تطابقها عمداً.
 */
export const PII_PATTERNS = [
  /(?<![\w-])\d{7,}(?![\w-])/g,
  /(?<![\w])\+?\d{2,4}[ -]\d{3}[ -]\d{3,4}(?![\w])/g,
  /\+\d{1,3}[ -]?\d{2,3}[ -]?\d{3}[ -]?\d{3,4}/g,
  /[\u0660-\u0669\u06F0-\u06F9]{7,}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

export class Tracer {
  private dir: string;
  private secrets: string[];
  private identities: () => string[];
  constructor(dir: string, secrets: string[] = [], identities: () => string[] = () => []) {
    this.dir = dir;
    this.secrets = secrets;
    this.identities = identities;
  }

  scrub(text: string): string {
    let s = text;
    for (const v of this.secrets) if (v) s = s.split(v).join("[سر محجوب]");
    for (const re of SECRET_PATTERNS) s = s.replace(re, (_m, p1) => (typeof p1 === "string" && /bearer/i.test(p1) ? "Bearer [سر محجوب]" : "[سر محجوب]"));
    for (const id of this.identities()) {
      if (id && id.length >= 3) s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu"), "[محجوب]");
    }
    for (const re of PII_PATTERNS) s = s.replace(re, "[محجوب]");
    return s;
  }

  write(line: Omit<TraceLine, "ts"> & { ts?: string }): TraceLine {
    const full: TraceLine = { ...line, ts: line.ts || new Date().toISOString() } as TraceLine;
    const text = this.scrub(JSON.stringify(full));
    const file = path.join(this.dir, `${full.ts.slice(0, 10)}.jsonl`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.appendFileSync(file, text + "\n", { encoding: "utf8", mode: 0o600 });
        return full;
      } catch (e) {
        if (attempt === 1) throw new AppError("TRACE_FAILED", (e as Error).message);
      }
    }
    return full;
  }

  /** قراءة سطور تشغيل معيّن (للتقييم والتحقيق) */
  read(runId?: string): TraceLine[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: TraceLine[] = [];
    for (const f of fs.readdirSync(this.dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      for (const l of fs.readFileSync(path.join(this.dir, f), "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          const t = JSON.parse(l) as TraceLine;
          if (!runId || t.run_id === runId) out.push(t);
        } catch { /* سطر تالف — يُتجاهل في القراءة */ }
      }
    }
    return out;
  }

  /** النص الخام لكل ملفات التتبع (لفحص RT-6) */
  rawText(): string {
    if (!fs.existsSync(this.dir)) return "";
    return fs.readdirSync(this.dir).filter((n) => n.endsWith(".jsonl")).map((f) => fs.readFileSync(path.join(this.dir, f), "utf8")).join("\n");
  }
}
