"""TL-1 / C-1 — قراءة بيانات الحوامل من سجلات المشفى حصراً (BR-3 / K-5)، نافذة الأسبوع الأخير حصراً (BR-5).
المدخل { as_of, window_days } → المخرج { cases, source_system, fetched_at } — فشل: SOURCE_UNAVAILABLE.

داخل الأداة نفسها (قبل أن يرى الوكيل أي شيء):
 - MIT-5: حذف حقول الهوية وإبدالها برقم مرجعي H-0001 (الخريطة محلية — C-15)، وحجب أي معرف في النص الحر
 - MIT-1: الملاحظات نص معزول؛ عبارات أوامر بداخلها تُعلَّم للإنسان ولا تُنفَّذ
 - EV-2: الحقل الناقص null — لا يُملأ
 - MIT-7 / RT-4: عدد حالات أو أجنّة يتجاوز السقف = توقف آمن وتصعيد، لا قص صامت
مصدر الإدخال في هذا الإصدار: ملف تصدير JSON/CSV يضعه نظام المشفى في data/inbox (DEV-1 — الربط الفعلي يحتاج قراراً).
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

from ..config.config import Config, resolve_path
from ..guards.pii import identity_tokens, injection_flag, redact_text
from ..hitl.alerts import raise_alert
from ..jsutil import is_finite, jdump, js_number, js_round, js_str, js_trim, parse_date_ms
from ..observability.errors import AppError
from ..storage.db import Db, now_iso, q1, qall, random_ref, tx, write_audit
from .registry import ToolCtx, ToolDef, actor_label


def parse_csv(text: str) -> list[dict[str, str]]:
    rows: list[list[str]] = []
    row: list[str] = []
    cell = ""
    q = False
    s = text[1:] if text.startswith("﻿") else text
    i = 0
    while i < len(s):
        ch = s[i]
        if q:
            if ch == '"' and i + 1 < len(s) and s[i + 1] == '"':
                cell += '"'
                i += 1
            elif ch == '"':
                q = False
            else:
                cell += ch
        elif ch == '"':
            q = True
        elif ch == ",":
            row.append(cell)
            cell = ""
        elif ch in ("\n", "\r"):
            if ch == "\r" and i + 1 < len(s) and s[i + 1] == "\n":
                i += 1
            row.append(cell)
            cell = ""
            if any(c != "" for c in row):
                rows.append(row)
            row = []
        else:
            cell += ch
        i += 1
    row.append(cell)
    if any(c != "" for c in row):
        rows.append(row)
    if not rows:
        return []
    head, body = rows[0], rows[1:]
    return [{js_trim(h): (r[i] if i < len(r) else "") for i, h in enumerate(head)} for r in body]


def read_source_records(cfg: Config) -> list[dict[str, Any]]:
    file = resolve_path(cfg, cfg["source"]["path"])
    try:
        with open(file, encoding="utf-8", newline="") as fh:
            raw = fh.read()
    except OSError as e:
        code = {2: "ENOENT", 13: "EACCES", 21: "EISDIR"}.get(e.errno or 0, "read error")
        raise AppError("SOURCE_UNAVAILABLE", f"{cfg['source']['type']}: {code}") from e
    except UnicodeDecodeError as e:
        raise AppError("SOURCE_UNAVAILABLE", f"parse: {e}", "ملف سجلات المشفى غير صالح — توقفت الدورة بلا توقع.") from e
    try:
        if cfg["source"]["type"] == "csv_file":
            return parse_csv(raw)
        j = json.loads(raw)
        lst = j if isinstance(j, list) else j.get("records") if isinstance(j, dict) and isinstance(j.get("records"), list) else None
        if lst is None:
            raise ValueError("expected an array or {records: []}")
        return [r for r in lst if isinstance(r, dict)]
    except ValueError as e:
        raise AppError("SOURCE_UNAVAILABLE", f"parse: {e}", "ملف سجلات المشفى غير صالح — توقفت الدورة بلا توقع.") from e


_NUMERIC = re.compile(r"-?[0-9]+(\.[0-9]+)?")


def normalize(v: Any) -> Any:
    """قيمة مؤشر: رقم أو نص أو null (الناقص لا يُملأ)"""
    if v is None:
        return None
    if isinstance(v, bool):
        return "نعم" if v else "لا"
    if isinstance(v, (int, float)):
        if not math.isfinite(v):
            return None
        return int(v) if float(v).is_integer() else v
    s = js_trim(js_str(v))
    if s == "":
        return None
    if _NUMERIC.fullmatch(s):
        n = float(s)
        return int(n) if n.is_integer() else n
    return s[:200]


def parse_date(v: Any) -> float | None:
    if v is None or js_trim(js_str(v)) == "":
        return None
    return parse_date_ms(js_trim(js_str(v))[:10] + "T00:00:00Z")


DAY = 86_400_000


def _read(ctx: ToolCtx, inp: dict[str, Any]) -> dict[str, Any]:
    cfg, db = ctx.app.cfg, ctx.app.db
    f = cfg["source"]["fields"]
    if inp["window_days"] != cfg["window_days"]:
        raise AppError("REJECTED_SCHEMA", f"window_days={js_str(inp['window_days'])}", f"النافذة {cfg['window_days']} أيام حصراً (BR-5).")
    as_of = parse_date(inp["as_of"])
    if as_of is None:
        raise AppError("REJECTED_SCHEMA", "as_of", "تاريخ الدورة غير صالح.")

    records = read_source_records(cfg)
    excluded = {"no_key": 0, "no_edd": 0, "bad_gestation": 0, "bad_infants": 0}
    picked: list[dict[str, Any]] = []
    for rec in records:
        kv = rec.get(f["source_key"])
        key = js_trim("" if kv is None else js_str(kv))
        if not key:
            excluded["no_key"] += 1
            continue
        edd = parse_date(rec.get(f["expected_delivery_date"]))
        if edd is None:
            excluded["no_edd"] += 1
            continue
        if edd < as_of or edd > as_of + inp["window_days"] * DAY:
            continue  # خارج النافذة: ليس من الدورة
        gw_raw = rec.get(f["gestation_week"], _UNDEF)
        gw = math.nan if gw_raw is _UNDEF or isinstance(gw_raw, (dict, list)) else js_number(gw_raw)
        if not is_finite(gw) or gw < 20 or gw > 45:
            excluded["bad_gestation"] += 1
            continue
        inf_raw = normalize(rec.get(f["expected_infants"]))
        infants = None
        if inf_raw is not None:
            if not isinstance(inf_raw, int) or inf_raw < 1:
                excluded["bad_infants"] += 1
                continue
            infants = inf_raw
        picked.append({"key": key, "rec": rec, "gw": js_round(gw), "infants": infants,
                       "ids": identity_tokens(rec.get(k) for k in f["identity"])})
    if len(picked) > cfg["caps"]["max_cases_per_cycle"]:
        raise AppError("CAP_EXCEEDED", f"cases={len(picked)} > {cfg['caps']['max_cases_per_cycle']}",
                       f"عدد الحالات ({len(picked)}) يتجاوز سقف الدورة — توقف آمن وصُعّد للإنسان.")
    for p in picked:
        for ident in p["ids"]["strong"]:
            ctx.app.identities.add(ident)
        for w in p["ids"]["weak"]:
            ctx.app.name_parts.add(w)

    fetched_at = now_iso()

    def write() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        n = q1(db, "SELECT COUNT(*) AS n FROM pseudonym_map")["n"]
        for p in picked:
            row = q1(db, "SELECT case_ref FROM pseudonym_map WHERE source_key = ?", p["key"])
            if not row:
                n += 1
                row = {"case_ref": f"H-{n:04d}"}
                db.execute("INSERT INTO pseudonym_map (case_ref, map_ref, source_key, created_at) VALUES (?, ?, ?, ?)",
                           (row["case_ref"], random_ref("M"), p["key"], fetched_at))
            if p["infants"] is not None and p["infants"] > cfg["caps"]["max_infants_per_case"]:
                raise AppError("CAP_EXCEEDED", f"{row['case_ref']} expected_infants={p['infants']}",
                               f"الحالة {row['case_ref']}: عدد أجنّة شاذ ({p['infants']}) يتجاوز السقف — توقف آمن وصُعّد للإنسان.")
            indicators = {k: normalize(p["rec"].get(k)) for k in [*f["indicators"], f["expected_infants"]]}
            nv = p["rec"].get(f["notes"])
            notes_raw = None if nv is None or js_trim(js_str(nv)) == "" else \
                redact_text(js_str(nv)[:2000], [*p["ids"]["strong"], *p["ids"]["weak"]])["text"]
            c = {"case_ref": row["case_ref"], "gestation_week": p["gw"], "in_last_week_window": True, "indicators": indicators, "notes_raw": notes_raw}
            db.execute("INSERT INTO cycle_cases (cycle_id, case_ref, case_json, expected_infants, notes_flag) VALUES (?, ?, ?, ?, ?)",
                       (inp["cycle_id"], c["case_ref"], jdump(c), p["infants"] if p["infants"] is not None else 1, injection_flag(notes_raw)))
            out.append(c)
        write_audit(db, actor_label(ctx), "case", inp["cycle_id"], "read_cases", after={"cases": len(out), "excluded": excluded})
        return out

    cases = tx(db, write)

    skipped = sum(excluded.values())
    if skipped:
        raise_alert(ctx.app, "source", inp["cycle_id"],
                    f"{skipped} سجل/سجلات من المصدر لم تدخل الدورة {inp['cycle_id']}: بلا رقم ملف {excluded['no_key']}، بلا تاريخ ولادة متوقع {excluded['no_edd']}، أسبوع حمل غير صالح {excluded['bad_gestation']}، عدد أجنّة غير صالح {excluded['bad_infants']} — راجع المصدر.")
    return {"cases": cases, "source_system": cfg["source"]["system_name"], "fetched_at": fetched_at}


_UNDEF = object()

TL1_READ = ToolDef(tool="TL-1", op="read_cases", actors=("AGT-1", "system"), run=_read)


def cycle_cases(db: Db, cycle_id: str) -> list[dict[str, Any]]:
    """حالات الدورة المحفوظة: [{case, expected_infants, notes_flag}]"""
    rows = qall(db, "SELECT case_json, expected_infants, notes_flag FROM cycle_cases WHERE cycle_id = ? ORDER BY case_ref", cycle_id)
    return [{"case": json.loads(r["case_json"]), "expected_infants": r["expected_infants"], "notes_flag": r["notes_flag"]} for r in rows]
