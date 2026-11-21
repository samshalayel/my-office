"""BASE-A2 / MIT-7 / HR-4 — سقوف الدورة: عدد استدعاءات النموذج، خطوات الحلقة، مهلة الدورة.
التجاوز = توقف آمن (AppError CAP_EXCEEDED/TIMEOUT) يصعد للإنسان — لا توقع جزئي.
"""
from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, TypeVar

from ..config.config import Config
from ..jsutil import now_ms
from ..observability.errors import AppError

T = TypeVar("T")


class Budget:
    def __init__(self, cfg: Config, started_at: float | None = None):
        self.max_model_calls: int = cfg["caps"]["max_model_calls_per_cycle"]
        self.max_steps: int = cfg["caps"]["max_tool_steps"]
        self.deadline: float = (started_at if started_at is not None else now_ms()) + cfg["caps"]["cycle_timeout_s"] * 1000
        self.model_calls = 0
        self.steps = 0

    def assert_time(self) -> None:
        if now_ms() > self.deadline:
            raise AppError("TIMEOUT", "cycle_timeout_s")

    def model_call(self) -> None:
        self.assert_time()
        if self.model_calls >= self.max_model_calls:
            raise AppError("CAP_EXCEEDED", f"max_model_calls_per_cycle={self.max_model_calls}")
        self.model_calls += 1

    def step(self) -> None:
        self.assert_time()
        if self.steps >= self.max_steps:
            raise AppError("CAP_EXCEEDED", f"max_tool_steps={self.max_steps}")
        self.steps += 1

    def remaining_ms(self) -> float:
        return max(0.0, self.deadline - now_ms())


async def with_timeout(ms: float, what: str, fn: Callable[[], Awaitable[T]]) -> T:
    """مهلة لأي عملية (أداة/نموذج): أقصر من مهلتها ومن الباقي في الدورة.
    عند انتهائها تُلغى العملية فعلاً (إلغاء مهمة asyncio يقطع طلب HTTP الجاري)."""
    try:
        return await asyncio.wait_for(fn(), timeout=max(1.0, ms) / 1000)
    except asyncio.TimeoutError as e:
        raise AppError("TIMEOUT", what) from e
