"""BASE-1 / BASE-11 — دخول آمن لمستخدم الحضانة: كلمة سر مجزّأة (scrypt + salt)، جلسة بكوكي HttpOnly/SameSite=Strict،
رمز CSRF لكل نموذج، حد لمحاولات الدخول، وانتهاء الجلسة. الجلسات في الذاكرة (إعادة التشغيل = دخول من جديد).
صيغة التجزئة مطابقة لنسخة TypeScript (scrypt$N$salt$hash، N=16384, r=8, p=1, 32 بايت) — الحسابات تنتقل بين النسختين.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from typing import Any

from ..jsutil import now_ms
from ..observability.errors import AppError
from ..storage.db import Db, now_iso, q1, tx, write_audit

N = 16384


def _scrypt(pw: str, salt: bytes, n: int) -> bytes:
    return hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=n, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = _scrypt(pw, salt, N)
    return f"scrypt${N}${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"


def verify_password(pw: str, stored: str) -> bool:
    parts = stored.split("$")
    if len(parts) < 4 or parts[0] != "scrypt" or not parts[2] or not parts[3]:
        return False
    try:
        n = int(parts[1])
        h = _scrypt(pw, base64.b64decode(parts[2]), n)
        want = base64.b64decode(parts[3])
    except (ValueError, binascii.Error):
        return False
    return len(want) == len(h) and hmac.compare_digest(want, h)


def validate_password_strength(pw: str) -> None:
    if len(pw) < 10:
        raise AppError("BAD_REQUEST", "weak password", "كلمة السر 10 أحرف على الأقل.")


def set_password(db: Db, username: str, pw: str, actor: str) -> None:
    validate_password_strength(pw)
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username):
        raise AppError("BAD_REQUEST", "username", "اسم المستخدم 3–32 حرفاً لاتينياً أو أرقام.")

    def write() -> None:
        db.execute("""INSERT INTO auth_user (username, password_hash, updated_at) VALUES (?, ?, ?)
                      ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at""",
                   (username, hash_password(pw), now_iso()))
        write_audit(db, actor, "auth", username, "set_password")

    tx(db, write)


def has_users(db: Db) -> bool:
    return bool(q1(db, "SELECT 1 AS x FROM auth_user LIMIT 1"))


@dataclass
class Session:
    token: str
    user: str
    csrf: str
    expires: float


_DUMMY = "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="


class Auth:
    def __init__(self, db: Db, opts: dict[str, Any]):
        self.db = db
        self.hours = opts["session_hours"]
        self.max_attempts = opts["max_login_attempts"]
        self.lockout_ms = opts["lockout_minutes"] * 60_000
        self.sessions: dict[str, Session] = {}
        self.fails: dict[str, dict[str, float]] = {}

    def login(self, ip: str, username: str, pw: str) -> Session:
        f = self.fails.get(ip)
        if f and f["until"] > now_ms():
            raise AppError("RATE_LIMITED", ip)
        row = q1(self.db, "SELECT password_hash FROM auth_user WHERE username = ?", username)
        # نفس كلفة الحساب حتى لو المستخدم غير موجود (لا تمييز بالتوقيت)
        if row:
            ok = verify_password(pw, row["password_hash"])
        else:
            verify_password(pw, _DUMMY)
            ok = False
        if not ok:
            prev = 0 if (f and f["until"] <= now_ms() and f["n"] >= self.max_attempts) else (f["n"] if f else 0)
            n = prev + 1
            self.fails[ip] = {"n": n, "until": now_ms() + self.lockout_ms if n >= self.max_attempts else 0}
            tx(self.db, lambda: write_audit(self.db, "system", "auth", username[:32], "login_failed"))
            raise AppError("UNAUTHORIZED", "bad credentials", "اسم المستخدم أو كلمة السر غير صحيحة.")
        self.fails.pop(ip, None)
        s = Session(token=secrets.token_hex(32), user=username, csrf=secrets.token_hex(24), expires=now_ms() + self.hours * 3_600_000)
        self.sessions[s.token] = s
        tx(self.db, lambda: write_audit(self.db, f"human:{username}", "auth", username, "login"))
        return s

    def get(self, token: str | None) -> Session | None:
        if not token:
            return None
        s = self.sessions.get(token)
        if not s:
            return None
        if s.expires < now_ms():
            self.sessions.pop(token, None)
            return None
        return s

    def logout(self, token: str | None) -> None:
        if token:
            self.sessions.pop(token, None)

    def check_csrf(self, s: Session, provided: Any) -> None:
        a = ("" if provided is None else str(provided)).encode("utf-8")
        b = s.csrf.encode("utf-8")
        if len(a) != len(b) or not hmac.compare_digest(a, b):
            raise AppError("CSRF", "csrf mismatch")
