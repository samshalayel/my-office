/**
 * سياق التطبيق المشترك: الإعدادات + قاعدة البيانات + التتبع + هويات الدفعة الحالية (لحجبها من أي سجل).
 */
import { type Config, loadConfig, resolvePath, secretValues } from "../config/config.ts";
import { Tracer } from "../observability/trace.ts";
import { type Db, openDb } from "../storage/db.ts";
import type { ModelClient } from "./model.ts";

export interface AppContext {
  cfg: Config;
  db: Db;
  tracer: Tracer;
  /** قيم هوية كاملة للحالات المقروءة في هذه العملية — لا تُخزَّن؛ ظهورها في أي مخرج يوقف العملية (HR-5) */
  identities: Set<string>;
  /** أجزاء الأسماء — تُحجب من السجلات والنص الحر فقط */
  nameParts: Set<string>;
  /** يُحقن في الاختبارات والتقييم؛ في التشغيل العادي يُبنى من الإعدادات */
  modelOverride?: ModelClient;
}

export function createContext(opts: { cfg?: Config; overrides?: Record<string, unknown>; model?: ModelClient } = {}): AppContext {
  const cfg = opts.cfg ?? loadConfig(opts.overrides);
  const db = openDb(resolvePath(cfg, cfg.paths.db));
  const identities = new Set<string>();
  const nameParts = new Set<string>();
  const tracer = new Tracer(resolvePath(cfg, cfg.paths.trace_dir), secretValues(cfg), () => [...identities, ...nameParts]);
  return { cfg, db, tracer, identities, nameParts, modelOverride: opts.model };
}

export function closeContext(app: AppContext): void {
  try { app.db.close(); } catch { /* مغلقة أصلاً */ }
}
