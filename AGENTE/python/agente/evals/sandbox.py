"""بيئة معزولة للتقييم والاختبار: جذر مؤقت بإعدادات المشروع وتعليماته وبيانات اصطناعية — لا تلمس data/ الحقيقية."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from typing import Any

from ..agents.context import AppContext, create_context
from ..config.config import load_config, project_root
from ..jsutil import jdump

AS_OF = "2026-11-20"
PY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHARED = os.path.abspath(os.path.join(PY_ROOT, ".."))  # AGENTE/ — مصدر الحقيقة المشترك مع نسخة TypeScript


def sample_records() -> list[dict[str, Any]]:
    with open(os.path.join(SHARED, "samples", "pregnancies.sample.json"), encoding="utf-8") as fh:
        return json.load(fh)["records"]


def temp_home(records: list[Any] | None = None, base_root: str | None = None) -> str:
    base_root = base_root or project_root()
    home = tempfile.mkdtemp(prefix="agente-")
    os.makedirs(os.path.join(home, "config"))
    shutil.copyfile(os.path.join(base_root, "config", "settings.json"), os.path.join(home, "config", "settings.json"))
    local = os.path.join(base_root, "config", "settings.local.json")
    if os.path.exists(local):
        shutil.copyfile(local, os.path.join(home, "config", "settings.local.json"))
    shutil.copytree(os.path.join(SHARED, "prompts"), os.path.join(home, "prompts"))
    os.makedirs(os.path.join(home, "data", "inbox"))
    with open(os.path.join(home, "data", "inbox", "pregnancies.json"), "w", encoding="utf-8") as fh:
        fh.write(jdump({"records": records if records is not None else sample_records()}))
    return home


def make_app(records: list[Any] | None = None, model: Any = None, overrides: dict[str, Any] | None = None,
             base_root: str | None = None) -> AppContext:
    """تطبيق معزول. الإعدادات: settings.json (+ settings.local.json للتقييم الحي) + overrides، والجدولة متوقفة"""
    home = temp_home(records, base_root)
    prev = os.environ.get("AGENTE_HOME")
    os.environ["AGENTE_HOME"] = home
    try:
        # المجلد المشترك داخل الجذر المؤقت نفسه (prompts منسوخة إليه)
        cfg = load_config({"schedule": {"enabled": False}, "alerts": {"webhook_url": ""}, "paths": {"shared_dir": "."}, **(overrides or {})})
        return create_context(cfg=cfg, model=model)
    finally:
        if prev is None:
            os.environ.pop("AGENTE_HOME", None)
        else:
            os.environ["AGENTE_HOME"] = prev
