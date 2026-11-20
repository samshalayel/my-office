/**
 * طبقة التخزين (DEC-15 أ): ملف SQLite واحد عبر node:sqlite المدمج (بلا مكتبات خارجية).
 * القواعد مفروضة في قاعدة البيانات نفسها، لا في الكود فقط:
 *  - التوقع المعتمد/المعدَّل/المرفوض لا يُعدَّل ولا يُحذف (HR-7 / MIT-3) — trigger.
 *  - سجل التدقيق وسجل نقاط الإنسان والقرارات والمقاييس والمقارنات: إضافة فقط (append-only).
 *  - كل كتابة + سطر تدقيقها في معاملة واحدة (C-12): كتابة بلا audit تفشل كلها.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../observability/errors.ts";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS cycles (
  cycle_id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','awaiting_hitl1','approved','rejected','failed','stopped')),
  run_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  batch_deadline TEXT
);

-- C-15: خريطة إخفاء الهوية — محلية فقط، لا تخرج للنموذج ولا للتتبع ولا للمخرجات
CREATE TABLE IF NOT EXISTS pseudonym_map (
  case_ref TEXT PRIMARY KEY,
  map_ref TEXT NOT NULL UNIQUE,
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- State.pregnant_cases لكل دورة (Case بعد الإخفاء — بلا معرفات)
CREATE TABLE IF NOT EXISTS cycle_cases (
  cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),
  case_ref TEXT NOT NULL REFERENCES pseudonym_map(case_ref),
  case_json TEXT NOT NULL,
  expected_infants INTEGER NOT NULL,
  notes_flag TEXT,
  PRIMARY KEY (cycle_id, case_ref)
);

-- C-2 / TL-2
CREATE TABLE IF NOT EXISTS predictions (
  prediction_ref TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),
  count_value INTEGER NOT NULL CHECK (count_value >= 0),
  risk_class TEXT NOT NULL CHECK (risk_class IN ('low','medium','high')),
  per_infant_json TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  missing_fields_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','approved','modified','rejected')),
  origin TEXT NOT NULL CHECK (origin IN ('agent','human')),
  supersedes TEXT,
  run_id TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  batch_deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS predictions_no_delete BEFORE DELETE ON predictions
  BEGIN SELECT RAISE(ABORT, 'FORBIDDEN_MODIFY_APPROVED'); END;
CREATE TRIGGER IF NOT EXISTS predictions_lock BEFORE UPDATE ON predictions WHEN OLD.status <> 'draft'
  BEGIN SELECT RAISE(ABORT, 'FORBIDDEN_MODIFY_APPROVED'); END;

-- C-3 / TL-3 — إدخال واحد لكل ولادة، لا تعديل ولا حذف
CREATE TABLE IF NOT EXISTS outcomes (
  actual_ref TEXT PRIMARY KEY,
  case_ref TEXT NOT NULL REFERENCES pseudonym_map(case_ref),
  birth_datetime TEXT NOT NULL,
  apgar_value INTEGER NOT NULL CHECK (apgar_value BETWEEN 0 AND 10),
  apgar_class TEXT NOT NULL CHECK (apgar_class IN ('low','medium','high')),
  entered_by TEXT NOT NULL,
  note TEXT,
  stored_at TEXT NOT NULL,
  UNIQUE (case_ref, birth_datetime)
);

-- C-6 — مقارنة واحدة لكل زوج (توقع، مقياس): لا عدّ مزدوج
CREATE TABLE IF NOT EXISTS discrepancies (
  discrepancy_ref TEXT PRIMARY KEY,
  prediction_ref TEXT NOT NULL,
  actual_ref TEXT NOT NULL REFERENCES outcomes(actual_ref),
  infant_ref TEXT,
  predicted_json TEXT NOT NULL,
  delta_count INTEGER,
  class_mismatch INTEGER NOT NULL CHECK (class_mismatch IN (0,1)),
  resources_reserved INTEGER NOT NULL CHECK (resources_reserved IN (0,1)),
  escalated INTEGER NOT NULL CHECK (escalated IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (prediction_ref, actual_ref)
);

-- C-4 / TL-4 — مسودات فقط (لا أداة تنفيذ — DEC-9)
CREATE TABLE IF NOT EXISTS drafts (
  draft_ref TEXT PRIMARY KEY,
  draft_type TEXT NOT NULL CHECK (draft_type IN ('preparation','action')),
  based_on TEXT NOT NULL REFERENCES predictions(prediction_ref),
  items_json TEXT,
  action_kind TEXT CHECK (action_kind IS NULL OR action_kind IN ('نقل','تجهيز','إبلاغ')),
  payload_json TEXT,
  alternatives_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','pending','approved','rejected','superseded')),
  origin TEXT NOT NULL CHECK (origin IN ('agent','human')),
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS drafts_no_delete BEFORE DELETE ON drafts
  BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS drafts_final BEFORE UPDATE ON drafts WHEN OLD.status NOT IN ('active','pending')
  BEGIN SELECT RAISE(ABORT, 'FORBIDDEN_MODIFY_APPROVED'); END;

-- C-8 / C-9 — قرارات الإنسان المهيكلة
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  hitl TEXT NOT NULL CHECK (hitl IN ('HITL-1','HITL-2','HITL-3')),
  subject_ref TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','modify','reject')),
  modified_payload_json TEXT,
  reason TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  outcome TEXT
);

-- C-12 / BASE-4 / MIT-3 — سجل التدقيق
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  audit_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity TEXT NOT NULL,
  ref TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT
);

-- BASE-A6 — سجل نقاط الإنسان: ماذا عُرض، من قرر، متى، ماذا قرر، ماذا حدث بعدها
CREATE TABLE IF NOT EXISTS hitl_log (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  hitl TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  shown_json TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  after_effect TEXT NOT NULL
);

-- تنبيهات (حرجة فورية DEC-5 ج، خلاف HITL-2، تأخر الرد، فشل دورة/نسخة) — تشغيلية، تقبل الإقرار
CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_notified_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT
);

CREATE TABLE IF NOT EXISTS auth_user (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const APPEND_ONLY = ["outcomes", "discrepancies", "decisions", "audit", "hitl_log", "pseudonym_map", "cycle_cases"];

function appendOnlyTriggers(): string {
  return APPEND_ONLY.map((t) => `
CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;`).join("\n");
}

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  db.exec(appendOnlyTriggers());
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')").run();
  if (file !== ":memory:") {
    try { fs.chmodSync(file, 0o600); } catch { /* نظام ملفات لا يدعم الصلاحيات */ }
  }
  return db;
}

