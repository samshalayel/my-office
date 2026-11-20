"""C-14 BackupSpec (BASE-7): نسخة يومية من ملف SQLite مع checksum خارج مجلد البيانات، واستعادة مُجرَّبة.
النسخ عبر VACUUM INTO (نسخة متسقة أثناء العمل). الاستعادة تتحقق من checksum وسلامة القاعدة قبل الاستبدال.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

from ..config.config import Config, resolve_path
from ..observability.errors import AppError
from .db import Db, now_iso, tx, write_audit


def _sha256(file: str) -> str:
    h = hashlib.sha256()
    with open(file, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _chmod(file: str) -> None:
    try:
        os.chmod(file, 0o600)
    except OSError:
        pass


def create_backup(cfg: Config, db: Db, actor: str = "system") -> dict[str, Any]:
    d = resolve_path(cfg, cfg["paths"]["backups_dir"])
    os.makedirs(d, mode=0o700, exist_ok=True)
    at = now_iso()
    name = f"office-{at[0:10]}-{at[11:13]}{at[14:16]}{at[17:19]}.sqlite"
    file = os.path.join(d, name)
    if os.path.exists(file):
        os.remove(file)
    db.execute("VACUUM INTO ?", (file,))
    _chmod(file)
    s = _sha256(file)
    with open(f"{file}.sha256", "w", encoding="utf-8", newline="\n") as fh:
        fh.write(f"{s}  {name}\n")
    _chmod(f"{file}.sha256")
    info = {"file": file, "sha256": s, "bytes": os.path.getsize(file), "created_at": at}
    tx(db, lambda: write_audit(db, actor, "backup", name, "create", after={"sha256": s, "bytes": info["bytes"]}))
    # الاحتفاظ بآخر N نسخة
    all_ = sorted(f for f in os.listdir(d) if re.fullmatch(r"office-.*\.sqlite", f))
    for old in all_[: max(0, len(all_) - cfg["schedule"]["backups_keep"])]:
        for f in (old, f"{old}.sha256"):
            try:
                os.remove(os.path.join(d, f))
            except FileNotFoundError:
                pass
    return info


def verify_backup(file: str) -> dict[str, Any]:
    """يتحقق من النسخة: checksum مطابق + PRAGMA integrity_check = ok"""
    if not os.path.exists(file):
        return {"ok": False, "reason": "الملف غير موجود"}
    sum_file = f"{file}.sha256"
    if not os.path.exists(sum_file):
        return {"ok": False, "reason": "ملف checksum غير موجود"}
    with open(sum_file, encoding="utf-8") as fh:
        expected = (fh.read().strip().split() or [""])[0]
    if _sha256(file) != expected:
        return {"ok": False, "reason": "checksum غير مطابق — النسخة تالفة أو مُعدَّلة"}
    conn = sqlite3.connect(Path(file).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        r = conn.execute("PRAGMA integrity_check").fetchone()[0]
        return {"ok": True} if r == "ok" else {"ok": False, "reason": f"integrity_check: {r}"}
    except sqlite3.Error as e:
        return {"ok": False, "reason": f"integrity_check: {e}"}
    finally:
        conn.close()


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


def restore_backup(cfg: Config, file: str) -> dict[str, Any]:
    """استعادة (والخادم متوقف): تحفظ القاعدة الحالية جانباً ثم تضع النسخة مكانها"""
    v = verify_backup(file)
    if not v["ok"]:
        raise AppError("BAD_REQUEST", f"restore: {v['reason']}", f"تعذّرت الاستعادة: {v['reason']}")
    target = resolve_path(cfg, cfg["paths"]["db"])
    os.makedirs(os.path.dirname(target), exist_ok=True)
    saved = None
    if os.path.exists(target):
        saved = f"{target}.before-restore-{_base36(int(time.time() * 1000))}"
        os.replace(target, saved)
    for ext in ("-wal", "-shm"):
        try:
            os.remove(f"{target}{ext}")
        except FileNotFoundError:
            pass
    shutil.copyfile(file, target)
    _chmod(target)
    return {"restored_to": target, "previous_saved_as": saved}


def list_backups(cfg: Config) -> list[str]:
    d = resolve_path(cfg, cfg["paths"]["backups_dir"])
    if not os.path.isdir(d):
        return []
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if re.fullmatch(r"office-.*\.sqlite", f)]
