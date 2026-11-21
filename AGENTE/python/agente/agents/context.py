"""سياق التطبيق المشترك: الإعدادات + قاعدة البيانات + التتبع + هويات الدفعة الحالية (لحجبها من أي سجل)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator

from ..config.config import Config, load_config, resolve_path, secret_values
from ..observability.trace import Tracer
from ..storage.db import Db, open_db


class OrderedSet:
    """مجموعة تحفظ ترتيب الإضافة (كـ Set في JavaScript)"""

    def __init__(self) -> None:
        self._d: dict[str, None] = {}

    def add(self, v: str) -> None:
        self._d[v] = None

    def __iter__(self) -> Iterator[str]:
        return iter(list(self._d))

    def __len__(self) -> int:
        return len(self._d)

    def __contains__(self, v: object) -> bool:
        return v in self._d


@dataclass
class AppContext:
    cfg: Config
    db: Db
    tracer: Tracer
    # قيم هوية كاملة للحالات المقروءة في هذه العملية — لا تُخزَّن؛ ظهورها في أي مخرج يوقف العملية (HR-5)
    identities: OrderedSet = field(default_factory=OrderedSet)
    # أجزاء الأسماء — تُحجب من السجلات والنص الحر فقط
    name_parts: OrderedSet = field(default_factory=OrderedSet)
    # يُحقن في الاختبارات والتقييم؛ في التشغيل العادي يُبنى من الإعدادات
    model_override: Any = None


def create_context(cfg: Config | None = None, overrides: dict[str, Any] | None = None, model: Any = None) -> AppContext:
    cfg = cfg if cfg is not None else load_config(overrides)
    db = open_db(resolve_path(cfg, cfg["paths"]["db"]))
    identities = OrderedSet()
    name_parts = OrderedSet()
    tracer = Tracer(resolve_path(cfg, cfg["paths"]["trace_dir"]), secret_values(cfg), lambda: [*identities, *name_parts])
    return AppContext(cfg=cfg, db=db, tracer=tracer, identities=identities, name_parts=name_parts, model_override=model)


def close_context(app: AppContext) -> None:
    try:
        app.db.close()
    except Exception:  # مغلقة أصلاً
        pass
