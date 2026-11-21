"""تكامل UF-1 → UF-2 → UF-3 بالنموذج التجريبي الحتمي (verify-T7 / verify-T8)"""
import asyncio

from agente.agents.agt1 import compare_outcome, run_cycle
from agente.agents.model import DemoModel
from agente.hitl.alerts import open_alerts
from agente.hitl.decisions import decide_hitl1, decide_hitl2, decide_hitl3
from agente.tools.registry import ToolCtx, invoke
from agente.tools.tl2_predictions import get_prediction
from agente.tools.tl3_outcomes import TL3_RECORD
from agente.tools.tl4_drafts import list_drafts

from .helpers import AS_OF, make_app


def test_uf1_uf2_uf3_end_to_end_with_the_demo_model():
    async def main():
        app = make_app(model=DemoModel())
        c = await run_cycle(app, as_of=AS_OF, trigger="manual")
        assert c["status"] == "awaiting_hitl1", c
        p = get_prediction(app.db, c["prediction_ref"])
        # 3 حالات في النافذة: (31 أسبوع، 1) + (34، توأم) + (36، 1) = 4 أطفال
        assert p["count_value"] == 4
        assert p["risk_class"] == "high"
        assert p["missing_fields"] == ["H-0003.fetal_weight_g", "H-0003.weight_gain_kg"]
        assert p["basis"]["confidence_flag"] == "low"
        assert any(a["kind"] == "critical" and a["ref"] == p["prediction_ref"] for a in open_alerts(app)), "critical alert for high class"
        assert any(a["kind"] == "source" for a in open_alerts(app)), "excluded source records are announced"

        h1 = decide_hitl1(app, {"prediction_ref": p["prediction_ref"], "decision": "approve", "reason": "الأساس كافٍ"}, "owner")
        await h1["prepare"]
        assert get_prediction(app.db, p["prediction_ref"])["status"] == "approved"
        assert len(list_drafts(app.db, "draft_type = 'preparation' AND status = 'active'")) == 1
        actions = list_drafts(app.db, "draft_type = 'action' AND status = 'pending'")
        assert len(actions) == 1

        # UF-2: مولود H-0001 فعلياً بفئة low (Apgar 9) بينما المتوقع high → خلاف + موارد محجوزة → تصعيد
        ctx = ToolCtx(app=app, run_id="r-test", actor="human", actor_name="owner")
        o = await invoke(TL3_RECORD, ctx, {"case_ref": "H-0001", "birth_datetime": "2026-11-20T03:40:00Z", "apgar_value": "9", "note": ""})
        cmp = await compare_outcome(app, o["actual_ref"])
        assert cmp["class_mismatch"] is True
        assert cmp["escalated"] is True
        h2 = decide_hitl2(app, {"discrepancy_ref": cmp["discrepancy_ref"], "decision": "approve", "reason": "نبقي التوزيع احتياطاً"}, "owner")
        assert h2["decision_id"].startswith("HD-")

        # UF-3: موافقة HITL-3 → END-2 بلا أي تنفيذ داخل النظام
        h3 = decide_hitl3(app, {"draft_ref": actions[0]["draft_ref"], "decision": "approve", "reason": "موافق"}, "owner")
        assert h3["end_state"] == "END_2_HUMAN_EXECUTES"

    asyncio.run(main())
