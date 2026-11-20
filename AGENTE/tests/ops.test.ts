/** التشغيل: النسخ والاستعادة (BASE-7)، التذكير بالمتأخر، مفتاح الإيقاف (BASE-A3)، المؤشرات (DEC-3) */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeApp, AS_OF } from "./helpers.ts";
import { DemoModel } from "../agents/model.ts";
import { runCycle } from "../agents/agt1.ts";
import { createBackup, verifyBackup, restoreBackup } from "../storage/backup.ts";
import { remindOverdue } from "../scripts/scheduler.ts";
import { openAlerts } from "../hitl/alerts.ts";
import { setControls, readControls } from "../guards/killswitch.ts";
import { invoke } from "../tools/registry.ts";
import { TL3_RECORD } from "../tools/tl3_outcomes.ts";
import { computeMetrics } from "../hitl/metrics.ts";
import { DatabaseSync } from "node:sqlite";

test("backup is consistent, checksummed, and restorable; tampering is detected", async () => {
  const app = makeApp({ model: new DemoModel() });
  await runCycle(app, { as_of: AS_OF, trigger: "manual" });
  const b = createBackup(app.cfg, app.db);
  assert.equal(verifyBackup(b.file).ok, true);
  const copy = new DatabaseSync(b.file, { readOnly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM predictions").get() as { n: number }).n, 1);
  copy.close();
  app.db.close();
  const r = restoreBackup(app.cfg, b.file);
  assert.ok(fs.existsSync(r.restored_to) && r.previous_saved_as);
  fs.appendFileSync(b.file, "x");
  assert.equal(verifyBackup(b.file).ok, false, "tampered backup is rejected");
});

test("overdue decisions raise repeated reminders", async () => {
  const app = makeApp({ model: new DemoModel() });
  const c = await runCycle(app, { as_of: AS_OF, trigger: "manual" });
  const n = remindOverdue(app, Date.parse("2026-12-01T00:00:00Z"));
  assert.ok(n >= 1);
  assert.ok(openAlerts(app).some((a) => a.kind === "overdue" && a.ref === c.prediction_ref));
});

test("kill switch stops tools immediately, per tool or globally, and is audited", async () => {
  const app = makeApp({ model: new DemoModel() });
  setControls(app.cfg, app.db, { enabled: false, disabled_tools: ["TL-3"] }, "human:owner", "صيانة");
  await assert.rejects(invoke(TL3_RECORD, { app, run_id: "r", actor: "human", actorName: "owner" }, { case_ref: "H-0001", birth_datetime: "2026-11-20T01:00:00Z", apgar_value: "8" }), /KILL_SWITCH/);
  assert.deepEqual(readControls(app.cfg).disabled_tools, ["TL-3"]);
  setControls(app.cfg, app.db, { enabled: true, disabled_tools: [] }, "human:owner", "إيقاف كامل");
  const r = await runCycle(app, { as_of: AS_OF, trigger: "manual" });
  assert.equal(r.status, "stopped");
  assert.ok((app.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE entity = 'control'").get() as { n: number }).n === 2);
});

test("metrics follow DEC-3 thresholds over a period", async () => {
  const app = makeApp({ model: new DemoModel() });
  const m = computeMetrics(app, 30);
  assert.equal(m.class_match.pct, null, "no data → no verdict");
  assert.equal(m.class_match.threshold, 85);
  assert.equal(m.count_match.threshold, 80);
  assert.equal(m.unescalated, 0);
});

test("a bad model id or missing key fails with a clear message, never silently", async () => {
  const app = makeApp({ overrides: { model: { provider: "openai_compatible", model: "" } } });
  const r = await runCycle(app, { as_of: AS_OF, trigger: "manual" });
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "NEEDS_REEVAL", "live model without a passing eval never runs (MIT-8)");
});
