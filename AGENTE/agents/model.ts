/**
 * عميل النموذج (DEC-12 أ: نموذج سحابي قوي واحد، من الإعدادات — BASE-A4؛ لا اسم نموذج في الكود).
 *  - openai_compatible: أي مزوّد بواجهة chat/completions (OpenRouter وغيره) عبر fetch — بلا SDK ولا إطار (DEC-11 أ).
 *  - scripted: ردود مكتوبة مسبقاً للاختبارات والتقييم الحتمي.
 *  - demo: قاعدة بسيطة معلنة لتجربة الواجهة بلا مفتاح — ليست توقعاً حقيقياً، والواجهة تعرض تحذيراً دائماً.
 * المفتاح من متغير البيئة فقط (BASE-A7). فشل أو مهلة → إعادة واحدة ثم النموذج الاحتياطي إن ضُبط.
 */
import { type Config, modelApiKey } from "../config/config.ts";
import { AppError } from "../observability/errors.ts";

export interface ToolCall { id: string; name: string; arguments: string }

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface ModelReply { content: string | null; tool_calls: ToolCall[]; tokens_in: number; tokens_out: number; model: string }

export interface ModelClient {
  kind: "live" | "scripted" | "demo";
  modelId: string;
  call(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply>;
}

// ── مزوّد حقيقي ─────────────────────────────────────────────────────────────
function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant") {
    return {
      role: "assistant", content: m.content,
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) } : {}),
    };
  }
  if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  return { role: m.role, content: m.content };
}

