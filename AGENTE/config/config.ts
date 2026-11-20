/**
 * C-11 ConfigSpec (BASE-8 / BASE-A2 / BASE-A4): كل القيم من ملفات الإعدادات، لا من الكود.
 * config/settings.json (افتراضي في الريبو) + config/settings.local.json (خادم المشفى، خارج الريبو).
 * الأسرار من متغيرات البيئة فقط (BASE-A7) — الملفات تحوي اسم المتغير لا قيمته.
 * قيمة ناقصة أو غير صالحة → الإقلاع يفشل برسالة واضحة (لا افتراض صامت).
 */
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../observability/errors.ts";

export interface Config {
  root: string;
  model: {
    provider: "openai_compatible" | "demo";
    base_url: string;
    model: string;
    fallback_model: string;
    api_key_env: string;
    temperature: number;
    max_output_tokens: number;
  };
  caps: {
    max_model_calls_per_cycle: number;
    max_tool_steps: number;
    model_timeout_s: number;
    tool_timeout_s: number;
    cycle_timeout_s: number;
    max_cases_per_cycle: number;
    max_infants_per_case: number;
  };
  window_days: number;
  thresholds: { count_match_pct: number; class_match_pct: number };
  apgar_bands: { high_risk_max: number; medium_risk_max: number };
  kill_switch: { enabled: boolean; disabled_tools: string[] };
  schedule: {
    enabled: boolean;
    daily_cycle_time: string;
    batch_deadline_time: string;
    reminder_every_minutes: number;
    backup_time: string;
    backups_keep: number;
  };
  source: {
    type: "json_file" | "csv_file";
    path: string;
    system_name: string;
    fields: {
      source_key: string;
      gestation_week: string;
      expected_delivery_date: string;
      expected_infants: string;
      notes: string;
      indicators: string[];
      identity: string[];
    };
  };
  privacy: { send_notes_to_model: boolean };
  alerts: { webhook_url: string };
  server: {
    host: string; port: number; tls_cert: string; tls_key: string; session_hours: number;
    max_login_attempts: number; lockout_minutes: number;
  };
  paths: {
    db: string; trace_dir: string; controls: string; eval_baseline: string; backups_dir: string; reports_dir: string;
  };
}

/** جذر المشروع: AGENTE_HOME (للاختبارات والخادم) أو المجلد الأب لـ config/ */
export function projectRoot(): string {
  return process.env.AGENTE_HOME ? path.resolve(process.env.AGENTE_HOME) : path.resolve(import.meta.dirname, "..");
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new AppError("CONFIG_INVALID", `${file}: ${(e as Error).message}`, `ملف الإعدادات غير صالح: ${path.basename(file)}`);
  }
}

