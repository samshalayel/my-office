/**
 * BASE-A8 — مشغّل التقييم (EV-1..EV-8 و RT-1..RT-6). يشغّل كل حالة runs_per_case مرة، يكتب تقريراً في evals/reports/،
 * ويخرج بخطأ عند أي فشل (يوقف النشر). في وضع --live: الحالات المعتمدة على النموذج تُشغَّل بالنموذج الحي،
 * والنجاح الكامل يكتب data/eval_baseline.json (MIT-8) — بدونه لا يعمل الوكيل بنموذج حي.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolvePath, projectRoot } from "../config/config.ts";
import { OpenAICompatibleModel } from "../agents/model.ts";
import { loadPrompt } from "../agents/prompts.ts";
import { newRunId } from "../observability/trace.ts";
import { asAppError } from "../observability/errors.ts";
import { CHECKS, MODEL_DEPENDENT, type CheckResult } from "./checks.ts";

interface EvalCase { case_id: string; input: string; expected_behavior: string; pass_criteria: string; runs_per_case: number; tags: string[] }

export function loadCases(root = path.resolve(import.meta.dirname, "..")): EvalCase[] {
  const out: EvalCase[] = [];
  for (const dir of ["evals/cases", "redteam/cases"]) {
    const d = path.join(root, dir);
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".json")).sort()) out.push(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
  }
  return out;
}

export interface EvalReport { run_id: string; at: string; live: boolean; model: string; prompt_version: string; passed: boolean; results: { case_id: string; runs: CheckResult[]; pass: boolean }[] }

export async function runEvals(opts: { live?: boolean; runs?: number; only?: string[]; write?: boolean } = {}): Promise<EvalReport> {
  const cfg = loadConfig();
  const live = Boolean(opts.live);
  const prompt = loadPrompt(cfg, "AGT-1");
  const baseRoot = projectRoot();
  const env = { live, baseRoot, liveModel: live ? () => new OpenAICompatibleModel(cfg) : undefined };
  const results: EvalReport["results"] = [];
  for (const c of loadCases()) {
    if (opts.only?.length && !opts.only.includes(c.case_id)) continue;
    const check = CHECKS[c.case_id];
    const runs: CheckResult[] = [];
    const n = opts.runs ?? (live && MODEL_DEPENDENT.has(c.case_id) ? c.runs_per_case : 1);
    for (let i = 0; i < n; i++) {
      try { runs.push(check ? await check({ ...env, live: live && MODEL_DEPENDENT.has(c.case_id) }) : { pass: false, evidence: "لا فحص لهذه الحالة" }); }
      catch (e) { runs.push({ pass: false, evidence: `خطأ: ${asAppError(e).code} ${asAppError(e).detail}`.slice(0, 300) }); }
    }
    results.push({ case_id: c.case_id, runs, pass: runs.length > 0 && runs.every((r) => r.pass) });
  }
  const report: EvalReport = {
    run_id: newRunId("e"), at: new Date().toISOString(), live, model: live ? cfg.model.model : "scripted",
    prompt_version: prompt.version, passed: results.every((r) => r.pass), results,
  };
  if (opts.write !== false) {
    const dir = resolvePath(cfg, cfg.paths.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${report.run_id}.json`), JSON.stringify(report, null, 2));
    const md = [`# تقرير التقييم ${report.run_id}`, "", `- الوضع: ${live ? `حي (${cfg.model.model})` : "حتمي (نموذج مكتوب)"} · التعليمات: ${report.prompt_version} · ${report.at}`,
      `- النتيجة: ${report.passed ? "✅ كل الحالات نجحت" : "❌ يوجد فشل — النشر متوقف"}`, "", "| الحالة | النتيجة | التشغيلات | الدليل |", "|---|---|---|---|",
      ...results.map((r) => `| ${r.case_id} | ${r.pass ? "✅" : "❌"} | ${r.runs.filter((x) => x.pass).length}/${r.runs.length} | ${(r.runs.find((x) => !x.pass) ?? r.runs[0])?.evidence.replace(/\|/g, "/") ?? ""} |`)].join("\n");
    fs.writeFileSync(path.join(dir, `${report.run_id}.md`), md + "\n");
    if (live && report.passed && !opts.only?.length) {
      const b = resolvePath(cfg, cfg.paths.eval_baseline);
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.writeFileSync(b, JSON.stringify({ passed: true, model: cfg.model.model, fallback_model: cfg.model.fallback_model, prompt_version: prompt.version, at: report.at, run_id: report.run_id, node: process.version }, null, 2));
    }
  }
  return report;
}