export class OpenAICompatibleModel implements ModelClient {
  readonly kind = "live" as const;
  readonly modelId: string;
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
    this.modelId = cfg.model.model;
  }

  private async once(model: string, messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> {
    const key = modelApiKey(this.cfg);
    if (!key) throw new AppError("MODEL_ERROR", `missing env ${this.cfg.model.api_key_env}`, `مفتاح النموذج غير مضبوط على الخادم (متغير البيئة ${this.cfg.model.api_key_env}).`);
    const url = `${this.cfg.model.base_url.replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: messages.map(toWire),
          ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
          temperature: this.cfg.model.temperature,
          max_tokens: this.cfg.model.max_output_tokens,
        }),
        signal,
      });
    } catch (e) {
      throw new AppError("MODEL_ERROR", `network: ${(e as Error).name}`);
    }
    const body = await res.text();
    if (!res.ok) throw new AppError("MODEL_ERROR", `HTTP ${res.status}: ${body.slice(0, 300)}`);
    let j: any;
    try { j = JSON.parse(body); } catch { throw new AppError("MODEL_ERROR", "non-JSON response"); }
    const msg = j?.choices?.[0]?.message;
    if (!msg) throw new AppError("MODEL_ERROR", `no message: ${String(j?.error?.message || "").slice(0, 200)}`);
    const calls: ToolCall[] = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.filter((t: any) => t?.function?.name).map((t: any, i: number) => ({
        id: String(t.id || `call_${i}`), name: String(t.function.name), arguments: typeof t.function.arguments === "string" ? t.function.arguments : JSON.stringify(t.function.arguments ?? {}),
      }))
      : [];
    return {
      content: typeof msg.content === "string" ? msg.content : null,
      tool_calls: calls,
      tokens_in: Number(j?.usage?.prompt_tokens) || 0,
      tokens_out: Number(j?.usage?.completion_tokens) || 0,
      model: String(j?.model || model),
    };
  }

  async call(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> {
    if (!this.modelId) throw new AppError("CONFIG_INVALID", "model.model empty", "لم يُحدَّد النموذج في الإعدادات (model.model).");
    const retriable = (e: unknown) => e instanceof AppError && e.code === "MODEL_ERROR" && /network|HTTP (429|5\d\d)/.test(e.detail);
    try {
      return await this.once(this.modelId, messages, tools, signal);
    } catch (e1) {
      if (!retriable(e1) || signal.aborted) throw e1;
      try {
        return await this.once(this.modelId, messages, tools, signal);
      } catch (e2) {
        const fb = this.cfg.model.fallback_model;
        if (!fb || !retriable(e2) || signal.aborted) throw e2;
        return await this.once(fb, messages, tools, signal);
      }
    }
  }
}

// ── نموذج مكتوب (اختبارات وتقييم حتمي) ────────────────────────────────────────
export type ScriptStep =
  | { tool: string; args: unknown }
  | { tools: { tool: string; args: unknown }[] }
  | { text: string }
  | ((messages: ChatMessage[], tools: ToolSpec[]) => ScriptStep);

export class ScriptedModel implements ModelClient {
  readonly kind = "scripted" as const;
  readonly modelId: string;
  readonly calls: { messages: ChatMessage[]; tools: string[] }[] = [];
  private steps: ScriptStep[];
  constructor(steps: ScriptStep[], modelId = "scripted-test") {
    this.steps = [...steps];
    this.modelId = modelId;
  }
  async call(messages: ChatMessage[], tools: ToolSpec[]): Promise<ModelReply> {
    this.calls.push({ messages: structuredClone(messages), tools: tools.map((t) => t.name) });
    let step = this.steps.shift() ?? { text: "انتهيت." };
    while (typeof step === "function") step = step(messages, tools);
    const n = this.calls.length;
    const mk = (s: { tool: string; args: unknown }, i: number): ToolCall => ({ id: `s${n}_${i}`, name: s.tool, arguments: typeof s.args === "string" ? s.args : JSON.stringify(s.args) });
    const tool_calls = "tools" in step ? step.tools.map(mk) : "tool" in step ? [mk(step, 0)] : [];
    return { content: "text" in step ? step.text : null, tool_calls, tokens_in: 100, tokens_out: 50, model: this.modelId };
  }
}

// ── نموذج تجريبي بقاعدة معلنة ────────────────────────────────────────────────
type DemoCase = { case_ref: string; gestation_week: number; indicators: Record<string, number | string | null> };

function lastToolResult(messages: ChatMessage[], name: string): any | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.name === name) {
      try { return JSON.parse(m.content); } catch { return null; }
    }
  }
  return null;
}

const truthy = (v: unknown) => v === 1 || v === "نعم" || v === "yes" || v === "true";

export class DemoModel implements ModelClient {
  readonly kind = "demo" as const;
  readonly modelId = "demo-rules-v1";
  private n = 0;
  async call(messages: ChatMessage[], tools: ToolSpec[]): Promise<ModelReply> {
    const names = tools.map((t) => t.name);
    const reply = (calls: { name: string; args: unknown }[], text: string | null = null): ModelReply => ({
      content: text, tool_calls: calls.map((c, i) => ({ id: `demo${++this.n}_${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
      tokens_in: 0, tokens_out: 0, model: this.modelId,
    });
    if (names.includes("submit_prediction")) {
      const read = lastToolResult(messages, "read_pregnancy_cases");
      if (!read) {
        const user = [...messages].reverse().find((m) => m.role === "user");
        const asOf = /as_of["\s:=]+"?(\d{4}-\d{2}-\d{2})/.exec(user && "content" in user ? String(user.content) : "")?.[1] || "";
        const win = Number(/window_days["\s:=]+(\d+)/.exec(user && "content" in user ? String(user.content) : "")?.[1] || 7);
        return reply([{ name: "read_pregnancy_cases", args: { as_of: asOf, window_days: win } }]);
      }
      const done = lastToolResult(messages, "submit_prediction");
      if (done) return reply([], done.error ? "تعذّر تسجيل التوقع." : "سُجّل التوقع.");
      if (read.error) return reply([], "تعذّرت قراءة الحالات.");
      const cases: DemoCase[] = read.cases || [];
      const order = ["low", "medium", "high"] as const;
      const per_infant: unknown[] = [];
      let anyMissing = false;
      for (const c of cases) {
        if (Object.values(c.indicators).some((v) => v === null)) anyMissing = true;
        let level = c.gestation_week < 32 ? 2 : c.gestation_week < 35 ? 1 : 0;
        if (truthy(c.indicators.preeclampsia)) level = Math.min(2, level + 1);
        if (Number(c.indicators.previous_preterm) >= 1 && level === 0) level = 1;
        const infants = Math.max(1, Number(c.indicators.expected_infants) || 1);
        for (let i = 1; i <= infants; i++) {
          per_infant.push({
            infant_ref: `${c.case_ref}#${i}`, apgar_value_estimate: [8, 6, 3][level], apgar_class: order[level],
            basis_ref: `أسبوع الحمل ${c.gestation_week}${truthy(c.indicators.preeclampsia) ? "، تسمم حمل" : ""}${Number(c.indicators.previous_preterm) >= 1 ? "، خداج سابق" : ""}`,
          });
        }
      }
      const risk = order[Math.max(0, ...per_infant.map((p: any) => order.indexOf(p.apgar_class)))];
      return reply([{
        name: "submit_prediction",
        args: {
          count_value: per_infant.length, risk_class: risk, per_infant,
          basis: {
            sources: ["TL-1"],
            weighting_note: "وضع تجريبي بلا نموذج: قاعدة ثابتة على أسبوع الحمل وتسمم الحمل والخداج السابق — ليست توقعاً طبياً ولا تُستخدم للقرار.",
            confidence_flag: anyMissing ? "low" : "normal",
          },
        },
      }]);
    }
    if (names.includes("create_preparation_draft")) {
      const p = lastToolResult(messages, "get_approved_prediction");
      if (!p) return reply([{ name: "get_approved_prediction", args: {} }]);
      if (p.error) return reply([], "لا توقع معتمد.");
      const infants: { infant_ref: string; apgar_class: string }[] = p.per_infant || [];
      const high = infants.filter((x) => x.apgar_class === "high");
      const medium = infants.filter((x) => x.apgar_class === "medium");
      if (!lastToolResult(messages, "create_preparation_draft")) {
        const items = [{ item: "حاضنة جاهزة", qty: infants.length }];
        if (medium.length + high.length) items.push({ item: "جهاز مراقبة حيوية", qty: medium.length + high.length });
        if (high.length) items.push({ item: "سرير عناية مركزة لحديثي الولادة", qty: high.length });
        return reply([{ name: "create_preparation_draft", args: { items } }]);
      }
      if (high.length && !lastToolResult(messages, "create_action_draft")) {
        return reply([{
          name: "create_action_draft",
          args: {
            kind: "تجهيز",
            payload: { summary: `تجهيز ${high.length} سرير عناية مركزة قبل الولادة`, infant_refs: high.map((x) => x.infant_ref), justification: "أطفال متوقعون بفئة high حسب التوقع المعتمد" },
            alternatives: ["إبلاغ فريق العناية المركزة دون حجز مسبق"],
          },
        }]);
      }
      return reply([], "جُهّزت المسودات.");
    }
    return reply([], "لا شيء.");
  }
}

export function buildModel(cfg: Config): ModelClient {
  return cfg.model.provider === "demo" ? new DemoModel() : new OpenAICompatibleModel(cfg);
}
