"""عميل النموذج على LangChain (DEV-15/DEV-16).
نموذج واحد من الإعدادات (DEC-12 أ / BASE-A4؛ لا اسم نموذج في الكود)، وثلاثة أنواع بالواجهة نفسها (Runnable من LangChain):
 - live: ChatOpenAI على أي مزوّد بواجهة chat/completions (OpenRouter وغيره) — إعادة واحدة ثم النموذج الاحتياطي (with_fallbacks)
 - scripted: BaseChatModel بردود مكتوبة مسبقاً للاختبارات والتقييم الحتمي
 - demo: BaseChatModel بقاعدة معلنة لتجربة الواجهة بلا مفتاح — ليست توقعاً حقيقياً، والواجهة تعرض تحذيراً دائماً
المفتاح من متغير البيئة فقط (BASE-A7). تتبّع LangSmith مقفل قسراً: لا شيء يخرج لخدمة خارجية غير مزوّد النموذج (HR-5).
"""
from __future__ import annotations

import copy
import json
import os
import re
from typing import Any, Callable, ClassVar, Union

for _k in ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING", "LANGSMITH_TRACING_V2"):
    os.environ[_k] = "false"

from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage, BaseMessage  # noqa: E402
from langchain_core.outputs import ChatGeneration, ChatResult  # noqa: E402
from pydantic import PrivateAttr  # noqa: E402

from ..config.config import Config, model_api_key  # noqa: E402
from ..jsutil import jdump, js_number  # noqa: E402
from ..observability.errors import AppError  # noqa: E402

ToolSpec = dict[str, Any]  # {name, description, parameters}
ChatMessage = dict[str, Any]  # الشكل المبسّط: {role, content, tool_calls?, tool_call_id?, name?}


def _text(c: Any) -> str:
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(p if isinstance(p, str) else p.get("text", "") if isinstance(p, dict) and isinstance(p.get("text"), str) else "" for p in c)
    return ""


def to_plain(m: BaseMessage) -> ChatMessage:
    """رسالة LangChain → الشكل المبسّط (للتتبّع وفحص المعرفات والنماذج المحلية)"""
    t = m.type
    if t == "system":
        return {"role": "system", "content": _text(m.content)}
    if t == "human":
        return {"role": "user", "content": _text(m.content)}
    if t == "tool":
        return {"role": "tool", "tool_call_id": m.tool_call_id, "name": str(m.name or ""), "content": _text(m.content)}
    calls = []
    for i, c in enumerate(getattr(m, "tool_calls", None) or []):
        calls.append({"id": str(c.get("id") or f"call_{i}"), "name": c["name"], "arguments": jdump(c.get("args") if c.get("args") is not None else {})})
    for i, c in enumerate(getattr(m, "invalid_tool_calls", None) or []):
        calls.append({"id": str(c.get("id") or f"bad_{i}"), "name": str(c.get("name") or ""), "arguments": str(c.get("args") or "")})
    content = _text(m.content)
    out: ChatMessage = {"role": "assistant", "content": None if content == "" and calls else content}
    if calls:
        out["tool_calls"] = calls
    return out


# ── مزوّد حقيقي ─────────────────────────────────────────────────────────────
class _LiveBound:
    def __init__(self, runnable: Any):
        self._r = runnable

    async def ainvoke(self, messages: list[BaseMessage]) -> BaseMessage:
        try:
            return await self._r.ainvoke(messages)
        except AppError:
            raise
        except Exception as e:  # أخطاء المزوّد/الشبكة → MODEL_ERROR موحد
            status = getattr(e, "status_code", None)
            head = f"HTTP {status}" if status else type(e).__name__
            raise AppError("MODEL_ERROR", f"{head}: {str(e)[:300]}") from e


class OpenAICompatibleModel:
    kind = "live"

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.model_id: str = cfg["model"]["model"]

    def with_tools(self, tools: list[ToolSpec]) -> _LiveBound:
        from langchain_openai import ChatOpenAI

        cfg = self.cfg
        if not self.model_id:
            raise AppError("CONFIG_INVALID", "model.model empty", "لم يُحدَّد النموذج في الإعدادات (model.model).")
        key = model_api_key(cfg)
        if not key:
            raise AppError("MODEL_ERROR", f"missing env {cfg['model']['api_key_env']}",
                           f"مفتاح النموذج غير مضبوط على الخادم (متغير البيئة {cfg['model']['api_key_env']}).")

        def make(model: str) -> Any:
            return ChatOpenAI(
                model=model, api_key=key, base_url=re.sub(r"/+$", "", cfg["model"]["base_url"]) or None,
                temperature=cfg["model"]["temperature"], max_completion_tokens=cfg["model"]["max_output_tokens"],
                max_retries=1, timeout=cfg["caps"]["model_timeout_s"], use_responses_api=False,
            ).bind_tools([{"type": "function", "function": t} for t in tools])

        primary = make(self.model_id)
        fb = cfg["model"]["fallback_model"]
        return _LiveBound(primary.with_fallbacks([make(fb)]) if fb else primary)