function merge(base: any, over: any): any {
  if (Array.isArray(over) || typeof over !== "object" || over === null) return over;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function validate(c: any): string[] {
  const p: string[] = [];
  const num = (v: unknown, name: string, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) p.push(`${name} يجب أن يكون رقماً بين ${min} و ${max}`);
  };
  const str = (v: unknown, name: string, allowEmpty = false) => {
    if (typeof v !== "string" || (!allowEmpty && !v.trim())) p.push(`${name} مطلوب`);
  };
  if (!["openai_compatible", "demo"].includes(c?.model?.provider)) p.push("model.provider يجب أن يكون openai_compatible أو demo");
  str(c?.model?.base_url, "model.base_url", true);
  str(c?.model?.model, "model.model", true);
  str(c?.model?.api_key_env, "model.api_key_env");
  num(c?.model?.temperature, "model.temperature", 0, 2);
  num(c?.model?.max_output_tokens, "model.max_output_tokens", 200, 32000);
  for (const [k, lo, hi] of [["max_model_calls_per_cycle", 1, 50], ["max_tool_steps", 1, 50], ["model_timeout_s", 5, 600],
    ["tool_timeout_s", 1, 300], ["cycle_timeout_s", 30, 7200], ["max_cases_per_cycle", 1, 500], ["max_infants_per_case", 1, 10]] as const) {
    num(c?.caps?.[k], `caps.${k}`, lo, hi);
  }
  num(c?.window_days, "window_days", 1, 31);
  num(c?.thresholds?.count_match_pct, "thresholds.count_match_pct", 0, 100);
  num(c?.thresholds?.class_match_pct, "thresholds.class_match_pct", 0, 100);
  num(c?.apgar_bands?.high_risk_max, "apgar_bands.high_risk_max", 0, 10);
  num(c?.apgar_bands?.medium_risk_max, "apgar_bands.medium_risk_max", 0, 10);
  if (c?.apgar_bands?.high_risk_max >= c?.apgar_bands?.medium_risk_max) p.push("apgar_bands.high_risk_max يجب أن يكون أقل من medium_risk_max");
  if (typeof c?.kill_switch?.enabled !== "boolean" || !Array.isArray(c?.kill_switch?.disabled_tools)) p.push("kill_switch غير صالح");
  for (const k of ["daily_cycle_time", "batch_deadline_time", "backup_time"]) {
    if (!TIME.test(String(c?.schedule?.[k] ?? ""))) p.push(`schedule.${k} بصيغة HH:MM`);
  }
  num(c?.schedule?.reminder_every_minutes, "schedule.reminder_every_minutes", 5, 1440);
  num(c?.schedule?.backups_keep, "schedule.backups_keep", 1, 365);
  if (!["json_file", "csv_file"].includes(c?.source?.type)) p.push("source.type يجب أن يكون json_file أو csv_file");
  str(c?.source?.path, "source.path");
  str(c?.source?.system_name, "source.system_name");
  for (const k of ["source_key", "gestation_week", "expected_delivery_date", "expected_infants", "notes"]) str(c?.source?.fields?.[k], `source.fields.${k}`);
  if (!Array.isArray(c?.source?.fields?.indicators) || !c.source.fields.indicators.length) p.push("source.fields.indicators قائمة غير فارغة");
  if (!Array.isArray(c?.source?.fields?.identity)) p.push("source.fields.identity قائمة");
  if (!c?.source?.fields?.identity?.includes(c?.source?.fields?.source_key)) p.push("source.fields.identity يجب أن تشمل source_key (لا يخرج المعرف الأصلي)");
  num(c?.server?.port, "server.port", 1, 65535);
  num(c?.server?.session_hours, "server.session_hours", 1, 72);
  num(c?.server?.max_login_attempts, "server.max_login_attempts", 1, 50);
  num(c?.server?.lockout_minutes, "server.lockout_minutes", 1, 1440);
  for (const k of ["db", "trace_dir", "controls", "eval_baseline", "backups_dir", "reports_dir"]) str(c?.paths?.[k], `paths.${k}`);
  return p;
}

export function loadConfig(overrides: Record<string, unknown> = {}): Config {
  const root = projectRoot();
  const base = readJson(path.join(root, "config", "settings.json"));
  const localFile = path.join(root, "config", "settings.local.json");
  let merged = merge(base, fs.existsSync(localFile) ? readJson(localFile) : {});
  merged = merge(merged, overrides);
  delete merged._comment;
  const problems = validate(merged);
  if (problems.length) throw new AppError("CONFIG_INVALID", problems.join("; "), `الإعدادات غير صالحة: ${problems.join("؛ ")}`);
  return { ...merged, root } as Config;
}

/** مسار داخل جذر المشروع (المسارات في الإعدادات نسبية للجذر) */
export function resolvePath(cfg: Config, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cfg.root, p);
}

/** مفتاح النموذج من البيئة فقط (BASE-A7) — لا يُكتب في أي ملف أو سجل */
export function modelApiKey(cfg: Config): string {
  return (process.env[cfg.model.api_key_env] || "").trim();
}

/** قيم سرية يجب ألا تظهر في أي سجل أو مخرج */
export function secretValues(cfg: Config): string[] {
  return [modelApiKey(cfg)].filter((s) => s.length >= 8);
}
