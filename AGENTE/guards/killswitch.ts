/**
 * BASE-A3 / MIT-7 — مفتاح الإيقاف اليدوي الدائم.
 * الحالة في ملف data/controls.json (يُقرأ عند كل استدعاء أداة ونموذج — يعمل فوراً بلا نشر جديد)،
 * فوق القيمة الافتراضية في الإعدادات. التغيير من الواجهة يُكتب بشكل ذري ويُسجَّل في التدقيق.
 */
import fs from "node:fs";
import path from "node:path";
import { type Config, resolvePath } from "../config/config.ts";
import { AppError } from "../observability/errors.ts";
import { type Db, tx, writeAudit, nowIso } from "../storage/db.ts";

export const TOOL_NAMES = ["TL-1", "TL-2", "TL-3", "TL-4", "model"] as const;
export type ControlledTool = typeof TOOL_NAMES[number];

export interface Controls {
  enabled: boolean;              // true = كل شيء متوقف
  disabled_tools: string[];
  updated_at: string | null;
  updated_by: string | null;
}

export function readControls(cfg: Config): Controls {
  const file = resolvePath(cfg, cfg.paths.controls);
  let fileState: Partial<Controls> = {};
  try {
    if (fs.existsSync(file)) fileState = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // ملف تالف = أمان: نعدّه إيقافاً كاملاً بدل تجاهله
    return { enabled: true, disabled_tools: [], updated_at: null, updated_by: "ملف التحكم تالف" };
  }
  return {
    enabled: Boolean(fileState.enabled ?? cfg.kill_switch.enabled),
    disabled_tools: Array.isArray(fileState.disabled_tools) ? fileState.disabled_tools.map(String) : [...cfg.kill_switch.disabled_tools],
    updated_at: fileState.updated_at ?? null,
    updated_by: fileState.updated_by ?? null,
  };
}

export function assertEnabled(cfg: Config, tool: ControlledTool): void {
  const c = readControls(cfg);
  if (c.enabled) throw new AppError("KILL_SWITCH", `global (${c.updated_by || "settings"})`);
  if (c.disabled_tools.includes(tool)) throw new AppError("KILL_SWITCH", tool, `الأداة ${tool} موقوفة بمفتاح الإيقاف.`);
}

export function setControls(cfg: Config, db: Db, next: { enabled: boolean; disabled_tools: string[] }, actor: string, reason: string): Controls {
  const file = resolvePath(cfg, cfg.paths.controls);
  const before = readControls(cfg);
  const tools = next.disabled_tools.filter((t) => (TOOL_NAMES as readonly string[]).includes(t));
  const state: Controls = { enabled: next.enabled, disabled_tools: tools, updated_at: nowIso(), updated_by: actor };
  tx(db, () => {
    writeAudit(db, { actor, entity: "control", ref: "kill_switch", action: "set", before, after: state, reason });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  });
  return state;
}
