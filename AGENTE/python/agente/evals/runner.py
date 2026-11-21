"""BASE-A8 — مشغّل التقييم (EV-1..EV-8 و RT-1..RT-6). يشغّل كل حالة runs_per_case مرة، يكتب تقريراً في evals/reports/،
ويخرج بخطأ عند أي فشل (يوقف النشر). في وضع --live: الحالات المعتمدة على النموذج تُشغَّل بالنموذج الحي،
والنجاح الكامل يكتب data/eval_baseline.json (MIT-8) — بدونه لا يعمل الوكيل بنموذج حي.
الحالات نفسها تُقرأ من AGENTE/evals/cases و AGENTE/redteam/cases (مشتركة مع نسخة TypeScript).
"""
from __future__ import annotations

import json
import os
import platform
from datetime import datetime, timezone
from typing import Any

from ..agents.model import OpenAICompatibleModel
from ..agents.prompts import load_prompt
from ..config.config import load_config, project_root, resolve_path, shared_dir
from ..jsutil import iso, jdump
from ..observability.errors import as_app_error
from ..observability.trace import new_run_id
from .checks import CHECKS, MODEL_DEPENDENT


def load_cases(root: str) -> list[dict[str, Any]]:
    out = []
    for d in ("evals/cases", "redteam/cases"):
        p = os.path.join(root, d)
        for f in sorted(x for x in os.listdir(p) if x.endswith(".json")):
            with open(os.path.join(p, f), encoding="utf-8") as fh:
                out.append(json.load(fh))
    return out


async def run_evals(live: bool = False, runs: int | None = None, only: list[str] | None = None, write: bool = True) -> dict[str, Any]:
    cfg = load_config()
    prompt = load_prompt(cfg, "AGT-1")
    env = {"live": live, "base_root": project_root(), "live_model": (lambda: OpenAICompatibleModel(cfg)) if live else None}
    results = []
    for c in load_cases(shared_dir(cfg)):
        if only and c["case_id"] not in only:
            continue
        check = CHECKS.get(c["case_id"])
        out = []
        n = runs if runs is not None else (c["runs_per_case"] if live and c["case_id"] in MODEL_DEPENDENT else 1)
        for _ in range(n):
            try:
                out.append(await check({**env, "live": live and c["case_id"] in MODEL_DEPENDENT}) if check
                           else {"pass": False, "evidence": "لا فحص لهذه الحالة"})
            except Exception as e:
                err = as_app_error(e)
                out.append({"pass": False, "evidence": f"خطأ: {err.code} {err.detail}"[:300]})
        results.append({"case_id": c["case_id"], "runs": out, "pass": len(out) > 0 and all(r["pass"] for r in out)})
    report = {"run_id": new_run_id("e"), "at": iso(datetime.now(timezone.utc)), "live": live, "model": cfg["model"]["model"] if live else "scripted",
              "prompt_version": prompt.version, "passed": all(r["pass"] for r in results), "results": results}
    if write:
        d = resolve_path(cfg, cfg["paths"]["reports_dir"])
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{report['run_id']}.json"), "w", encoding="utf-8") as fh:
            fh.write(jdump(report, indent=2))
        mode = f"حي ({cfg['model']['model']})" if live else "حتمي (نموذج مكتوب)"
        lines = [f"# تقرير التقييم {report['run_id']}", "", f"- الوضع: {mode} · التعليمات: {report['prompt_version']} · {report['at']}",
                 f"- النتيجة: {'✅ كل الحالات نجحت' if report['passed'] else '❌ يوجد فشل — النشر متوقف'}", "",
                 "| الحالة | النتيجة | التشغيلات | الدليل |", "|---|---|---|---|"]
        for r in results:
            ev = next((x for x in r["runs"] if not x["pass"]), r["runs"][0] if r["runs"] else None)
            lines.append(f"| {r['case_id']} | {'✅' if r['pass'] else '❌'} | {sum(1 for x in r['runs'] if x['pass'])}/{len(r['runs'])} | {ev['evidence'].replace('|', '/') if ev else ''} |")
        with open(os.path.join(d, f"{report['run_id']}.md"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        if live and report["passed"] and not only:
            b = resolve_path(cfg, cfg["paths"]["eval_baseline"])
            os.makedirs(os.path.dirname(b), exist_ok=True)
            with open(b, "w", encoding="utf-8") as fh:
                fh.write(jdump({"passed": True, "model": cfg["model"]["model"], "fallback_model": cfg["model"]["fallback_model"],
                                "prompt_version": prompt.version, "at": report["at"], "run_id": report["run_id"],
                                "python": platform.python_version()}, indent=2))
    return report
