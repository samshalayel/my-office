/**
 * عميل النموذج على LangChain (DEV-15: LangGraph بدل «بلا إطار» — قرار صاحب المشروع 2026-11-20).
 * نموذج واحد من الإعدادات (DEC-12 أ / BASE-A4؛ لا اسم نموذج في الكود)، وثلاثة أنواع بالواجهة نفسها (Runnable من LangChain):
 *  - live: ChatOpenAI على أي مزوّد بواجهة chat/completions (OpenRouter وغيره) — إعادة واحدة ثم النموذج الاحتياطي (withFallbacks)
 *  - scripted: BaseChatModel بردود مكتوبة مسبقاً للاختبارات والتقييم الحتمي
 *  - demo: BaseChatModel بقاعدة معلنة لتجربة الواجهة بلا مفتاح — ليست توقعاً حقيقياً، والواجهة تعرض تحذيراً دائماً
 * المفتاح من متغير البيئة فقط (BASE-A7). تتبّع LangSmith مقفل قسراً: لا شيء يخرج لخدمة خارجية غير مزوّد النموذج (HR-5).
 */
import { BaseChatModel, type BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { ChatOpenAI } from "@langchain/openai";
import { type Config, modelApiKey } from "../config/config.ts";
import { AppError } from "../observability/errors.ts";

for (const k of ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"]) process.env[k] = "false";

export interface ToolCall { id: string; name: string; arguments: string }

/** شكل مبسّط للرسائل — للتتبّع وفحص المعرفات والنماذج المحلية */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface ModelReply { content: string | null; tool_calls: ToolCall[]; tokens_in: number; tokens_out: number; model: string }

/** نموذج مربوط بأدوات المرحلة — ما يستدعيه عقدة agent في الجراف */
export interface BoundModel { invoke(messages: BaseMessage[], options: { signal: AbortSignal }): Promise<BaseMessage> }

export interface ModelClient {
  kind: "live" | "scripted" | "demo";
  modelId: string;
  withTools(tools: ToolSpec[]): BoundModel;
}

const text = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c)
  ? c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("") : "";

/** رسالة LangChain → الشكل المبسّط */
export function toPlain(m: BaseMessage): ChatMessage {
  const t = m.getType();
  if (t === "system") return { role: "system", content: text(m.content) };
  if (t === "human") return { role: "user", content: text(m.content) };
  if (t === "tool") {
    const tm = m as BaseMessage & { tool_call_id: string };
    return { role: "tool", tool_call_id: tm.tool_call_id, name: String(m.name ?? ""), content: text(m.content) };
  }
  const ai = m as AIMessage;
  const calls: ToolCall[] = [
    ...(ai.tool_calls ?? []).map((c, i) => ({ id: String(c.id ?? `call_${i}`), name: c.name, arguments: JSON.stringify(c.args ?? {}) })),
    ...(ai.invalid_tool_calls ?? []).map((c, i) => ({ id: String(c.id ?? `bad_${i}`), name: String(c.name ?? ""), arguments: String(c.args ?? "") })),
  ];
  const content = text(ai.content);
  return { role: "assistant", content: content === "" && calls.length ? null : content, ...(calls.length ? { tool_calls: calls } : {}) };
}

// ── مزوّد حقيقي ─────────────────────────────────────────────────────────────
export class OpenAICompatibleModel implements ModelClient {
  readonly kind = "live" as const;
  readonly modelId: string;
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
    this.modelId = cfg.model.model;
  }

  withTools(tools: ToolSpec[]): BoundModel {
    const cfg = this.cfg;
    if (!this.modelId) throw new AppError("CONFIG_INVALID", "model.model empty", "لم يُحدَّد النموذج في الإعدادات (model.model).");
    const key = modelApiKey(cfg);
    if (!key) throw new AppError("MODEL_ERROR", `missing env ${cfg.model.api_key_env}`, `مفتاح النموذج غير مضبوط على الخادم (متغير البيئة ${cfg.model.api_key_env}).`);
    const make = (model: string) => new ChatOpenAI({
      model, apiKey: key, configuration: { baseURL: cfg.model.base_url.replace(/\/+$/, "") },
      temperature: cfg.model.temperature, maxTokens: cfg.model.max_output_tokens, maxRetries: 1,
    }).bindTools(tools.map((t) => ({ type: "function" as const, function: t })));
    const primary = make(this.modelId);
    const runnable = cfg.model.fallback_model ? primary.withFallbacks([make(cfg.model.fallback_model)]) : primary;
    return {
      async invoke(messages, options) {
        try {
          return await runnable.invoke(messages, options);
        } catch (e) {
          if (e instanceof AppError) throw e;
          const err = e as { status?: number; name?: string; message?: string };
          throw new AppError("MODEL_ERROR", `${err.status ? `HTTP ${err.status}` : err.name || "error"}: ${String(err.message || "").slice(0, 300)}`);
        }
      },
    };
  }
}

