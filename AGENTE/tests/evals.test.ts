/** BASE-A8: كل حالات EV-1..EV-8 و RT-1..RT-6 تنجح في الوضع الحتمي — نفس ما يشغّله CI */
import test from "node:test";
import assert from "node:assert/strict";
import { runEvals } from "../evals/runner.ts";

test("all EV and RT cases pass (scripted model)", async () => {
  const r = await runEvals({ write: false });
  const failed = r.results.filter((x) => !x.pass).map((x) => `${x.case_id}: ${x.runs.map((y) => y.evidence).join(" | ")}`);
  assert.equal(r.results.length, 14);
  assert.deepEqual(failed, []);
});
