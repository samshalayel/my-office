/**
 * غلاف موحد لكل أداة (قواعد كود S4 #1 و #4 و #7):
 *  - الصلاحية تُفرض هنا على الخادم (من يطلب: AGT-1 أم إنسان) — لا من تعليمات النموذج (MIT-3 / LLM06)
 *  - مفتاح الإيقاف يُقرأ عند كل استدعاء (BASE-A3)
 *  - مهلة لكل أداة (C-11 tool_timeout_s)
 *  - سطر تتبع لكل استدعاء بنتيجته (BASE-A1)
 */
import type { AppContext } from "../agents/context.ts";
import { AppError, asAppError } from "../observability/errors.ts";
import { assertEnabled, type ControlledTool } from "../guards/killswitch.ts";
import { withTimeout } from "../guards/caps.ts";
import { digest } from "../observability/trace.ts";

export type Actor = "AGT-1" | "human" | "system";

export interface ToolCtx {
  app: AppContext;
  run_id: string;
  actor: Actor;
  /** اسم المستخدم للإنسان (من الجلسة لا من النموذج) */
  actorName: string;
}

export function actorLabel(ctx: ToolCtx): string {
  return ctx.actor === "human" ? `human:${ctx.actorName}` : ctx.actor;
}

export interface ToolDef<I, O> {
  tool: ControlledTool;
  op: string;
  actors: Actor[];
  run: (ctx: ToolCtx, input: I) => O | Promise<O>;
}

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

export async function invoke<I, O>(def: ToolDef<I, O>, ctx: ToolCtx, input: I): Promise<O> {
  const t0 = Date.now();
  const base = { run_id: ctx.run_id, component: def.tool as "TL-1", input_digest: digest(input) };
  try {
    if (!def.actors.includes(ctx.actor)) throw new AppError("FORBIDDEN_TOOL", `${def.tool}.${def.op} by ${ctx.actor}`);
    assertEnabled(ctx.app.cfg, def.tool);
    const out = await withTimeout(ctx.app.cfg.caps.tool_timeout_s * 1000, `${def.tool}.${def.op}`, async () => def.run(ctx, input));
    ctx.app.tracer.write({ ...base, output_digest: digest(out), ms: Date.now() - t0, outcome: `${def.op}:ok` });
    return out;
  } catch (e) {
    const err = asAppError(e);
    ctx.app.tracer.write({ ...base, output_digest: digest(err.code), ms: Date.now() - t0, outcome: `${def.op}:${err.code}` });
    throw err;
  }
}
