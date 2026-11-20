/**
 * BASE-1 / BASE-11 — دخول آمن لمستخدم الحضانة: كلمة سر مجزّأة (scrypt + salt)، جلسة بكوكي HttpOnly/SameSite=Strict،
 * رمز CSRF لكل نموذج، حد لمحاولات الدخول، وانتهاء الجلسة. الجلسات في الذاكرة (إعادة التشغيل = دخول من جديد).
 */
import crypto from "node:crypto";
import type { Db } from "../storage/db.ts";
import { nowIso, tx, writeAudit } from "../storage/db.ts";
import { AppError } from "../observability/errors.ts";

const N = 16384;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N });
  return `scrypt$${N}$${salt.toString("base64")}$${h.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, "base64"), 32, { N: Number(n) });
  const want = Buffer.from(hash, "base64");
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}

export function validatePasswordStrength(pw: string): void {
  if (pw.length < 10) throw new AppError("BAD_REQUEST", "weak password", "كلمة السر 10 أحرف على الأقل.");
}

export function setPassword(db: Db, username: string, pw: string, actor: string): void {
  validatePasswordStrength(pw);
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new AppError("BAD_REQUEST", "username", "اسم المستخدم 3–32 حرفاً لاتينياً أو أرقام.");
  tx(db, () => {
    db.prepare("INSERT INTO auth_user (username, password_hash, updated_at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at")
      .run(username, hashPassword(pw), nowIso());
    writeAudit(db, { actor, entity: "auth", ref: username, action: "set_password" });
  });
}

export function hasUsers(db: Db): boolean {
  return Boolean(db.prepare("SELECT 1 FROM auth_user LIMIT 1").get());
}

export interface Session { token: string; user: string; csrf: string; expires: number }

export class Auth {
  private sessions = new Map<string, Session>();
  private fails = new Map<string, { n: number; until: number }>();
  private db: Db;
  private hours: number;
  private maxAttempts: number;
  private lockoutMs: number;
  constructor(db: Db, opts: { session_hours: number; max_login_attempts: number; lockout_minutes: number }) {
    this.db = db;
    this.hours = opts.session_hours;
    this.maxAttempts = opts.max_login_attempts;
    this.lockoutMs = opts.lockout_minutes * 60_000;
  }

  login(ip: string, username: string, pw: string): Session {
    const f = this.fails.get(ip);
    if (f && f.until > Date.now()) throw new AppError("RATE_LIMITED", ip);
    const row = this.db.prepare("SELECT password_hash FROM auth_user WHERE username = ?").get(username) as { password_hash: string } | undefined;
    // نفس كلفة الحساب حتى لو المستخدم غير موجود (لا تمييز بالتوقيت)
    const ok = row ? verifyPassword(pw, row.password_hash) : (verifyPassword(pw, "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="), false);
    if (!ok) {
      const n = (f && f.until <= Date.now() && f.n >= this.maxAttempts ? 0 : f?.n ?? 0) + 1;
      this.fails.set(ip, { n, until: n >= this.maxAttempts ? Date.now() + this.lockoutMs : 0 });
      tx(this.db, () => writeAudit(this.db, { actor: "system", entity: "auth", ref: username.slice(0, 32), action: "login_failed" }));
      throw new AppError("UNAUTHORIZED", "bad credentials", "اسم المستخدم أو كلمة السر غير صحيحة.");
    }
    this.fails.delete(ip);
    const s: Session = { token: crypto.randomBytes(32).toString("hex"), user: username, csrf: crypto.randomBytes(24).toString("hex"), expires: Date.now() + this.hours * 3_600_000 };
    this.sessions.set(s.token, s);
    tx(this.db, () => writeAudit(this.db, { actor: `human:${username}`, entity: "auth", ref: username, action: "login" }));
    return s;
  }

  get(token: string | undefined): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expires < Date.now()) { this.sessions.delete(token); return null; }
    return s;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  checkCsrf(s: Session, provided: unknown): void {
    const a = Buffer.from(String(provided ?? ""));
    const b = Buffer.from(s.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AppError("CSRF", "csrf mismatch");
  }
}
