/**
 * C-14 BackupSpec (BASE-7): نسخة يومية من ملف SQLite مع checksum خارج مجلد البيانات، واستعادة مُجرَّبة.
 * النسخ عبر VACUUM INTO (نسخة متسقة أثناء العمل). الاستعادة تتحقق من checksum وسلامة القاعدة قبل الاستبدال.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type Config, resolvePath } from "../config/config.ts";
import { AppError } from "../observability/errors.ts";
import { type Db, tx, writeAudit } from "./db.ts";

export interface BackupInfo { file: string; sha256: string; bytes: number; created_at: string }

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function createBackup(cfg: Config, db: Db, actor = "system"): BackupInfo {
  const dir = resolvePath(cfg, cfg.paths.backups_dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const iso = new Date().toISOString();
  const name = `office-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}.sqlite`;
  const file = path.join(dir, name);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try { fs.chmodSync(file, 0o600); } catch { /* */ }
  const sum = sha256(file);
  fs.writeFileSync(`${file}.sha256`, `${sum}  ${name}\n`, { mode: 0o600 });
  const info: BackupInfo = { file, sha256: sum, bytes: fs.statSync(file).size, created_at: iso };
  tx(db, () => writeAudit(db, { actor, entity: "backup", ref: name, action: "create", after: { sha256: sum, bytes: info.bytes } }));
  // الاحتفاظ بآخر N نسخة
  const all = fs.readdirSync(dir).filter((f) => /^office-.*\.sqlite$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - cfg.schedule.backups_keep))) {
    fs.rmSync(path.join(dir, old), { force: true });
    fs.rmSync(path.join(dir, `${old}.sha256`), { force: true });
  }
  return info;
}

/** يتحقق من النسخة: checksum مطابق + PRAGMA integrity_check = ok */
export function verifyBackup(file: string): { ok: boolean; reason?: string } {
  if (!fs.existsSync(file)) return { ok: false, reason: "الملف غير موجود" };
  const sumFile = `${file}.sha256`;
  if (!fs.existsSync(sumFile)) return { ok: false, reason: "ملف checksum غير موجود" };
  const expected = fs.readFileSync(sumFile, "utf8").trim().split(/\s+/)[0];
  if (sha256(file) !== expected) return { ok: false, reason: "checksum غير مطابق — النسخة تالفة أو مُعدَّلة" };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const r = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    return r.integrity_check === "ok" ? { ok: true } : { ok: false, reason: `integrity_check: ${r.integrity_check}` };
  } finally {
    db.close();
  }
}

/** استعادة (والخادم متوقف): تحفظ القاعدة الحالية جانباً ثم تضع النسخة مكانها */
export function restoreBackup(cfg: Config, file: string): { restored_to: string; previous_saved_as: string | null } {
  const v = verifyBackup(file);
  if (!v.ok) throw new AppError("BAD_REQUEST", `restore: ${v.reason}`, `تعذّرت الاستعادة: ${v.reason}`);
  const target = resolvePath(cfg, cfg.paths.db);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let saved: string | null = null;
  if (fs.existsSync(target)) {
    saved = `${target}.before-restore-${Date.now().toString(36)}`;
    fs.renameSync(target, saved);
  }
  for (const ext of ["-wal", "-shm"]) fs.rmSync(`${target}${ext}`, { force: true });
  fs.copyFileSync(file, target);
  try { fs.chmodSync(target, 0o600); } catch { /* */ }
  return { restored_to: target, previous_saved_as: saved };
}

export function listBackups(cfg: Config): string[] {
  const dir = resolvePath(cfg, cfg.paths.backups_dir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^office-.*\.sqlite$/.test(f)).sort().map((f) => path.join(dir, f));
}
