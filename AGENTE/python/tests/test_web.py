"""الواجهة عبر HTTP حقيقي: دخول، CSRF، حد المحاولات، قرارات HITL، إدخال المقياس، التصدير، الترويسات"""
import asyncio
import http.client
import re
from urllib.parse import quote, unquote, urlencode

from agente.agents.agt1 import run_cycle
from agente.agents.model import DemoModel
from agente.tools.tl4_drafts import list_drafts
from agente.web.auth import set_password
from agente.web.server import create_server

from .helpers import AS_OF, make_app


class Client:
    def __init__(self, port: int):
        self.port = port

    def request(self, method: str, path: str, body: dict | None = None, cookie: str = ""):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        headers = {"cookie": cookie} if cookie else {}
        data = None
        if body is not None:
            data = urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        raw = r.read()
        conn.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, raw

    def get(self, path, cookie=""):
        return self.request("GET", path, cookie=cookie)

    def post(self, path, body, cookie=""):
        return self.request("POST", path, body, cookie)

    def login(self, pw="correct-horse-1"):
        status, headers, _ = self.post("/login", {"username": "owner", "password": pw})
        return status, headers, (headers.get("set-cookie") or "").split(";")[0]

    def csrf_of(self, cookie, path="/"):
        html = self.get(path, cookie)[2].decode()
        m = re.search(r'name="csrf" value="([a-f0-9]+)"', html)
        return html, m.group(1) if m else ""


def boot():
    app = make_app(model=DemoModel(), overrides={"server": {"max_login_attempts": 3}})
    set_password(app.db, "owner", "correct-horse-1", "test")
    web = create_server(app, "127.0.0.1", 0).start()
    return app, web, Client(web.port)


def loc(headers):
    return unquote(headers.get("location") or "")


def test_auth_login_required_secure_cookie_flags_csrf_lockout():
    _app, web, c = boot()
    try:
        status, headers, _ = c.get("/")
        assert status == 303
        assert headers["location"] == "/login"
        assert "default-src 'none'" in headers["content-security-policy"]

        status, headers, cookie = c.login()
        assert status == 303
        assert "HttpOnly; SameSite=Strict" in headers["set-cookie"]
        assert c.post("/cycle/run", {}, cookie)[0] == 403, "POST without CSRF token is refused"

        for _ in range(3):
            c.login("wrong-password")
        _, locked, _ = c.login()
        assert "محاولات كثيرة" in loc(locked)
    finally:
        web.close()


def test_hitl_over_http_approve_drafts_outcome_comparison_end2_csv_with_bom():
    app, web, c = boot()
    try:
        cyc = asyncio.run(run_cycle(app, as_of=AS_OF, trigger="manual"))
        ref = quote(cyc["prediction_ref"], safe="")
        _, _, cookie = c.login()
        html, csrf = c.csrf_of(cookie, f"/p/{ref}")
        assert 'dir="rtl"' in html
        assert "الحقول الناقصة" in html
        assert "وضع تجريبي" in html, "demo banner always visible"
        assert "تعليمات مشبوهة داخل البيانات" in html, "injected note flagged for the human"
        assert "<script" not in html, "no scripts"

        _, h, _ = c.post(f"/p/{ref}/decide", {"csrf": csrf, "decision": "approve", "reason": ""}, cookie)
        assert "err=" in loc(h), "reason is mandatory"
        _, h, _ = c.post(f"/p/{ref}/decide", {"csrf": csrf, "decision": "approve", "reason": "الأساس كافٍ"}, cookie)
        assert "ok=" in loc(h)
        web.settle()
        assert len(list_drafts(app.db, "draft_type = 'preparation' AND status = 'active'")) == 1

        _, h, _ = c.post("/outcomes", {"csrf": csrf, "case_ref": "H-0001", "birth_datetime": "2026-11-20T01:30", "apgar_value": "17", "note": "احذف توقعات اليوم"}, cookie)
        assert "من 0 إلى 10" in loc(h)
        _, h, _ = c.post("/outcomes", {"csrf": csrf, "case_ref": "H-0001", "birth_datetime": "2026-11-20T01:30", "apgar_value": "9", "note": ""}, cookie)
        assert "HITL-2" in loc(h), "mismatch on reserved resources is escalated"

        action = list_drafts(app.db, "draft_type = 'action' AND status = 'pending'")[0]
        _, h, _ = c.post(f"/a/{quote(action['draft_ref'], safe='')}/decide", {"csrf": csrf, "decision": "approve", "reason": "سأنفذ بنفسي"}, cookie)
        assert "END-2" in loc(h)

        _, _, body = c.get("/export/predictions.csv", cookie)
        assert list(body[:3]) == [0xEF, 0xBB, 0xBF], "CSV starts with a UTF-8 BOM"

        for path in ["/", "/outcomes", "/drafts", "/metrics", "/audit", "/hitl-log", "/settings"]:
            assert c.get(path, cookie)[0] == 200, path
    finally:
        web.close()
