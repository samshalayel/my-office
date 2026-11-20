/** تكامل UF-1 → UF-2 → UF-3 بالنموذج التجريبي الحتمي (verify-T7 / verify-T8) */
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, AS_OF } from "./helpers.ts";
import { DemoModel } from "../agents/model.ts";
import { runCycle, compareOutcome } from "../agents/agt1.ts";
import { decideHitl1, decideHitl2, decideHitl3 } from "../hitl/decisions.ts";
import { invoke } from "../tools/registry.ts";
import { TL3_RECORD } from "../tools/tl3_outcomes.ts";
import { getPrediction } from "../tools/tl2_predictions.ts";
import { listDrafts } from "../tools/tl4_drafts.ts";
import { openAlerts } from "../hitl/alerts.ts";

test("UF-1/UF-2/UF-3 end to end with the demo model", async () => {
  const app = makeApp({ model: new DemoModel() });
  const c = await runCycle(app, { as_of: AS_OF, trigger: "manual" });
  assert.equal(c.status, "awaiting_hitl1", JSON.stringify(c));
  const p = getPrediction(app.db, c.prediction_ref!)!;
  // 3 حالات في النافذة: (31 أسبوع، 1) + (34، توأم) + (36، 1) = 4 أطفال
  assert.equal(p.count_value, 4);
  assert.equal(p.risk_class, "high");
  assert.deepEqual(p.missing_fields, ["H-0003.fetal_weight_g", "H-0003.weight_gain_kg"]);
  assert.equal(p.basis.confidence_flag, "low");
  assert.ok(openAlerts(app).some((a) => a.kind === "critical" && a.ref === p.prediction_ref), "critical alert for high class");
  assert.ok(openAlerts(app).some((a) => a.kind === "source"), "excluded source records are announced");

  const h1 = decideHitl1(app, { prediction_ref: p.prediction_ref, decision: "approve", reason: "الأساس كافٍ" }, "owner");
  await h1.prepare;
  assert.equal(getPrediction(app.db, p.prediction_ref)!.status, "approved");
  const prep = listDrafts(app.db, "draft_type = 'preparation' AND status = 'active'");
  assert.equal(prep.length, 1);
  const actions = listDrafts(app.db, "draft_type = 'action' AND status = 'pending'");
  assert.equal(actions.length, 1);

  // UF-2: مولود H-0001 فعلياً بفئة low (Apgar 9) بينما المتوقع high → خلاف + موارد محجوزة → تصعيد
  const ctx = { app, run_id: "r-test", actor: "human" as const, actorName: "owner" };
  const o = await invoke(TL3_RECORD, ctx, { case_ref: "H-0001", birth_datetime: "2026-11-20T03:40:00Z", apgar_value: "9", note: "" });
  const cmp = await compareOutcome(app, o.actual_ref);
  assert.equal(cmp.class_mismatch, true);
  assert.equal(cmp.escalated, true);
  const h2 = decideHitl2(app, { discrepancy_ref: cmp.discrepancy_ref, decision: "approve", reason: "نبقي التوزيع احتياطاً" }, "owner");
  assert.ok(h2.decision_id.startsWith("HD-"));

  // UF-3: موافقة HITL-3 → END-2 بلا أي تنفيذ داخل النظام
  const h3 = decideHitl3(app, { draft_ref: actions[0].draft_ref, decision: "approve", reason: "موافق" }, "owner");
  assert.equal(h3.end_state, "END_2_HUMAN_EXECUTES");
});