# ── نماذج محلية (BaseChatModel من LangChain) ─────────────────────────────────
class _LocalBound:
    def __init__(self, model: "LocalChatModel", tools: list[ToolSpec]):
        self._r = model.bind(agent_tools=tools)

    async def ainvoke(self, messages: list[BaseMessage]) -> BaseMessage:
        return await self._r.ainvoke(messages)


class LocalChatModel(BaseChatModel):
    kind: ClassVar[str] = "local"

    @property
    def _llm_type(self) -> str:
        return f"agente-{self.kind}"

    def respond(self, messages: list[ChatMessage], tools: list[ToolSpec]) -> dict[str, Any]:  # pragma: no cover
        raise NotImplementedError

    def with_tools(self, tools: list[ToolSpec]) -> _LocalBound:
        return _LocalBound(self, tools)

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        r = self.respond([to_plain(m) for m in messages], kwargs.get("agent_tools") or [])
        valid, invalid = [], []
        for c in r["tool_calls"]:
            try:
                args = json.loads(c["arguments"] or "{}")
            except (ValueError, TypeError):
                args = None
            if isinstance(args, dict):
                valid.append({"id": c["id"], "name": c["name"], "args": args, "type": "tool_call"})
            else:
                invalid.append({"id": c["id"], "name": c["name"], "args": c["arguments"], "error": "not a JSON object", "type": "invalid_tool_call"})
        message = AIMessage(
            content=r["content"] or "", tool_calls=valid, invalid_tool_calls=invalid,
            usage_metadata={"input_tokens": r["tokens_in"], "output_tokens": r["tokens_out"], "total_tokens": r["tokens_in"] + r["tokens_out"]},
            response_metadata={"model_name": r["model"]},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _agenerate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        return self._generate(messages, stop=stop, **kwargs)


# ── نموذج مكتوب (اختبارات وتقييم حتمي) ────────────────────────────────────────
# خطوة: {"tool": name, "args": ...} | {"tools": [{"tool", "args"}, ...]} | {"text": str} | دالة (messages, tools) → خطوة
ScriptStep = Union[dict[str, Any], Callable[[list[ChatMessage], list[ToolSpec]], Any]]


class ScriptedModel(LocalChatModel):
    kind: ClassVar[str] = "scripted"
    model_id: str = "scripted-test"
    _steps: list[Any] = PrivateAttr(default_factory=list)
    _calls: list[dict[str, Any]] = PrivateAttr(default_factory=list)

    def __init__(self, steps: list[ScriptStep], model_id: str = "scripted-test", **kw: Any):
        super().__init__(model_id=model_id, **kw)
        self._steps = list(steps)
        self._calls = []

    @property
    def calls(self) -> list[dict[str, Any]]:
        """كل استدعاء: {messages (الشكل المبسّط), tools (الأسماء)}"""
        return self._calls

    def respond(self, messages: list[ChatMessage], tools: list[ToolSpec]) -> dict[str, Any]:
        self._calls.append({"messages": copy.deepcopy(messages), "tools": [t["name"] for t in tools]})
        step = self._steps.pop(0) if self._steps else {"text": "انتهيت."}
        while callable(step):
            step = step(messages, tools)
        n = len(self._calls)

        def mk(s: dict[str, Any], i: int) -> dict[str, Any]:
            a = s.get("args", _UNDEF)
            arguments = a if isinstance(a, str) else ("{}" if a is _UNDEF else jdump(a))
            return {"id": f"s{n}_{i}", "name": s["tool"], "arguments": arguments}

        if "tools" in step:
            tool_calls = [mk(s, i) for i, s in enumerate(step["tools"])]
        elif "tool" in step:
            tool_calls = [mk(step, 0)]
        else:
            tool_calls = []
        return {"content": step.get("text"), "tool_calls": tool_calls, "tokens_in": 100, "tokens_out": 50, "model": self.model_id}


_UNDEF = object()


# ── نموذج تجريبي بقاعدة معلنة ────────────────────────────────────────────────
def _last_tool_result(messages: list[ChatMessage], name: str) -> Any:
    for m in reversed(messages):
        if m["role"] == "tool" and m.get("name") == name:
            try:
                return json.loads(m["content"])
            except ValueError:
                return None
    return None


def _truthy(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    return (isinstance(v, (int, float)) and v == 1) or v in ("نعم", "yes", "true")


class DemoModel(LocalChatModel):
    kind: ClassVar[str] = "demo"
    model_id: str = "demo-rules-v1"
    _n: int = PrivateAttr(default=0)

    def respond(self, messages: list[ChatMessage], tools: list[ToolSpec]) -> dict[str, Any]:
        names = [t["name"] for t in tools]

        def reply(calls: list[dict[str, Any]], text: str | None = None) -> dict[str, Any]:
            out = []
            for i, c in enumerate(calls):
                self._n += 1
                out.append({"id": f"demo{self._n}_{i}", "name": c["name"], "arguments": jdump(c["args"])})
            return {"content": text, "tool_calls": out, "tokens_in": 0, "tokens_out": 0, "model": self.model_id}

        if "submit_prediction" in names:
            read = _last_tool_result(messages, "read_pregnancy_cases")
            if read is None:
                user = next((m for m in reversed(messages) if m["role"] == "user"), None)
                content = str(user["content"]) if user else ""
                m1 = re.search(r'as_of["\s:=]+"?([0-9]{4}-[0-9]{2}-[0-9]{2})', content)
                m2 = re.search(r'window_days["\s:=]+([0-9]+)', content)
                as_of = m1.group(1) if m1 else ""
                win = int(m2.group(1)) if m2 else 7
                return reply([{"name": "read_pregnancy_cases", "args": {"as_of": as_of, "window_days": win}}])
            done = _last_tool_result(messages, "submit_prediction")
            if done is not None:
                return reply([], "تعذّر تسجيل التوقع." if done.get("error") else "سُجّل التوقع.")
            if read.get("error"):
                return reply([], "تعذّرت قراءة الحالات.")
            cases = read.get("cases") or []
            order = ["low", "medium", "high"]
            per_infant: list[dict[str, Any]] = []
            any_missing = False
            for c in cases:
                ind = c["indicators"]
                if any(v is None for v in ind.values()):
                    any_missing = True
                gw = c["gestation_week"]
                level = 2 if gw < 32 else 1 if gw < 35 else 0
                if _truthy(ind.get("preeclampsia")):
                    level = min(2, level + 1)
                if js_number(ind.get("previous_preterm")) >= 1 and level == 0:
                    level = 1
                n_inf = js_number(ind.get("expected_infants"))
                infants = int(max(1, n_inf if n_inf == n_inf and n_inf else 1))
                for i in range(1, infants + 1):
                    basis_ref = f"أسبوع الحمل {gw}"
                    if _truthy(ind.get("preeclampsia")):
                        basis_ref += "، تسمم حمل"
                    if js_number(ind.get("previous_preterm")) >= 1:
                        basis_ref += "، خداج سابق"
                    per_infant.append({
                        "infant_ref": f"{c['case_ref']}#{i}", "apgar_value_estimate": [8, 6, 3][level],
                        "apgar_class": order[level], "basis_ref": basis_ref,
                    })
            risk = order[max([0, *(order.index(p["apgar_class"]) for p in per_infant)])]
            return reply([{
                "name": "submit_prediction",
                "args": {
                    "count_value": len(per_infant), "risk_class": risk, "per_infant": per_infant,
                    "basis": {
                        "sources": ["TL-1"],
                        "weighting_note": "وضع تجريبي بلا نموذج: قاعدة ثابتة على أسبوع الحمل وتسمم الحمل والخداج السابق — ليست توقعاً طبياً ولا تُستخدم للقرار.",
                        "confidence_flag": "low" if any_missing else "normal",
                    },
                },
            }])
        if "create_preparation_draft" in names:
            p = _last_tool_result(messages, "get_approved_prediction")
            if p is None:
                return reply([{"name": "get_approved_prediction", "args": {}}])
            if p.get("error"):
                return reply([], "لا توقع معتمد.")
            infants = p.get("per_infant") or []
            high = [x for x in infants if x["apgar_class"] == "high"]
            medium = [x for x in infants if x["apgar_class"] == "medium"]
            if _last_tool_result(messages, "create_preparation_draft") is None:
                items: list[dict[str, Any]] = [{"item": "حاضنة جاهزة", "qty": len(infants)}]
                if len(medium) + len(high):
                    items.append({"item": "جهاز مراقبة حيوية", "qty": len(medium) + len(high)})
                if high:
                    items.append({"item": "سرير عناية مركزة لحديثي الولادة", "qty": len(high)})
                return reply([{"name": "create_preparation_draft", "args": {"items": items}}])
            if high and _last_tool_result(messages, "create_action_draft") is None:
                return reply([{
                    "name": "create_action_draft",
                    "args": {
                        "kind": "تجهيز",
                        "payload": {"summary": f"تجهيز {len(high)} سرير عناية مركزة قبل الولادة", "infant_refs": [x["infant_ref"] for x in high],
                                    "justification": "أطفال متوقعون بفئة high حسب التوقع المعتمد"},
                        "alternatives": ["إبلاغ فريق العناية المركزة دون حجز مسبق"],
                    },
                }])
            return reply([], "جُهّزت المسودات.")
        return reply([], "لا شيء.")


def build_model(cfg: Config) -> Any:
    return DemoModel() if cfg["model"]["provider"] == "demo" else OpenAICompatibleModel(cfg)
