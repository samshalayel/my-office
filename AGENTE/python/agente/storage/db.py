"""طبقة التخزين (DEC-15 أ): ملف SQLite واحد عبر sqlite3 من المكتبة القياسية (بلا مكتبات خارجية).
نفس المخطط والـ triggers في نسخة TypeScript — القواعد مفروضة في قاعدة البيانات نفسها، لا في الكود فقط:
 - التوقع المعتمد/المعدَّل/المرفوض لا يُعدَّل ولا يُحذف (HR-7 / MIT-3) — trigger.
 - سجل التدقيق وسجل نقاط الإنسان والقرارات والمقاييس والمقارنات: إضافة فقط (append-only).
 - كل كتابة + سطر تدقيقها في معاملة واحدة (C-12): كتابة بلا audit تفشل كلها.
"""
from __future__ import annotations

import os
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any, Callable, TypeVar

from ..jsutil import iso, jdump
from ..observability.errors import AppError

T = TypeVar("T")


class Db(sqlite3.Connection):
    """اتصال SQLite يحمل عمق المعاملات المتداخلة (SAVEPOINT)"""
    tx_depth: int = 0

SCHEMA = """
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
"""

APPEND_ONLY = ["outcomes", "discrepancies", "decisions", "audit", "hitl_log", "pseudonym_map", "cycle_cases"]


def _append_only_triggers() -> str:
    return "\n".join(
        f"""
CREATE TRIGGER IF NOT EXISTS {t}_no_update BEFORE UPDATE ON {t} BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS {t}_no_delete BEFORE DELETE ON {t} BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY'); END;"""
        for t in APPEND_ONLY
    )


def _dict_row(cursor: sqlite3.Cursor, row: tuple) -> dict[str, Any]:
    return {d[0]: row[i] for i, d in enumerate(cursor.description)}


def open_db(file: str) -> Db:
    if file != ":memory:":
        os.makedirs(os.path.dirname(file) or ".", exist_ok=True)
    # isolation_level=None: لا معاملات ضمنية — المعاملات صريحة عبر tx() كما في node:sqlite.
    # check_same_thread=False: كل الوصول متسلسل على حلقة asyncio واحدة (web/server.py) أو على خيط الأوامر.
    db = sqlite3.connect(file, isolation_level=None, check_same_thread=False, factory=Db)
    db.row_factory = _dict_row
    db.executescript("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    db.executescript(SCHEMA)
    db.executescript(_append_only_triggers())
    db.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')")
    if file != ":memory:":
        try:
            os.chmod(file, 0o600)
        except OSError:
            pass  # نظام ملفات لا يدعم الصلاحيات
    return db


def q1(db: Db, sql: str, *params: Any) -> dict[str, Any] | None:
    return db.execute(sql, params).fetchone()


def qall(db: Db, sql: str, *params: Any) -> list[dict[str, Any]]:
    return db.execute(sql, params).fetchall()


def run(db: Db, sql: str, *params: Any) -> None:
    db.execute(sql, params)


def map_sql_error(e: BaseException) -> BaseException:
    """يحوّل أخطاء الـ triggers إلى رموز العقود"""
    msg = str(e)
    if "FORBIDDEN_MODIFY_APPROVED" in msg:
        return AppError("FORBIDDEN_MODIFY_APPROVED", msg)
    if "APPEND_ONLY" in msg:
        return AppError("FORBIDDEN_MODIFY_APPROVED", msg, "هذا السجل للإضافة فقط — لا يُعدَّل ولا يُحذف.")
    if "UNIQUE constraint failed" in msg:
        return AppError("DUPLICATE", msg)
    if re.search(r"CHECK constraint failed|NOT NULL constraint failed", msg):
        return AppError("REJECTED_SCHEMA", msg)
    if "FOREIGN KEY constraint failed" in msg:
        return AppError("UNKNOWN_CASE", msg)
    return e


def tx(db: Db, fn: Callable[[], T]) -> T:
    """معاملة ذرية (BEGIN IMMEDIATE = كاتب واحد)؛ المتداخلة تصير SAVEPOINT"""
    d = getattr(db, "tx_depth", 0)
    sp = f"sp{d}"
    db.execute("BEGIN IMMEDIATE" if d == 0 else f"SAVEPOINT {sp}")
    db.tx_depth = d + 1
    try:
        r = fn()
        db.execute("COMMIT" if d == 0 else f"RELEASE {sp}")
        return r
    except BaseException as e:
        try:
            if d == 0:
                db.execute("ROLLBACK")
            else:
                db.execute(f"ROLLBACK TO {sp}")
                db.execute(f"RELEASE {sp}")
        except sqlite3.Error:
            pass  # المعاملة أُغلقت أصلاً
        mapped = map_sql_error(e)
        if mapped is e:
            raise
        raise mapped from e
    finally:
        db.tx_depth = d


def now_iso() -> str:
    return iso(datetime.now(timezone.utc))


def today(d: datetime | None = None) -> str:
    return iso(d or datetime.now(timezone.utc))[:10]


def next_daily_ref(db: Db, prefix: str, table: str, column: str, date: str | None = None) -> str:
    """مرجع يومي متسلسل: PREFIX-YYYY-MM-DD-NN (مجموعات أرقام قصيرة — لا تشبه رقم هوية)"""
    base = f"{prefix}-{date or today()}-"
    row = q1(db, f"SELECT COUNT(*) AS n FROM {table} WHERE {column} LIKE ?", f"{base}%")
    return f"{base}{row['n'] + 1:02d}"


def random_ref(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def write_audit(db: Db, actor: str, entity: str, ref: str, action: str, before: Any = None, after: Any = None,
                reason: str | None = None) -> str:
    """C-12: يُستدعى داخل نفس معاملة الكتابة"""
    row = q1(db, "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM audit")
    n = row["n"]
    audit_id = f"AUD-{n:06d}"
    db.execute(
        """INSERT INTO audit (seq, audit_id, ts, actor, entity, ref, action, before_json, after_json, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (n, audit_id, now_iso(), actor, entity, ref, action,
         None if before is None else jdump(before), None if after is None else jdump(after), reason),
    )
    return audit_id


def get_meta(db: Db, key: str) -> str | None:
    r = q1(db, "SELECT value FROM meta WHERE key = ?", key)
    return r["value"] if r else None


def set_meta(db: Db, key: str, value: str) -> None:
    db.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
