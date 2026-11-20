/** بيئة معزولة للتقييم والاختبار: جذر مؤقت بإعدادات المشروع وتعليماته وبيانات اصطناعية — لا تلمس data/ الحقيقية */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, projectRoot } from "../config/config.ts";
import { createContext, type AppContext } from "../agents/context.ts";
import type { ModelClient } from "../agents/model.ts";

export const AS_OF = "2026-11-20";
const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");

export function sampleRecords(): Record<string, unknown>[] {
  return JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "samples", "pregnancies.sample.json"), "utf8")).records;
}

export function tempHome(records?: unknown[], baseRoot = projectRoot()): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agente-"));
  fs.mkdirSync(path.join(home, "config"));
  fs.copyFileSync(path.join(baseRoot, "config", "settings.json"), path.join(home, "config", "settings.json"));
  const local = path.join(baseRoot, "config", "settings.local.json");
  if (fs.existsSync(local)) fs.copyFileSync(local, path.join(home, "config", "settings.local.json"));
  fs.cpSync(path.join(baseRoot, "prompts"), path.join(home, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(home, "data", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "inbox", "pregnancies.json"), JSON.stringify({ records: records ?? sampleRecords() }));
  return home;
}

/** تطبيق معزول. الإعدادات: settings.json (+ settings.local.json للتقييم الحي) + overrides، والجدولة متوقفة */
export function makeApp(opts: { records?: unknown[]; model?: ModelClient; overrides?: Record<string, unknown>; baseRoot?: string } = {}): AppContext {
  const base = opts.baseRoot ?? projectRoot();
  const home = tempHome(opts.records, base);
  const prev = process.env.AGENTE_HOME;
  process.env.AGENTE_HOME = home;
  try {
    const cfg = loadConfig({ schedule: { enabled: false }, alerts: { webhook_url: "" }, ...(opts.overrides || {}) });
    return createContext({ cfg, model: opts.model });
  } finally {
    if (prev === undefined) delete process.env.AGENTE_HOME; else process.env.AGENTE_HOME = prev;
  }
}
