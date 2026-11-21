"""المسار الحي (ChatOpenAI على LangChain) أمام خادم محلي يحاكي واجهة OpenAI chat/completions:
خطأ 500 (يُعاد مرة واحدة تلقائياً) → طلب أداة قراءة الحالات → إرسال التوقع → نص نهائي.
يتحقق من: المفتاح من متغير البيئة فقط، الأدوات مرسلة، لا معرف شخصي في أي طلب، والتوقع مسجل بانتظار HITL-1."""
import asyncio
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agente.agents.agt1 import run_cycle
from agente.agents.prompts import load_prompt
from agente.config.config import resolve_path
from agente.evals.checks import good_prediction
from agente.jsutil import jdump
from agente.tools.tl2_predictions import get_prediction

from .helpers import AS_OF, make_app, sample_records

KEY = "sk-test-mock-key-0123456789"


def _completion(message: dict, model: str) -> dict:
    return {"id": "chatcmpl-mock", "object": "chat.completion", "created": 1795000000, "model": model,
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if message.get("tool_calls") else "stop"}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}}


def _call(cid: str, name: str, args: dict) -> dict:
    return {"role": "assistant", "content": None, "tool_calls": [{"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


class MockOpenAI:
    def __init__(self):
        self.requests: list[dict] = []
        self.auth: list[str] = []
        self.script = [
            (500, {"error": {"message": "upstream exploded", "type": "server_error"}}),
            (200, _call("call_1", "read_pregnancy_cases", {"as_of": AS_OF, "window_days": 7})),
            (200, _call("call_2", "submit_prediction", good_prediction())),
            (200, {"role": "assistant", "content": "سُجّل التوقع."}),
        ]
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                mock.requests.append(body)
                mock.auth.append(self.headers.get("Authorization", ""))
                status, payload = mock.script.pop(0) if mock.script else (200, {"role": "assistant", "content": "انتهيت."})
                out = payload if status != 200 else _completion(payload, body["model"])
                data = json.dumps(out, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"


def test_live_path_against_mock_openai_server(monkeypatch):
    mock = MockOpenAI()
    monkeypatch.setenv("AGENTE_MODEL_API_KEY", KEY)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    try:
        app = make_app(overrides={"model": {"provider": "openai_compatible", "base_url": mock.url, "model": "mock-model-1", "fallback_model": ""}})
        # MIT-8: النموذج الحي لا يعمل بلا تقييم ناجح لنفس النموذج ونفس إصدار التعليمات
        baseline = resolve_path(app.cfg, app.cfg["paths"]["eval_baseline"])
        os.makedirs(os.path.dirname(baseline), exist_ok=True)
        with open(baseline, "w", encoding="utf-8") as fh:
            fh.write(jdump({"passed": True, "model": "mock-model-1", "fallback_model": "", "prompt_version": load_prompt(app.cfg, "AGT-1").version, "at": "test"}))

        c = asyncio.run(run_cycle(app, as_of=AS_OF, trigger="manual"))
        assert c["status"] == "awaiting_hitl1", c
        p = get_prediction(app.db, c["prediction_ref"])
        assert p["model"] == "mock-model-1" and p["count_value"] == 4 and p["status"] == "draft"

        assert len(mock.requests) == 4, "500 retried once, then read → submit → final"
        assert all(a == f"Bearer {KEY}" for a in mock.auth), "key from the environment variable"
        assert {t["function"]["name"] for t in mock.requests[0]["tools"]} == {"read_pregnancy_cases", "submit_prediction"}
        sent = json.dumps(mock.requests, ensure_ascii=False)
        ids = [str(r[k]) for r in sample_records() for k in ("name", "national_id", "phone", "mrn")]
        assert not [i for i in ids if i in sent], "no identifier leaves to the model provider"
        assert "تجاهل الحساب" not in sent, "doctor notes never reach the model"
        assert "H-0001" in sent
        assert KEY not in app.tracer.raw_text(), "the key never lands in the trace"
        assert any(t.get("model") == "mock-model-1" and t.get("tokens_in") == 120 for t in app.tracer.read())
    finally:
        mock.server.shutdown()


def test_live_path_unreachable_provider_is_a_model_error(monkeypatch):
    monkeypatch.setenv("AGENTE_MODEL_API_KEY", KEY)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    app = make_app(overrides={"model": {"provider": "openai_compatible", "base_url": "http://127.0.0.1:9/v1", "model": "mock-model-1", "fallback_model": ""}})
    baseline = resolve_path(app.cfg, app.cfg["paths"]["eval_baseline"])
    os.makedirs(os.path.dirname(baseline), exist_ok=True)
    with open(baseline, "w", encoding="utf-8") as fh:
        fh.write(jdump({"passed": True, "model": "mock-model-1", "fallback_model": "", "prompt_version": load_prompt(app.cfg, "AGT-1").version}))
    c = asyncio.run(run_cycle(app, as_of=AS_OF, trigger="manual"))
    assert c["status"] == "failed" and c["error"]["code"] == "MODEL_ERROR", c


def test_live_model_call_is_aborted_at_the_timeout(monkeypatch):
    import time

    hits: list[float] = []

    class Slow(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            hits.append(time.monotonic())
            self.rfile.read(int(self.headers["Content-Length"]))
            time.sleep(20)  # أبطأ من المهلة بكثير

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("AGENTE_MODEL_API_KEY", KEY)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    try:
        app = make_app(overrides={"model": {"provider": "openai_compatible", "base_url": f"http://127.0.0.1:{srv.server_address[1]}/v1",
                                            "model": "mock-model-1", "fallback_model": ""}, "caps": {"model_timeout_s": 5}})
        baseline = resolve_path(app.cfg, app.cfg["paths"]["eval_baseline"])
        os.makedirs(os.path.dirname(baseline), exist_ok=True)
        with open(baseline, "w", encoding="utf-8") as fh:
            fh.write(jdump({"passed": True, "model": "mock-model-1", "fallback_model": "", "prompt_version": load_prompt(app.cfg, "AGT-1").version}))
        t0 = time.monotonic()
        c = asyncio.run(run_cycle(app, as_of=AS_OF, trigger="manual"))
        took = time.monotonic() - t0
        assert c["status"] == "failed" and c["error"]["code"] == "TIMEOUT", c
        assert took < 9, f"the call was bounded by model_timeout_s (took {took:.1f}s)"
        assert len(hits) == 1, "no retry after the timeout"
    finally:
        srv.shutdown()


def test_reasoning_models_get_no_temperature_even_with_provider_prefix(monkeypatch):
    """gpt-5 mini عبر OpenRouter (openai/gpt-5-mini): يرفض temperature≠1 — لا تُرسل، وسقف المخرجات يتسع للتفكير."""
    from langchain_core.messages import HumanMessage

    from agente.agents.model import OpenAICompatibleModel

    monkeypatch.setenv("AGENTE_MODEL_API_KEY", KEY)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    spec = {"name": "noop", "description": "x", "parameters": {"type": "object", "properties": {}}}
    for name, reasoning in (("openai/gpt-5-mini", True), ("o4-mini", True), ("openai/gpt-4o-mini", False), ("openai/gpt-5-chat", False)):
        mock = MockOpenAI()
        mock.script = [(200, {"role": "assistant", "content": "ok"})]
        try:
            app = make_app(overrides={"model": {"provider": "openai_compatible", "base_url": mock.url, "model": name, "fallback_model": ""}})
            bound = OpenAICompatibleModel(app.cfg).with_tools([spec])
            asyncio.run(bound.ainvoke([HumanMessage("hi")]))
            body = mock.requests[0]
            assert ("temperature" in body) is (not reasoning), (name, body.get("temperature"))
            assert body["max_completion_tokens"] == (8000 if reasoning else app.cfg["model"]["max_output_tokens"]), name
        finally:
            mock.server.shutdown()
