"""C-10 TraceRecord (BASE-A1): سطر JSONL لكل استدعاء نموذج أو أداة أو قرار — append-only في data/trace/.
كل سطر يحمل إصدار التعليمات والنموذج (BASE-A5). الأسرار تُنقّى قبل الكتابة (BASE-A7)،
وأي معرف شخصي يُحجب كطبقة دفاع ثانية بعد إخفاء الهوية (MIT-5 / HR-5).
فشل الكتابة → محاولة واحدة ثم توقف آمن: لا تشغيل بلا تتبّع.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from ..jsutil import iso, jdump
from .errors import AppError


def digest(v: Any) -> str:
    text = v if isinstance(v, str) else jdump(v)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def new_run_id(prefix: str = "r") -> str:
    """معرّف تشغيل بمجموعات أرقام قصيرة (لا يشبه رقم هوية فلا يحجبه منقّي المعرفات)"""
    s = iso(datetime.now(timezone.utc))
    return f"{prefix}-{s[0:10]}-{s[11:13]}{s[14:16]}-{secrets.token_hex(3)}"


# أنماط أسرار شائعة — تُحجب حتى لو لم تكن معروفة مسبقاً (\b و \w بمعنى ASCII كما في JavaScript)
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b", re.ASCII),
    re.compile(r"\b(Bearer)\s+[A-Za-z0-9._-]{12,}", re.ASCII | re.IGNORECASE),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b", re.ASCII),
]

# معرفات شخصية عامة: أرقام هوية/ملف/هاتف (7+ أرقام متتالية، لاتينية أو عربية)، هاتف بفواصل، بريد إلكتروني.
# التواريخ (2026-11-20) والمعرّفات الداخلية (P-2026-11-20-01، مجموعات ≤4 أرقام) لا تطابقها عمداً.
PII_PATTERNS = [
    re.compile(r"(?<![\w-])\d{7,}(?![\w-])", re.ASCII),
    re.compile(r"(?<![\w])\+?\d{2,4}[ -]\d{3}[ -]\d{3,4}(?![\w])", re.ASCII),
    re.compile(r"\+\d{1,3}[ -]?\d{2,3}[ -]?\d{3}[ -]?\d{3,4}", re.ASCII),
    re.compile(r"[٠-٩۰-۹]{7,}"),
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.ASCII),
]

# (?<![\p{L}\p{N}]) في JavaScript ≈ (?<![^\W_]) في Python (حرف أو رقم يونيكود)
_NOT_LN_BEFORE = r"(?<![^\W_])"
_NOT_LN_AFTER = r"(?![^\W_])"


def whole_word(token: str) -> re.Pattern[str]:
    """كلمة كاملة فقط: «حالة» لا تطابق داخل «الحالة»"""
    return re.compile(f"{_NOT_LN_BEFORE}{re.escape(token)}{_NOT_LN_AFTER}")


class Tracer:
    def __init__(self, dir: str, secrets_: Iterable[str] = (), identities: Callable[[], list[str]] = lambda: []):
        self.dir = dir
        self.secrets = list(secrets_)
        self.identities = identities

    def scrub(self, text: str) -> str:
        s = text
        for v in self.secrets:
            if v:
                s = s.replace(v, "[سر محجوب]")
        for rx in SECRET_PATTERNS:
            s = rx.sub(lambda m: "Bearer [سر محجوب]" if m.lastindex and re.match("bearer", m.group(1), re.I) else "[سر محجوب]", s)
        for ident in self.identities():
            if ident and len(ident) >= 3:
                s = whole_word(ident).sub("[محجوب]", s)
        for rx in PII_PATTERNS:
            s = rx.sub("[محجوب]", s)
        return s

    def write(self, line: dict[str, Any]) -> dict[str, Any]:
        full = {k: v for k, v in line.items() if k != "ts"}
        full["ts"] = line.get("ts") or iso(datetime.now(timezone.utc))
        text = self.scrub(jdump(full))
        file = os.path.join(self.dir, f"{full['ts'][:10]}.jsonl")
        for attempt in range(2):
            try:
                os.makedirs(self.dir, exist_ok=True)
                fd = os.open(file, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
                try:
                    os.write(fd, (text + "\n").encode("utf-8"))
                finally:
                    os.close(fd)
                return full
            except OSError as e:
                if attempt == 1:
                    raise AppError("TRACE_FAILED", str(e)) from e
        return full

    def _files(self) -> list[str]:
        if not os.path.isdir(self.dir):
            return []
        return sorted(n for n in os.listdir(self.dir) if n.endswith(".jsonl"))

    def read(self, run_id: str | None = None) -> list[dict[str, Any]]:
        """قراءة سطور تشغيل معيّن (للتقييم والتحقيق)"""
        out: list[dict[str, Any]] = []
        for f in self._files():
            with open(os.path.join(self.dir, f), encoding="utf-8") as fh:
                for raw in fh.read().split("\n"):
                    if not raw.strip():
                        continue
                    try:
                        t = json.loads(raw)
                    except ValueError:
                        continue  # سطر تالف — يُتجاهل في القراءة
                    if not run_id or t.get("run_id") == run_id:
                        out.append(t)
        return out

    def raw_text(self) -> str:
        """النص الخام لكل ملفات التتبع (لفحص RT-6)"""
        parts = []
        for f in self._files():
            with open(os.path.join(self.dir, f), encoding="utf-8") as fh:
                parts.append(fh.read())
        return "\n".join(parts)
