"""C-11 ConfigSpec (BASE-8 / BASE-A2 / BASE-A4): كل القيم من ملفات الإعدادات، لا من الكود.
config/settings.json (افتراضي في الريبو) + config/settings.local.json (خادم المشفى، خارج الريبو).
الأسرار من متغيرات البيئة فقط (BASE-A7) — الملفات تحوي اسم المتغير لا قيمته.
قيمة ناقصة أو غير صالحة → الإقلاع يفشل برسالة واضحة (لا افتراض صامت).

الإعدادات تبقى قاموساً (dict) بنفس بنية ملف JSON — نفس المفاتيح في النسختين.
"""
from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Any

from ..observability.errors import AppError

Config = dict[str, Any]


def project_root() -> str:
    """جذر المشروع: AGENTE_HOME (للاختبارات والخادم) أو مجلد AGENTE/python"""
    home = os.environ.get("AGENTE_HOME")
    return os.path.abspath(home) if home else str(Path(__file__).resolve().parents[2])


def _read_json(file: str) -> dict[str, Any]:
    try:
        with open(file, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        raise AppError("CONFIG_INVALID", f"{file}: {e}", f"ملف الإعدادات غير صالح: {os.path.basename(file)}") from e


def merge(base: Any, over: Any) -> Any:
    if not isinstance(over, dict):
        return over
    out = dict(base) if isinstance(base, dict) else {}
    for k, v in over.items():
        out[k] = merge(out[k], v) if k in out else v
    return out


TIME = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")


def _g(c: Any, *keys: str) -> Any:
    for k in keys:
        if not isinstance(c, dict):
            return None
        c = c.get(k)
    return c


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _fmt(n: Any) -> str:
    return str(int(n)) if isinstance(n, float) and n.is_integer() else str(n)


def validate(c: Any) -> list[str]:
    p: list[str] = []

    def num(v: Any, name: str, lo: float, hi: float) -> None:
        if not _is_num(v) or v < lo or v > hi:
            p.append(f"{name} يجب أن يكون رقماً بين {_fmt(lo)} و {_fmt(hi)}")

    def string(v: Any, name: str, allow_empty: bool = False) -> None:
        if not isinstance(v, str) or (not allow_empty and not v.strip()):
            p.append(f"{name} مطلوب")

    if _g(c, "model", "provider") not in ("openai_compatible", "demo"):
        p.append("model.provider يجب أن يكون openai_compatible أو demo")
    string(_g(c, "model", "base_url"), "model.base_url", True)
    string(_g(c, "model", "model"), "model.model", True)
    string(_g(c, "model", "api_key_env"), "model.api_key_env")
    num(_g(c, "model", "temperature"), "model.temperature", 0, 2)
    num(_g(c, "model", "max_output_tokens"), "model.max_output_tokens", 200, 32000)
    for k, lo, hi in (("max_model_calls_per_cycle", 1, 50), ("max_tool_steps", 1, 50), ("model_timeout_s", 5, 600),
                      ("tool_timeout_s", 1, 300), ("cycle_timeout_s", 30, 7200), ("max_cases_per_cycle", 1, 500),
                      ("max_infants_per_case", 1, 10)):
        num(_g(c, "caps", k), f"caps.{k}", lo, hi)
    num(_g(c, "window_days"), "window_days", 1, 31)
    num(_g(c, "thresholds", "count_match_pct"), "thresholds.count_match_pct", 0, 100)
    num(_g(c, "thresholds", "class_match_pct"), "thresholds.class_match_pct", 0, 100)
    num(_g(c, "apgar_bands", "high_risk_max"), "apgar_bands.high_risk_max", 0, 10)
    num(_g(c, "apgar_bands", "medium_risk_max"), "apgar_bands.medium_risk_max", 0, 10)
    hr, mr = _g(c, "apgar_bands", "high_risk_max"), _g(c, "apgar_bands", "medium_risk_max")
    if _is_num(hr) and _is_num(mr) and hr >= mr:
        p.append("apgar_bands.high_risk_max يجب أن يكون أقل من medium_risk_max")
    if not isinstance(_g(c, "kill_switch", "enabled"), bool) or not isinstance(_g(c, "kill_switch", "disabled_tools"), list):
        p.append("kill_switch غير صالح")
    for k in ("daily_cycle_time", "batch_deadline_time", "backup_time"):
        v = _g(c, "schedule", k)
        if not TIME.fullmatch("" if v is None else str(v)):
            p.append(f"schedule.{k} بصيغة HH:MM")
    num(_g(c, "schedule", "reminder_every_minutes"), "schedule.reminder_every_minutes", 5, 1440)
    num(_g(c, "schedule", "backups_keep"), "schedule.backups_keep", 1, 365)
    if _g(c, "source", "type") not in ("json_file", "csv_file"):
        p.append("source.type يجب أن يكون json_file أو csv_file")
    string(_g(c, "source", "path"), "source.path")
    string(_g(c, "source", "system_name"), "source.system_name")
    for k in ("source_key", "gestation_week", "expected_delivery_date", "expected_infants", "notes"):
        string(_g(c, "source", "fields", k), f"source.fields.{k}")
    ind = _g(c, "source", "fields", "indicators")
    if not isinstance(ind, list) or not ind:
        p.append("source.fields.indicators قائمة غير فارغة")
    ident = _g(c, "source", "fields", "identity")
    if not isinstance(ident, list):
        p.append("source.fields.identity قائمة")
    if not isinstance(ident, list) or _g(c, "source", "fields", "source_key") not in ident:
        p.append("source.fields.identity يجب أن تشمل source_key (لا يخرج المعرف الأصلي)")
    num(_g(c, "server", "port"), "server.port", 1, 65535)
    num(_g(c, "server", "session_hours"), "server.session_hours", 1, 72)
    num(_g(c, "server", "max_login_attempts"), "server.max_login_attempts", 1, 50)
    num(_g(c, "server", "lockout_minutes"), "server.lockout_minutes", 1, 1440)
    for k in ("db", "trace_dir", "controls", "eval_baseline", "backups_dir", "reports_dir", "shared_dir"):
        string(_g(c, "paths", k), f"paths.{k}")
    return p


def load_config(overrides: dict[str, Any] | None = None) -> Config:
    root = project_root()
    base = _read_json(os.path.join(root, "config", "settings.json"))
    local_file = os.path.join(root, "config", "settings.local.json")
    merged = merge(base, _read_json(local_file) if os.path.exists(local_file) else {})
    merged = merge(merged, overrides or {})
    merged.pop("_comment", None)
    problems = validate(merged)
    if problems:
        raise AppError("CONFIG_INVALID", "; ".join(problems), f"الإعدادات غير صالحة: {'؛ '.join(problems)}")
    merged["root"] = root
    return merged


def resolve_path(cfg: Config, p: str) -> str:
    """مسار داخل جذر المشروع (المسارات في الإعدادات نسبية للجذر)"""
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(cfg["root"], p))


def shared_dir(cfg: Config) -> str:
    """مجلد AGENTE/ المشترك مع نسخة TypeScript: prompts/ و samples/ و evals/cases/ و redteam/cases/ (مصدر حقيقة واحد)"""
    return resolve_path(cfg, cfg["paths"]["shared_dir"])


def model_api_key(cfg: Config) -> str:
    """مفتاح النموذج من البيئة فقط (BASE-A7) — لا يُكتب في أي ملف أو سجل"""
    return (os.environ.get(cfg["model"]["api_key_env"]) or "").strip()


def secret_values(cfg: Config) -> list[str]:
    """قيم سرية يجب ألا تظهر في أي سجل أو مخرج"""
    return [s for s in [model_api_key(cfg)] if len(s) >= 8]
