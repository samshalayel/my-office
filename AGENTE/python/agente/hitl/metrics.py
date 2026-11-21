"""مؤشرات النجاح بعتبات DEC-3 (≥80% عدد، ≥85% فئة، صفر خلاف بلا تصعيد) — تُحسب على فترة، لا على توقع واحد (DEV-3):
 - مطابقة الفئة: من كل مقارنات المواليد بتوقعاتهم، كم طابقت فئته المتوقعة.
 - مطابقة العدد: لكل دورة انتهت نافذتها وتوقعها معتمد: 1 − |الفعلي − المتوقع| / max(الفعلي، المتوقع، 1) — المتوسط.
 - خلاف بلا تصعيد: خلاف على توقع له موارد محجوزة لم يُصعَّد — يجب أن يكون صفراً.
"""
from __future__ import annotations

from typing import Any

from ..jsutil import iso_from_ms, js_round, now_ms, parse_date_ms
from ..storage.db import q1, qall
from ..tools.tl2_predictions import list_predictions

DAY = 86_400_000


def _round1(x: float) -> float:
    """Math.round(x * 1000) / 10 — نسبة بمنزلة عشرية واحدة"""
    v = js_round(x * 1000) / 10
    return int(v) if float(v).is_integer() else v


def compute_metrics(app: Any, days: int = 30, now: float | None = None) -> dict[str, Any]:
    db, cfg = app.db, app.cfg
    now = now_ms() if now is None else now
    since = iso_from_ms(now - days * DAY)
    cmp = qall(db, "SELECT class_mismatch, prediction_ref FROM discrepancies WHERE created_at >= ? AND prediction_ref <> 'UNPLANNED'", since)
    matched = sum(1 for r in cmp if r["class_mismatch"] == 0)
    class_pct = _round1(matched / len(cmp)) if cmp else None

    detail: list[dict[str, Any]] = []
    for p in list_predictions(db, "status IN ('approved','modified') AND created_at >= ?", since):
        # التوقع الذي حلّ محله توقع أحدث (HITL-2 تعديل) لا يُحسب مرتين
        if q1(db, "SELECT 1 AS x FROM predictions WHERE supersedes = ?", p["prediction_ref"]):
            continue
        row = q1(db, "SELECT as_of FROM cycles WHERE cycle_id = ?", p["cycle_id"])
        if not row:
            continue
        start = parse_date_ms(f"{row['as_of']}T00:00:00Z")
        if start is None:
            continue
        end = start + (cfg["window_days"] + 1) * DAY
        if end > now:
            continue  # النافذة لم تنتهِ — لا حكم بعد
        refs = qall(db, "SELECT case_ref FROM cycle_cases WHERE cycle_id = ?", p["cycle_id"])
        if not refs:
            continue
        marks = ",".join("?" for _ in refs)
        actual = q1(db, f"SELECT COUNT(*) AS n FROM outcomes WHERE case_ref IN ({marks}) AND birth_datetime >= ? AND birth_datetime < ?",
                    *[r["case_ref"] for r in refs], iso_from_ms(start), iso_from_ms(end))["n"]
        detail.append({"prediction_ref": p["prediction_ref"], "predicted": p["count_value"], "actual": actual})
    accs = [1 - abs(d["actual"] - d["predicted"]) / max(d["actual"], d["predicted"], 1) for d in detail]
    count_pct = _round1(sum(accs) / len(accs)) if accs else None
    unescalated = q1(db, "SELECT COUNT(*) AS n FROM discrepancies WHERE class_mismatch = 1 AND resources_reserved = 1 AND escalated = 0 AND created_at >= ?", since)["n"]
    unplanned = q1(db, "SELECT COUNT(*) AS n FROM discrepancies WHERE prediction_ref = 'UNPLANNED' AND created_at >= ?", since)["n"]
    th = cfg["thresholds"]
    return {
        "days": days,
        "class_match": {"matched": matched, "compared": len(cmp), "pct": class_pct, "threshold": th["class_match_pct"],
                        "pass": None if class_pct is None else class_pct >= th["class_match_pct"]},
        "count_match": {"cycles": len(detail), "pct": count_pct, "threshold": th["count_match_pct"],
                        "pass": None if count_pct is None else count_pct >= th["count_match_pct"], "detail": detail},
        "unescalated": unescalated,
        "unplanned": unplanned,
    }
