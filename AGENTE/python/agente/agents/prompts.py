"""BASE-A5: تعليمات الوكيل ملفات بإصدار في prompts/ (المجلد المشترك AGENTE/prompts) — الإصدار يُسجَّل في كل سطر تتبع.
لا أسرار داخلها (MIT-9)."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

from ..config.config import Config, shared_dir
from ..observability.errors import AppError


@dataclass(frozen=True)
class Prompt:
    version: str
    text: str


def load_prompt(cfg: Config, name: str) -> Prompt:
    file = os.path.join(shared_dir(cfg), "prompts", f"{name}.md")
    try:
        with open(file, encoding="utf-8", newline="") as fh:
            raw = fh.read()
    except OSError as e:
        raise AppError("CONFIG_INVALID", f"prompt {name} missing") from e
    m = re.fullmatch(r"---\s*\nversion:\s*(\S+)\s*\n---\s*\n(.*)", raw, re.S)
    if not m:
        raise AppError("CONFIG_INVALID", f"prompt {name}: missing version header")
    return Prompt(version=m.group(1), text=m.group(2).strip())
