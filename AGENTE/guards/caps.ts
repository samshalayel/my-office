/**
 * BASE-A2 / MIT-7 / HR-4 — سقوف الدورة: عدد استدعاءات النموذج، خطوات الحلقة، مهلة الدورة.
 * التجاوز = توقف آمن (AppError CAP_EXCEEDED/TIMEOUT) يصعد للإنسان — لا توقع جزئي.
 */
import type { Config } from "../config/config.ts";
import { AppError } from "../observability/errors.ts";

export class Budget {
  readonly maxModelCalls: number;
  readonly maxSteps: number;
  readonly deadline: number;
  modelCalls = 0;
  steps = 0;
  constructor(cfg: Config, startedAt = Date.now()) {
    this.maxModelCalls = cfg.caps.max_model_calls_per_cycle;
    this.maxSteps = cfg.caps.max_tool_steps;
    this.deadline = startedAt + cfg.caps.cycle_timeout_s * 1000;
  }
  assertTime(): void {
    if (Date.now() > this.deadline) throw new AppError("TIMEOUT", "cycle_timeout_s");
  }
  modelCall(): void {
    this.assertTime();
    if (this.modelCalls >= this.maxModelCalls) throw new AppError("CAP_EXCEEDED", `max_model_calls_per_cycle=${this.maxModelCalls}`);
    this.modelCalls++;
  }
  step(): void {
    this.assertTime();
    if (this.steps >= this.maxSteps) throw new AppError("CAP_EXCEEDED", `max_tool_steps=${this.maxSteps}`);
    this.steps++;
  }
  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }
}

/** مهلة لأي عملية (أداة/نموذج): أقصر من مهلتها ومن الباقي في الدورة */
export async function withTimeout<T>(ms: number, what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new AppError("TIMEOUT", what)); }, Math.max(1, ms));
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