/** يحوّل أخطاء الـ triggers إلى رموز العقود */
export function mapSqlError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (/FORBIDDEN_MODIFY_APPROVED/.test(msg)) return new AppError("FORBIDDEN_MODIFY_APPROVED", msg);
  if (/APPEND_ONLY/.test(msg)) return new AppError("FORBIDDEN_MODIFY_APPROVED", msg, "هذا السجل للإضافة فقط — لا يُعدَّل ولا يُحذف.");
  if (/UNIQUE constraint failed/.test(msg)) return new AppError("DUPLICATE", msg);
  if (/CHECK constraint failed|NOT NULL constraint failed/.test(msg)) return new AppError("REJECTED_SCHEMA", msg);
  if (/FOREIGN KEY constraint failed/.test(msg)) return new AppError("UNKNOWN_CASE", msg);
  return e;
}

const depth = new WeakMap<Db, number>();

/** معاملة ذرية (BEGIN IMMEDIATE = كاتب واحد)؛ المتداخلة تصير SAVEPOINT */
export function tx<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) || 0;
  const sp = `sp${d}`;
  db.exec(d === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  depth.set(db, d + 1);
  try {
    const r = fn();
    db.exec(d === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    try { db.exec(d === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* المعاملة أُغلقت أصلاً */ }
    throw mapSqlError(e);
  } finally {
    depth.set(db, d);
  }
}

export const nowIso = () => new Date().toISOString();
export const today = (d = new Date()) => d.toISOString().slice(0, 10);

/** مرجع يومي متسلسل: PREFIX-YYYY-MM-DD-NN (مجموعات أرقام قصيرة — لا تشبه رقم هوية) */
export function nextDailyRef(db: Db, prefix: string, table: string, column: string, date = today()): string {
  const base = `${prefix}-${date}-`;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`).get(`${base}%`) as { n: number };
  return `${base}${String(row.n + 1).padStart(2, "0")}`;
}

export function randomRef(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

export interface AuditEntry {
  actor: string;          // "AGT-1" | "human:<username>" | "system"
  entity: "prediction" | "actual" | "draft" | "decision" | "discrepancy" | "case" | "control" | "cycle" | "auth" | "backup";
  ref: string;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** C-12: يُستدعى داخل نفس معاملة الكتابة */
export function writeAudit(db: Db, a: AuditEntry): string {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM audit").get() as { n: number };
  const auditId = `AUD-${String(row.n).padStart(6, "0")}`;
  db.prepare(`INSERT INTO audit (seq, audit_id, ts, actor, entity, ref, action, before_json, after_json, reason)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.n, auditId, nowIso(), a.actor, a.entity, a.ref, a.action,
    a.before === undefined ? null : JSON.stringify(a.before),
    a.after === undefined ? null : JSON.stringify(a.after),
    a.reason ?? null,
  );
  return auditId;
}

export function getMeta(db: Db, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
