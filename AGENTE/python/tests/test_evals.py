"""BASE-A8: كل حالات EV-1..EV-8 و RT-1..RT-6 تنجح في الوضع الحتمي — نفس ما يشغّله CI"""
import asyncio

from agente.evals.runner import run_evals


def test_all_ev_and_rt_cases_pass_scripted_model():
    r = asyncio.run(run_evals(write=False))
    failed = [f"{x['case_id']}: {' | '.join(y['evidence'] for y in x['runs'])}" for x in r["results"] if not x["pass"]]
    assert len(r["results"]) == 14
    assert failed == []
