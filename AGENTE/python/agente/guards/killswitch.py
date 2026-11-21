"""BASE-A3 / MIT-7 — مفتاح الإيقاف اليدوي الدائم.
الحالة في ملف data/controls.json (يُقرأ عند كل استدعاء أداة ونموذج — يعمل فوراً بلا نشر جديد)،
فوق القيمة الافتراضية في الإعدادات. التغيير من الواجهة يُكتب بشكل ذري ويُسجَّل في التدقيق.
"""
from __future__ import annotations

import json
import os
from typing import Any

from ..config.config import Config, resolve_path
from ..observability.errors import AppError
from ..storage.db import Db, now_iso, tx, write_audit

TOOL_NAMES = ["TL-1", "TL-2", "TL-3", "TL-4", "model"]


def read_controls(cfg: Config) -> dict[str, Any]:
    file = resolve_path(cfg, cfg["paths"]["controls"])
    state: dict[str, Any] = {}
    try:
        if os.path.exists(file):
            with open(file, encoding="utf-8") as fh:
                state = json.load(fh)
            if not isinstance(state, dict):
                state = {}
    except (OSError, ValueError):
        # ملف تالف = أمان: نعدّه إيقافاً كاملاً بدل تجاهله
        return {"enabled": True, "disabled_tools": [], "updated_at": None, "updated_by": "ملف التحكم تالف"}
    enabled = state.get("enabled")
    tools = state.get("disabled_tools")
    return {
        "enabled": bool(cfg["kill_switch"]["enabled"] if enabled is None else enabled),
        "disabled_tools": [str(t) for t in tools] if isinstance(tools, list) else list(cfg["kill_switch"]["disabled_tools"]),
        "updated_at": state.get("updated_at"),
        "updated_by": state.get("updated_by"),
    }


def assert_enabled(cfg: Config, tool: str) -> None:
    c = read_controls(cfg)
    if c["enabled"]:
        raise AppError("KILL_SWITCH", f"global ({c['updated_by'] or 'settings'})")
    if tool in c["disabled_tools"]:
        raise AppError("KILL_SWITCH", tool, f"الأداة {tool} موقوفة بمفتاح الإيقاف.")


def set_controls(cfg: Config, db: Db, nxt: dict[str, Any], actor: str, reason: str) -> dict[str, Any]:
    file = resolve_path(cfg, cfg["paths"]["controls"])
    before = read_controls(cfg)
    tools = [t for t in nxt["disabled_tools"] if t in TOOL_NAMES]
    state = {"enabled": bool(nxt["enabled"]), "disabled_tools": tools, "updated_at": now_iso(), "updated_by": actor}

    def write() -> None:
        write_audit(db, actor, "control", "kill_switch", "set", before=before, after=state, reason=reason)
        os.makedirs(os.path.dirname(file), exist_ok=True)
        tmp = f"{file}.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(state, ensure_ascii=False, indent=2))
        os.replace(tmp, file)

    tx(db, write)
    return state