// ── نماذج محلية (BaseChatModel من LangChain) ─────────────────────────────────
type LocalOptions = BaseChatModelCallOptions & { agentTools?: ToolSpec[] };

abstract class LocalChatModel extends BaseChatModel<LocalOptions> implements ModelClient {
  abstract readonly kind: "scripted" | "demo";
  abstract readonly modelId: string;
  constructor() { super({}); }
  _llmType(): string { return `agente-${this.kind}`; }
  protected abstract respond(messages: ChatMessage[], tools: ToolSpec[]): ModelReply;

  withTools(tools: ToolSpec[]): BoundModel {
    return this.withConfig({ agentTools: tools } as Partial<LocalOptions>) as unknown as BoundModel;
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    const r = this.respond(messages.map(toPlain), options.agentTools ?? []);
    const valid: { id: string; name: string; args: Record<string, unknown>; type: "tool_call" }[] = [];
    const invalid: { id: string; name: string; args: string; error: string; type: "invalid_tool_call" }[] = [];
    for (const c of r.tool_calls) {
      let args: unknown;
      try { args = JSON.parse(c.arguments || "{}"); } catch { args = undefined; }
      if (args && typeof args === "object" && !Array.isArray(args)) valid.push({ id: c.id, name: c.name, args: args as Record<string, unknown>, type: "tool_call" });
      else invalid.push({ id: c.id, name: c.name, args: c.arguments, error: "not a JSON object", type: "invalid_tool_call" });
    }
    const message = new AIMessage({
      content: r.content ?? "", tool_calls: valid, invalid_tool_calls: invalid,
      usage_metadata: { input_tokens: r.tokens_in, output_tokens: r.tokens_out, total_tokens: r.tokens_in + r.tokens_out },
      response_metadata: { model_name: r.model },
    });
    return { generations: [{ text: r.content ?? "", message }] };
  }
}

// ── نموذج مكتوب (اختبارات وتقييم حتمي) ────────────────────────────────────────
export type ScriptStep =
  | { tool: string; args: unknown }
  | { tools: { tool: string; args: unknown }[] }
  | { text: string }
  | ((messages: ChatMessage[], tools: ToolSpec[]) => ScriptStep);

export class ScriptedModel extends LocalChatModel {
  readonly kind = "scripted" as const;
  readonly modelId: string;
  readonly calls: { messages: ChatMessage[]; tools: string[] }[] = [];
  private steps: ScriptStep[];
  constructor(steps: ScriptStep[], modelId = "scripted-test") {
    super();
    this.steps = [...steps];
    this.modelId = modelId;
  }
  protected respond(messages: ChatMessage[], tools: ToolSpec[]): ModelReply {
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

export class DemoModel extends LocalChatModel {
  readonly kind = "demo" as const;
  readonly modelId = "demo-rules-v1";
  private n = 0;
  protected respond(messages: ChatMessage[], tools: ToolSpec[]): ModelReply {
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
