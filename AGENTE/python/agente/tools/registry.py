"""غلاف موحد لكل أداة (قواعد كود S4 #1 و #4 و #7):
 - الصلاحية تُفرض هنا على الخادم (من يطلب: AGT-1 أم إنسان) — لا من تعليمات النموذج (MIT-3 / LLM06)
 - مفتاح الإيقاف يُقرأ عند كل استدعاء (BASE-A3)
 - مهلة لكل أداة (C-11 tool_timeout_s)
 - سطر تتبع لكل استدعاء بنتيجته (BASE-A1)
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

from ..guards.caps import with_timeout
from ..guards.killswitch import assert_enabled
from ..observability.errors import AppError, as_app_error
from ..observability.trace import digest


@dataclass
class ToolCtx:
    app: Any  # AppContext
    run_id: str
    actor: str  # "AGT-1" | "human" | "system"
    actor_name: str  # اسم المستخدم للإنسان (من الجلسة لا من النموذج)


def actor_label(ctx: ToolCtx) -> str:
    return f"human:{ctx.actor_name}" if ctx.actor == "human" else ctx.actor


@dataclass(frozen=True)
class ToolDef:
    tool: str  # TL-1..TL-4
    op: str
    actors: tuple[str, ...]
    run: Callable[[ToolCtx, Any], Any]


async def invoke(d: ToolDef, ctx: ToolCtx, inp: Any) -> Any:
    t0 = time.monotonic()
    base = {"run_id": ctx.run_id, "component": d.tool, "input_digest": digest(inp)}
    try:
        if ctx.actor not in d.actors:
            raise AppError("FORBIDDEN_TOOL", f"{d.tool}.{d.op} by {ctx.actor}")
        assert_enabled(ctx.app.cfg, d.tool)

        async def call() -> Any:
            return d.run(ctx, inp)

        out = await with_timeout(ctx.app.cfg["caps"]["tool_timeout_s"] * 1000, f"{d.tool}.{d.op}", call)
        ctx.app.tracer.write({**base, "output_digest": digest(out), "ms": int((time.monotonic() - t0) * 1000), "outcome": f"{d.op}:ok"})
        return out
    except Exception as e:
        err = as_app_error(e)
        ctx.app.tracer.write({**base, "output_digest": digest(err.code), "ms": int((time.monotonic() - t0) * 1000), "outcome": f"{d.op}:{err.code}"})
        raise err from e
