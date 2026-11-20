"""خادم الواجهة الداخلية (DEC-16 أ) على http.server من المكتبة القياسية — بلا إطار ولا مكتبات.
داخل شبكة المشفى (DEC-14 أ): يستمع على host من الإعدادات، و HTTPS إن ضُبطت الشهادة (BASE-11).
الأمان: جلسة + CSRF لكل POST، ترويسات أمان و CSP صارمة (لا سكربتات)، هروب كل مخرج، رسائل خطأ مفهومة بلا تفاصيل تقنية (BASE-10).

التزامن: ThreadingHTTPServer يقرأ الطلب في خيطه، ثم يُنفَّذ منطق التطبيق كله على حلقة asyncio واحدة في خيط مخصص
(مثل حلقة أحداث Node في النسخة الأصلية): قاعدة البيانات لا تُلمس من خيطين في آن، واستدعاءات النموذج لا تحجب الواجهة.
"""
from __future__ import annotations

import asyncio
import re
import ssl
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Awaitable
from urllib.parse import parse_qs, parse_qsl, unquote, urlsplit

from ..agents.agt1 import compare_outcome, eval_status, model_for, open_escalations, run_cycle
from ..agents.context import AppContext
from ..agents.prompts import load_prompt
from ..config.config import resolve_path
from ..guards.killswitch import TOOL_NAMES, read_controls, set_controls
from ..hitl.alerts import acknowledge_alert, open_alerts
from ..hitl.decisions import c9_for, decide_hitl1, decide_hitl2, decide_hitl3, decision_for, package_c5, package_c6, package_c7
from ..hitl.metrics import compute_metrics
from ..jsutil import encode_uri_component as enc
from ..jsutil import iso_from_ms, jdump, js_number, js_str, now_ms, parse_date_ms
from ..observability.errors import AppError, as_app_error, log_server_error
from ..observability.trace import new_run_id
from ..storage.db import qall
from ..tools.registry import ToolCtx, invoke
from ..tools.tl2_predictions import get_prediction, list_predictions
from ..tools.tl3_outcomes import TL3_RECORD, list_discrepancies
from ..tools.tl4_drafts import list_drafts
from .auth import Auth, Session, set_password
from .views import CSS, class_badge, csrf_field, esc, fmt_date, layout, status_ar, table

SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}

BODY_LIMIT = 64 * 1024


@dataclass
class Request:
    method: str
    target: str  # المسار مع الاستعلام كما وصل
    headers: dict[str, str]
    body: bytes
    remote: str
    body_too_large: bool = False


@dataclass
class Response:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""


def _form(req: Request, limit: int = BODY_LIMIT) -> dict[str, str]:
    """جسم النموذج (application/x-www-form-urlencoded) — آخر قيمة للمفتاح المكرر، كما في URLSearchParams"""
    if req.body_too_large or len(req.body) > limit:
        raise AppError("BAD_REQUEST", "body too large")
    out: dict[str, str] = {}
    for k, v in parse_qsl(req.body.decode("utf-8", errors="replace"), keep_blank_values=True):
        out[k] = v
    return out


def _cookies(req: Request) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in (req.headers.get("cookie") or "").split(";"):
        i = part.find("=")
        if i > 0:
            out[part[:i].strip()] = unquote(part[i + 1:].strip())
    return out


def to_csv(headers: list[str], rows: list[list[Any]]) -> str:
    """CSV بصيغة UTF-8 مع BOM (يفتح في Excel بالعربي)، وحماية من حقن الصيغ"""
    def cell(v: Any) -> str:
        s = "" if v is None else jdump(v) if isinstance(v, (dict, list)) else js_str(v)
        if re.match(r"[=+\-@\t\r]", s):
            s = f"'{s}"
        return '"' + s.replace('"', '""') + '"' if re.search(r'[",\n\r]', s) else s
    return "﻿" + "\r\n".join(",".join(cell(c) for c in r) for r in [headers, *rows]) + "\r\n"


class WebApp:
    """منطق الواجهة (صفحات + توجيه) — يعمل على حلقة asyncio واحدة"""

    def __init__(self, app: AppContext):
        self.app = app
        self.cfg = app.cfg
        self.db = app.db
        self.auth = Auth(app.db, app.cfg["server"])
        self.secure = bool(self.cfg["server"]["tls_cert"] and self.cfg["server"]["tls_key"])
        # متابعات تعمل في الخلفية بعد القرار (التحضير، دورة جديدة) — تُنتظر في الاختبارات
        self.background: set[asyncio.Future[Any]] = set()
        self.cycle_running = False

    def track(self, fut: Any) -> None:
        if fut is None or not isinstance(fut, asyncio.Future):
            return

        def done(f: asyncio.Future[Any]) -> None:
            self.background.discard(f)
            if not f.cancelled() and f.exception() is not None:
                log_server_error("background", f.exception(), self.app.tracer.scrub)

        self.background.add(fut)
        fut.add_done_callback(done)

    # ── أدوات الاستجابة ───────────────────────────────────────────────────────
    @staticmethod
    def send(status: int, body: str | bytes, ctype: str = "text/html; charset=utf-8", extra: dict[str, str] | None = None) -> Response:
        return Response(status, {**SECURITY_HEADERS, "Content-Type": ctype, **(extra or {})}, body.encode("utf-8") if isinstance(body, str) else body)

    @staticmethod
    def redirect(to: str, extra: dict[str, str] | None = None) -> Response:
        return Response(303, {**SECURITY_HEADERS, "Location": to, **(extra or {})})

    @staticmethod
    def flash_to(path: str, kind: str, text: str) -> str:
        return f"{path}{'&' if '?' in path else '?'}{kind}={enc(text)}"

    def banners(self) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        c = read_controls(self.cfg)
        if c["enabled"]:
            out.append({"kind": "danger", "text": "مفتاح الإيقاف مفعّل: الوكيل والأدوات متوقفة. أعد التشغيل من الإعدادات."})
        elif c["disabled_tools"]:
            out.append({"kind": "warn", "text": f"أدوات موقوفة: {'، '.join(c['disabled_tools'])}"})
        model = model_for(self.app)
        if model.kind == "demo":
            out.append({"kind": "danger", "text": "وضع تجريبي: «التوقعات» من قاعدة ثابتة لا من نموذج — للتجربة فقط، لا تُستخدم لأي قرار."})
        try:
            ev = eval_status(self.app, model, load_prompt(self.cfg, "AGT-1").version)
            if not ev["ok"]:
                out.append({"kind": "warn", "text": f"الوكيل لن يعمل قبل تقييم ناجح للنموذج الحالي ({ev['reason']}) — شغّل: python -m agente eval --live"})
        except Exception:
            pass  # الإعدادات تظهر في صفحتها
        return out

    def page(self, s: Session | None, title: str, body: str, query: dict[str, list[str]] | None = None, status: int = 200) -> Response:
        q = query or {}
        ok, err = (q.get("ok") or [""])[0], (q.get("err") or [""])[0]
        flash = {"kind": "ok", "text": ok} if ok else {"kind": "err", "text": err} if err else None
        return self.send(status, layout(title=title, body=body, user=s.user if s else None, csrf=s.csrf if s else None,
                                        banners=self.banners() if s else [], flash=flash))

    # ── الصفحات ──────────────────────────────────────────────────────────────
    def dashboard(self, s: Session) -> str:
        app, db, cfg = self.app, self.db, self.cfg
        alerts = open_alerts(app)
        pending = list_predictions(db, "status = 'draft'")
        esc2 = open_escalations(app)
        actions = list_drafts(db, "draft_type = 'action' AND status = 'pending'")
        cycles = qall(db, "SELECT * FROM cycles ORDER BY started_at DESC LIMIT 8")
        now = now_ms()

        def deadline(p: dict[str, Any]) -> str:
            bd = p["batch_deadline"]
            t = parse_date_ms(bd) if bd else None
            return f'<span class="flag">تأخر: {fmt_date(bd)}</span>' if bd and t is not None and t < now else fmt_date(bd)

        return f"""
<div class="grid">
  <div class="card"><div class="muted">توقعات بانتظار قرارك (HITL-1)</div><div class="stat">{len(pending)}</div></div>
  <div class="card"><div class="muted">خلافات بانتظار قرارك (HITL-2)</div><div class="stat">{len(esc2)}</div></div>
  <div class="card"><div class="muted">أفعال بانتظار موافقتك (HITL-3)</div><div class="stat">{len(actions)}</div></div>
</div>
<h2>تنبيهات مفتوحة</h2>
{table(["النوع", "الرسالة", "منذ", ""], [[
            class_badge("high") if a["kind"] == "critical" else esc(a["kind"]), esc(a["message"]), fmt_date(a["created_at"]),
            f'<form method="post" action="/alerts/{esc(a["alert_id"])}/ack" class="inline">{csrf_field(s.csrf)}<button class="secondary">إقرار</button></form>',
        ] for a in alerts], "لا تنبيهات مفتوحة.")}
<h2>توقعات بانتظار قرارك</h2>
{table(["التوقع", "الدورة", "العدد", "أعلى فئة", "الموعد", ""], [[
            esc(p["prediction_ref"]), esc(p["cycle_id"]), esc(p["count_value"]), class_badge(p["risk_class"]), deadline(p),
            f'<a href="/p/{enc(p["prediction_ref"])}">راجع وقرر</a>',
        ] for p in pending])}
<h2>خلافات بانتظار قرارك</h2>
{table(["الفارق", "التوقع", "المقياس", ""], [[esc(d["discrepancy_ref"]), esc(d["prediction_ref"]), esc(d["actual_ref"]), f'<a href="/d/{enc(d["discrepancy_ref"])}">راجع وقرر</a>'] for d in esc2])}
<h2>أفعال بانتظار موافقتك</h2>
{table(["المسودة", "النوع", "الملخص", ""], [[esc(a["draft_ref"]), esc(a["action_kind"]), esc((a["payload"] or {}).get("summary")), f'<a href="/a/{enc(a["draft_ref"])}">راجع وقرر</a>'] for a in actions])}
<h2>الدورات</h2>
<form method="post" action="/cycle/run" class="actions">{csrf_field(s.csrf)}<button>{"دورة جارية…" if self.cycle_running else "شغّل دورة التوقع الآن"}</button>
<span class="muted">الدورة اليومية تعمل تلقائياً الساعة {esc(cfg["schedule"]["daily_cycle_time"])}.</span></form>
{table(["الدورة", "الحالة", "البداية", "الخطأ"], [[esc(c["cycle_id"]), status_ar(c["status"]), fmt_date(c["started_at"]), esc(c["error_code"] or "")] for c in cycles])}"""

    def prediction_page(self, s: Session, ref: str) -> str:
        pk = package_c5(self.app, ref)
        c5, p, basis, cases = pk["c5"], pk["prediction"], pk["basis"], pk["cases"]
        dec = decision_for(self.db, "HITL-1", ref)

        def indicators(c: dict[str, Any]) -> str:
            return "<br>".join(f"{esc(k)}: {'<span class=\"flag\">ناقص</span>' if v is None else esc(v)}" for k, v in c["indicators"].items())

        case_rows = [[
            esc(x["case"]["case_ref"]), esc(x["case"]["gestation_week"]), esc(x["expected_infants"]), indicators(x["case"]),
            (f'<div class="data">{esc(x["case"]["notes_raw"])}</div>' + (f'<div class="flag">⚠ {esc(x["notes_flag"])}</div>' if x["notes_flag"] else ""))
            if x["case"].get("notes_raw") else '<span class="muted">—</span>',
        ] for x in cases]
        infants = [[esc(i["infant_ref"]), esc("—" if i["apgar_value_estimate"] is None else i["apgar_value_estimate"]), class_badge(i["apgar_class"]), esc(i["basis_ref"])]
                   for i in p["per_infant"]]
        labels = {"low": "منخفضة", "medium": "متوسطة", "high": "عالية"}
        edit_rows = "".join(f"""
<tr><td>{esc(i["infant_ref"])}<input type="hidden" name="inf_{n}_ref" value="{esc(i["infant_ref"])}"></td>
<td><select name="inf_{n}_class">{"".join(f'<option value="{c}"{" selected" if c == i["apgar_class"] else ""}>{esc(labels[c])}</option>' for c in ["low", "medium", "high"])}</select></td>
<td><input name="inf_{n}_est" type="number" min="0" max="10" step="1" value="{esc("" if i["apgar_value_estimate"] is None else i["apgar_value_estimate"])}"></td>
<td><label><input type="checkbox" name="inf_{n}_keep" value="1" checked> متوقع وصوله</label></td></tr>""" for n, i in enumerate(p["per_infant"]))
        if p["status"] == "draft":
            form = f"""
<form method="post" action="/p/{enc(ref)}/decide" class="card">{csrf_field(s.csrf)}
<fieldset><legend>قرارك (HITL-1)</legend><div class="radio">
<label><input type="radio" name="decision" value="approve" required> اعتماد</label>
<label><input type="radio" name="decision" value="modify"> تعديل ثم اعتماد</label>
<label><input type="radio" name="decision" value="reject"> رفض</label></div>
<label for="reason">السبب (إلزامي)</label><textarea id="reason" name="reason" required minlength="3" maxlength="1000"></textarea></fieldset>
<fieldset><legend>التعديل (يُستخدم فقط إن اخترت «تعديل»)</legend>
<div class="scroll"><table><thead><tr><th>الطفل</th><th>الفئة</th><th>تقدير Apgar</th><th></th></tr></thead><tbody>{edit_rows}</tbody></table></div>
<input type="hidden" name="inf_count" value="{len(p["per_infant"])}"></fieldset>
<div class="actions"><button>سجّل القرار</button><span class="muted">لا شيء يُنفَّذ: الاعتماد يجهّز مسودة تحضير فقط.</span></div></form>"""
        else:
            who = f' — {esc(dec["decided_by"])} {fmt_date(dec["decided_at"])} — السبب: {esc(dec["reason"])}' if dec else ""
            form = f'<div class="card"><strong>القرار:</strong> {status_ar(p["status"])}{who}</div>'
        missing = (f'<div class="card">{" ".join(f"<span class=\"badge none\">{esc(f)}</span>" for f in c5["missing_fields"])}</div>'
                   if c5["missing_fields"] else '<p class="muted">لا نواقص.</p>')
        return f"""
<div class="card"><div class="grid">
  <div><div class="muted">الحالة</div><strong>{status_ar(p["status"])}</strong></div>
  <div><div class="muted">العدد المتوقع</div><div class="stat">{esc(c5["count_value"])}</div></div>
  <div><div class="muted">أعلى فئة</div>{class_badge(c5["risk_class"])}{' <span class="flag">تنبيه فوري</span>' if c5["critical_alert"] else ""}</div>
  <div><div class="muted">الثقة</div>{'<span class="flag">منخفضة — بيانات ناقصة أو أساس ضعيف</span>' if basis["confidence_flag"] == "low" else "عادية"}</div>
</div></div>
<h2>الأساس (من سجلات المشفى فقط: {esc("، ".join(basis["sources"]))})</h2><div class="card data">{esc(basis["weighting_note"])}</div>
<h2>الحقول الناقصة (لم تُملأ)</h2>{missing}
<h2>الأطفال المتوقعون</h2>{table(["الطفل", "تقدير Apgar", "الفئة", "أساس التقدير"], infants)}
<h2>الحالات كما وردت من المصدر (بيانات لا تعليمات)</h2>{table(["الحالة", "أسبوع الحمل", "الأجنّة", "المؤشرات", "ملاحظات المصدر"], case_rows)}
{form}<p class="muted">النموذج: {esc(p["model"] if p["model"] is not None else "إنسان")} · التعليمات: {esc(p["prompt_version"] if p["prompt_version"] is not None else "—")} · تشغيل: {esc(p["run_id"])}</p>"""

    @staticmethod
    def edit_from(f: dict[str, str]) -> dict[str, Any]:
        n = js_number(f.get("inf_count"))
        n = min(int(n) if n == n and n > 0 else 0, 200)
        per_infant = []
        for i in range(n):
            est = (f.get(f"inf_{i}_est") or "").strip()
            if est != "" and not re.fullmatch(r"[0-9]{1,2}", est):
                raise AppError("REJECTED_RANGE", "estimate", "تقدير Apgar عدد صحيح من 0 إلى 10.")
            per_infant.append({"infant_ref": f.get(f"inf_{i}_ref", ""), "apgar_class": f.get(f"inf_{i}_class", ""),
                               "apgar_value_estimate": None if est == "" else int(est), "keep": f.get(f"inf_{i}_keep") == "1"})
        return {"per_infant": per_infant, "note": (f.get("reason") or "")[:300]}

    def discrepancy_page(self, s: Session, ref: str) -> str:
        pk = package_c6(self.app, ref)
        d, o, reserved, prediction = pk["discrepancy"], pk["outcome"], pk["reserved"], pk["prediction"]
        c6 = pk["c6"]
        dec = decision_for(self.db, "HITL-2", ref)
        edit_rows = "".join(f"""
<tr><td>{esc(i["infant_ref"])}<input type="hidden" name="inf_{n}_ref" value="{esc(i["infant_ref"])}"></td>
<td><select name="inf_{n}_class">{"".join(f'<option value="{c}"{" selected" if c == i["apgar_class"] else ""}>{esc(c)}</option>' for c in ["low", "medium", "high"])}</select></td>
<td><input name="inf_{n}_est" type="number" min="0" max="10" value="{esc("" if i["apgar_value_estimate"] is None else i["apgar_value_estimate"])}"></td>
<td><label><input type="checkbox" name="inf_{n}_keep" value="1" checked> باقٍ</label></td></tr>""" for n, i in enumerate(prediction["per_infant"])) if prediction else ""
        if d["escalated"] and not dec:
            edit = (f"""<fieldset><legend>تعديل التوزيع (عند اختيار «تعديل»)</legend><div class="scroll"><table><thead><tr><th>الطفل</th><th>الفئة</th><th>Apgar</th><th></th></tr></thead><tbody>{edit_rows}</tbody></table></div>
<input type="hidden" name="inf_count" value="{len(prediction["per_infant"])}"></fieldset>""" if prediction else "")
            form = f"""
<form method="post" action="/d/{enc(ref)}/decide" class="card">{csrf_field(s.csrf)}
<fieldset><legend>قرارك (HITL-2)</legend><div class="radio">
<label><input type="radio" name="decision" value="approve" required> إبقاء التوزيع</label>
<label><input type="radio" name="decision" value="modify"> تعديل التوزيع</label>
<label><input type="radio" name="decision" value="reject"> إعادة تقييم (دورة جديدة)</label></div>
<label for="reason">السبب (إلزامي — خصوصاً عند الإبقاء)</label><textarea id="reason" name="reason" required minlength="3"></textarea></fieldset>
{edit}
<div class="actions"><button>سجّل القرار</button></div></form>"""
        elif dec:
            form = f'<div class="card"><strong>القرار:</strong> {esc(dec["decision"])} — {esc(dec["decided_by"])} {fmt_date(dec["decided_at"])} — {esc(dec["reason"])}</div>'
        else:
            form = '<div class="card muted">هذا الفارق مسجَّل فقط (لا موارد محجوزة — لا يحتاج قرار HITL-2).</div>'

        def items(r: dict[str, Any]) -> str:
            return "، ".join(f"{i['item']}{' × ' + js_str(i['qty']) if 'qty' in i else ''}" for i in (r["items"] or []))

        reserved_html = f'<h2>الموارد المحجوزة</h2>{table(["المسودة", "البنود"], [[esc(r["draft_ref"]), esc(items(r))] for r in reserved])}' if reserved else ""
        note_html = f'<h2>ملاحظة الإدخال (نص فقط)</h2><div class="data card">{esc(o["note"])}</div>' if o.get("note") else ""
        predicted = d["predicted"] or {}
        return f"""
<div class="card"><div class="grid">
  <div><div class="muted">التوقع</div><strong>{esc(c6["prediction_ref"])}</strong></div>
  <div><div class="muted">الفئة المتوقعة للطفل {esc(d["infant_ref"] or "")}</div>{class_badge(predicted.get("infant_class"))}</div>
  <div><div class="muted">الفعلي (Apgar {esc(o["apgar_value"])})</div>{class_badge(o["apgar_class"])}</div>
  <div><div class="muted">موارد محجوزة</div><strong>{"نعم" if d["resources_reserved"] else "لا"}</strong></div>
</div></div>
{reserved_html}
{note_html}
{form}"""

    def action_page(self, s: Session, ref: str) -> str:
        pk = package_c7(self.app, ref)
        c7, draft, prediction = pk["c7"], pk["draft"], pk["prediction"]
        c9 = c9_for(self.db, ref)
        if draft["status"] == "pending":
            form = f"""
<form method="post" action="/a/{enc(ref)}/decide" class="card">{csrf_field(s.csrf)}
<fieldset><legend>قرارك (HITL-3)</legend><div class="radio">
<label><input type="radio" name="decision" value="approve" required> موافقة — أنا أنفّذ خارج النظام (END-2)</label>
<label><input type="radio" name="decision" value="reject"> رفض — لا تنفيذ (END-1)</label></div>
<label for="reason">السبب (إلزامي)</label><textarea id="reason" name="reason" required minlength="3"></textarea></fieldset>
<div class="actions"><button>سجّل القرار</button><span class="muted">النظام لا ينفّذ أي فعل؛ الموافقة تُسجَّل وتنقل التنفيذ إليك.</span></div></form>"""
        else:
            end = "END-2: التنفيذ بيد الإنسان خارج النظام" if c9 and c9["outcome"] == "END_2_HUMAN_EXECUTES" else "END-1: لا تنفيذ"
            form = f'<div class="card"><strong>{end}</strong> — {esc(c9["decided_by"] if c9 else None)} {fmt_date(c9["decided_at"] if c9 else None)}</div>'
        payload = draft["payload"] or {}
        alts = f'<h2>البدائل</h2><ul>{"".join(f"<li>{esc(a)}</li>" for a in c7["alternatives"])}</ul>' if c7["alternatives"] else ""
        return f"""
<div class="card"><div class="grid">
  <div><div class="muted">النوع</div><strong>{esc(c7["kind"])}</strong></div>
  <div><div class="muted">مبني على التوقع المعتمد</div><a href="/p/{enc(c7["based_on"])}">{esc(c7["based_on"])}</a> {class_badge(prediction["risk_class"] if prediction else None)}</div>
  <div><div class="muted">الحالة</div>{status_ar(draft["status"])}</div>
</div></div>
<h2>الملخص</h2><div class="card data">{esc(c7["payload_summary"])}</div>
<h2>المبرر</h2><div class="card data">{esc(payload.get("justification"))}</div>
<h2>الأطفال المعنيون</h2><p>{"، ".join(esc(r) for r in (payload.get("infant_refs") or []))}</p>
{alts}
{form}"""

    def outcomes_page(self, s: Session) -> str:
        refs = qall(self.db, "SELECT DISTINCT case_ref FROM cycle_cases ORDER BY case_ref")
        rows = qall(self.db, "SELECT o.*, d.discrepancy_ref, d.class_mismatch, d.escalated FROM outcomes o LEFT JOIN discrepancies d ON d.actual_ref = o.actual_ref ORDER BY o.stored_at DESC LIMIT 100")

        def cmp(r: dict[str, Any]) -> str:
            if not r["discrepancy_ref"]:
                return "—"
            label = ('<span class="flag">خلاف مصعَّد</span>' if r["escalated"] else "خلاف مسجَّل") if r["class_mismatch"] else "مطابق"
            return f'<a href="/d/{enc(str(r["discrepancy_ref"]))}">{label}</a>'

        return f"""
<form method="post" action="/outcomes" class="card">{csrf_field(s.csrf)}
<p class="muted">نقطة الإدخال الوحيدة للمقياس الفعلي (TB-2). القيمة خارج 0..10 تُرفض ولا تُصحَّح. الملاحظة نص فقط.</p>
<label for="case_ref">الحالة</label><select id="case_ref" name="case_ref" required>{"".join(f"<option>{esc(r['case_ref'])}</option>" for r in refs)}</select>
<label for="birth_datetime">وقت الولادة</label><input id="birth_datetime" name="birth_datetime" type="datetime-local" required>
<label for="apgar_value">مقياس Apgar (0–10)</label><input id="apgar_value" name="apgar_value" inputmode="numeric" pattern="\\d{{1,2}}" required>
<label for="note">ملاحظة (اختيارية)</label><textarea id="note" name="note" maxlength="500"></textarea>
<div class="actions"><button>سجّل المقياس</button></div></form>
<h2>آخر المقاييس والمقارنة</h2>
{table(["المقياس", "الحالة", "الولادة", "Apgar", "الفئة", "أدخله", "المقارنة"], [[
            esc(r["actual_ref"]), esc(r["case_ref"]), fmt_date(str(r["birth_datetime"])), esc(r["apgar_value"]), class_badge(str(r["apgar_class"])), esc(r["entered_by"]), cmp(r),
        ] for r in rows])}"""

    def drafts_page(self) -> str:
        def content(x: dict[str, Any]) -> Any:
            if x["draft_type"] == "action":
                return (x["payload"] or {}).get("summary")
            return "، ".join(f"{i['item']}{' × ' + js_str(i['qty']) if 'qty' in i else ''}" for i in (x["items"] or []))

        return table(["المسودة", "النوع", "مبنية على", "المحتوى", "الحالة", "التاريخ"], [[
            f'<a href="/a/{enc(x["draft_ref"])}">{esc(x["draft_ref"])}</a>' if x["draft_type"] == "action" else esc(x["draft_ref"]),
            f'فعل: {esc(x["action_kind"])}' if x["draft_type"] == "action" else "تحضير",
            f'<a href="/p/{enc(x["based_on"])}">{esc(x["based_on"])}</a>',
            esc(content(x)), status_ar(x["status"]), fmt_date(x["created_at"]),
        ] for x in list_drafts(self.db)])

    def metrics_page(self, q: dict[str, list[str]]) -> str:
        n = js_number((q.get("days") or [None])[0])
        days = min(max(n if n == n and n else 30, 1), 365)
        days = int(days) if float(days).is_integer() else days
        m = compute_metrics(self.app, days)

        def verdict(p: bool | None) -> str:
            return '<span class="muted">لا بيانات كافية بعد</span>' if p is None else '<span class="badge low">يحقق العتبة</span>' if p else '<span class="badge high">دون العتبة</span>'

        cm, ct = m["class_match"], m["count_match"]
        return f"""
<p class="muted">آخر {esc(days)} يوماً · العتبات من قرارك DEC-3.</p>
<div class="grid">
 <div class="card"><div class="muted">مطابقة الفئة (≥{esc(cm["threshold"])}%)</div><div class="stat">{"—" if cm["pct"] is None else js_str(cm["pct"])}%</div>{verdict(cm["pass"])}<div class="muted">{esc(cm["matched"])} من {esc(cm["compared"])} مقارنة</div></div>
 <div class="card"><div class="muted">مطابقة العدد (≥{esc(ct["threshold"])}%)</div><div class="stat">{"—" if ct["pct"] is None else js_str(ct["pct"])}%</div>{verdict(ct["pass"])}<div class="muted">{esc(ct["cycles"])} دورة انتهت نافذتها</div></div>
 <div class="card"><div class="muted">خلاف بلا تصعيد (يجب 0)</div><div class="stat">{esc(m["unescalated"])}</div>{'<span class="badge low">سليم</span>' if m["unescalated"] == 0 else '<span class="badge high">خلل</span>'}</div>
 <div class="card"><div class="muted">ولادات بلا توقع سابق</div><div class="stat">{esc(m["unplanned"])}</div></div>
</div>
{table(["التوقع", "المتوقع", "الفعلي"], [[esc(d["prediction_ref"]), esc(d["predicted"]), esc(d["actual"])] for d in ct["detail"]])}"""

    def audit_page(self, q: dict[str, list[str]]) -> str:
        n = js_number((q.get("page") or [None])[0])
        page_n = max(int(n) if n == n and n else 1, 1)
        rows = qall(self.db, "SELECT * FROM audit ORDER BY seq DESC LIMIT 100 OFFSET ?", (page_n - 1) * 100)
        return table(["الرقم", "الوقت", "الفاعل", "الكيان", "المرجع", "الفعل", "السبب"], [[
            esc(r["audit_id"]), fmt_date(r["ts"]), esc(r["actor"]), esc(r["entity"]), esc(r["ref"]), esc(r["action"]), esc(r["reason"] or "")
        ] for r in rows]) + f'<p><a href="/audit?page={page_n + 1}">الأقدم ←</a></p>'

    def hitl_log_page(self) -> str:
        rows = qall(self.db, "SELECT * FROM hitl_log ORDER BY seq DESC LIMIT 200")
        return table(["الوقت", "النقطة", "الموضوع", "من قرر", "القرار", "السبب", "ماذا حدث بعدها"], [[
            fmt_date(r["ts"]), esc(r["hitl"]), esc(r["subject_ref"]), esc(r["decided_by"]), esc(r["decision"]), esc(r["reason"]), esc(r["after_effect"])
        ] for r in rows])

    def settings_page(self, s: Session) -> str:
        cfg = self.cfg
        c = read_controls(cfg)
        model = model_for(self.app)
        changed = f'آخر تغيير: {esc(c["updated_by"])} {fmt_date(c["updated_at"])}' if c["updated_at"] else ""
        tools = "".join(f'<label><input type="checkbox" name="tool_{t}" value="1"{" checked" if t in c["disabled_tools"] else ""}> {esc("استدعاء النموذج" if t == "model" else t)}</label>' for t in TOOL_NAMES)
        current = jdump({
            "model": {"provider": cfg["model"]["provider"], "model": model.model_id, "fallback": cfg["model"]["fallback_model"], "key_env": cfg["model"]["api_key_env"]},
            "caps": cfg["caps"], "window_days": cfg["window_days"], "thresholds": cfg["thresholds"], "schedule": cfg["schedule"],
            "source": {"type": cfg["source"]["type"], "system": cfg["source"]["system_name"]},
        }, indent=2)
        return f"""
<form method="post" action="/settings/kill" class="card">{csrf_field(s.csrf)}
<h2>مفتاح الإيقاف</h2><p class="muted">يعمل فوراً بلا نشر جديد. {changed}</p>
<label><input type="checkbox" name="enabled" value="1"{" checked" if c["enabled"] else ""}> إيقاف كل شيء (الوكيل وكل الأدوات)</label>
<p>أو أوقف أدوات بعينها:</p>{tools}
<label for="kreason">السبب (إلزامي)</label><input id="kreason" name="reason" required minlength="3" style="width:100%">
<div class="actions"><button class="danger">احفظ حالة الإيقاف</button></div></form>
<div class="card"><h2>الإعدادات الحالية (للقراءة)</h2><div class="data">{esc(current)}</div><p class="muted">التعديل في config/settings.local.json على الخادم — والأسرار في متغيرات البيئة فقط.</p></div>
<form method="post" action="/password" class="card">{csrf_field(s.csrf)}<h2>تغيير كلمة السر</h2>
<label for="pw">كلمة السر الجديدة (10 أحرف على الأقل)</label><input id="pw" name="password" type="password" minlength="10" required autocomplete="new-password">
<div class="actions"><button class="secondary">غيّر كلمة السر</button></div></form>"""

    def export_csv(self, what: str) -> Response:
        db = self.db
        if what == "predictions":
            csv = to_csv(["prediction_ref", "cycle_id", "status", "count_value", "risk_class", "per_infant", "missing_fields", "confidence", "created_at"],
                         [[p["prediction_ref"], p["cycle_id"], p["status"], p["count_value"], p["risk_class"],
                           " ".join(f"{i['infant_ref']}:{i['apgar_class']}" for i in p["per_infant"]), " ".join(p["missing_fields"]),
                           p["basis"].get("confidence_flag"), p["created_at"]] for p in list_predictions(db)])
        elif what == "outcomes":
            csv = to_csv(["actual_ref", "case_ref", "birth_datetime", "apgar_value", "apgar_class", "entered_by", "stored_at"],
                         [[o["actual_ref"], o["case_ref"], o["birth_datetime"], o["apgar_value"], o["apgar_class"], o["entered_by"], o["stored_at"]]
                          for o in qall(db, "SELECT * FROM outcomes ORDER BY stored_at")])
        elif what == "discrepancies":
            csv = to_csv(["discrepancy_ref", "prediction_ref", "actual_ref", "infant_ref", "class_mismatch", "resources_reserved", "escalated", "created_at"],
                         [[d["discrepancy_ref"], d["prediction_ref"], d["actual_ref"], d["infant_ref"], d["class_mismatch"], d["resources_reserved"],
                           d["escalated"], d["created_at"]] for d in list_discrepancies(db)])
        else:
            raise AppError("NOT_FOUND", what)
        return self.send(200, csv, "text/csv; charset=utf-8", {"Content-Disposition": f'attachment; filename="agente-{what}.csv"'})

    # ── التوجيه ───────────────────────────────────────────────────────────────
    async def handle(self, req: Request) -> Response:
        app, cfg, db = self.app, self.cfg, self.db
        u = urlsplit(req.target)
        path = u.path or "/"
        query = parse_qs(u.query, keep_blank_values=True)
        method = req.method
        if path == "/static/app.css":
            return self.send(200, CSS, "text/css; charset=utf-8", {"Cache-Control": "max-age=3600"})
        if path == "/healthz":
            return self.send(200, "ok", "text/plain")
        sid = _cookies(req).get("agente_sid")
        s = self.auth.get(sid)
        cookie_flags = f"HttpOnly; SameSite=Strict; Path=/{'; Secure' if self.secure else ''}"

        if path == "/login":
            if method == "POST":
                f = _form(req, 4096)
                try:
                    ns = self.auth.login(req.remote or "?", f.get("username", ""), f.get("password", ""))
                    return self.redirect("/", {"Set-Cookie": f"agente_sid={ns.token}; {cookie_flags}; Max-Age={cfg['server']['session_hours'] * 3600}"})
                except Exception as e:
                    return self.redirect(self.flash_to("/login", "err", as_app_error(e).user_message))
            return self.page(None, "الدخول", """<form method="post" action="/login" class="card" autocomplete="on">
<label for="u">اسم المستخدم</label><input id="u" name="username" required autocomplete="username">
<label for="p">كلمة السر</label><input id="p" name="password" type="password" required autocomplete="current-password">
<div class="actions"><button>دخول</button></div></form>""", query)
        if not s:
            return self.redirect("/login")

        if method == "POST":
            f = _form(req)
            self.auth.check_csrf(s, f.get("csrf"))
            f.pop("csrf", None)
            ctx_human = ToolCtx(app=app, run_id=new_run_id("h"), actor="human", actor_name=s.user)
            if path == "/logout":
                self.auth.logout(sid)
                return self.redirect("/login", {"Set-Cookie": f"agente_sid=; {cookie_flags}; Max-Age=0"})
            if path == "/cycle/run":
                if self.cycle_running:
                    return self.redirect(self.flash_to("/", "err", "دورة جارية الآن."))
                self.cycle_running = True

                async def cycle() -> Any:
                    try:
                        return await run_cycle(app, trigger="manual", actor=f"human:{s.user}")
                    finally:
                        self.cycle_running = False

                self.track(asyncio.get_running_loop().create_task(cycle()))
                return self.redirect(self.flash_to("/", "ok", "بدأت دورة التوقع — حدّث الصفحة بعد قليل."))
            m = re.fullmatch(r"/p/([^/]+)/decide", path)
            if m:
                ref = unquote(m.group(1))
                try:
                    r = decide_hitl1(app, {"prediction_ref": ref, "decision": f.get("decision"), "reason": f.get("reason"),
                                           "edit": self.edit_from(f) if f.get("decision") == "modify" else None}, s.user)
                    self.track(r["prepare"])
                    return self.redirect(self.flash_to(f"/p/{enc(ref)}", "ok", f"سُجّل القرار {r['decision_id']}."))
                except Exception as e:
                    return self.redirect(self.flash_to(f"/p/{enc(ref)}", "err", as_app_error(e).user_message))
            m = re.fullmatch(r"/d/([^/]+)/decide", path)
            if m:
                ref = unquote(m.group(1))
                try:
                    r = decide_hitl2(app, {"discrepancy_ref": ref, "decision": f.get("decision"), "reason": f.get("reason"),
                                           "edit": self.edit_from(f) if f.get("decision") == "modify" else None}, s.user)
                    self.track(r["followup"])
                    return self.redirect(self.flash_to(f"/d/{enc(ref)}", "ok", f"سُجّل القرار {r['decision_id']}."))
                except Exception as e:
                    return self.redirect(self.flash_to(f"/d/{enc(ref)}", "err", as_app_error(e).user_message))
            m = re.fullmatch(r"/a/([^/]+)/decide", path)
            if m:
                ref = unquote(m.group(1))
                try:
                    r = decide_hitl3(app, {"draft_ref": ref, "decision": f.get("decision"), "reason": f.get("reason")}, s.user)
                    msg = "سُجّلت الموافقة — التنفيذ بيدك خارج النظام (END-2)." if r["end_state"] == "END_2_HUMAN_EXECUTES" else "سُجّل الرفض — لا تنفيذ (END-1)."
                    return self.redirect(self.flash_to(f"/a/{enc(ref)}", "ok", msg))
                except Exception as e:
                    return self.redirect(self.flash_to(f"/a/{enc(ref)}", "err", as_app_error(e).user_message))
            if path == "/outcomes":
                try:
                    local = f.get("birth_datetime") or ""
                    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}", local):
                        ms = parse_date_ms(local)  # وقت محلي من datetime-local → ISO
                        iso_dt = iso_from_ms(ms) if ms is not None else local
                    else:
                        iso_dt = local
                    r = await invoke(TL3_RECORD, ctx_human, {"case_ref": f.get("case_ref"), "birth_datetime": iso_dt,
                                                             "apgar_value": f.get("apgar_value"), "note": f.get("note")})
                    c = await compare_outcome(app, r["actual_ref"])
                    if c["escalated"]:
                        msg = f"سُجّل {r['actual_ref']} — خلاف على موارد محجوزة، يحتاج قرارك (HITL-2)."
                    elif c["class_mismatch"]:
                        msg = f"سُجّل {r['actual_ref']} — خلاف مسجَّل."
                    else:
                        msg = f"سُجّل {r['actual_ref']} — مطابق للتوقع."
                    return self.redirect(self.flash_to("/outcomes", "ok", msg))
                except Exception as e:
                    return self.redirect(self.flash_to("/outcomes", "err", as_app_error(e).user_message))
            if path == "/settings/kill":
                try:
                    reason = f.get("reason") or ""
                    if len(reason.strip()) < 3:
                        raise AppError("BAD_REQUEST", "reason", "السبب إلزامي.")
                    set_controls(cfg, db, {"enabled": f.get("enabled") == "1", "disabled_tools": [t for t in TOOL_NAMES if f.get(f"tool_{t}") == "1"]},
                                 f"human:{s.user}", reason.strip())
                    return self.redirect(self.flash_to("/settings", "ok", "حُفظت حالة مفتاح الإيقاف."))
                except Exception as e:
                    return self.redirect(self.flash_to("/settings", "err", as_app_error(e).user_message))
            if path == "/password":
                try:
                    set_password(db, s.user, f.get("password") or "", f"human:{s.user}")
                    return self.redirect(self.flash_to("/settings", "ok", "تغيّرت كلمة السر."))
                except Exception as e:
                    return self.redirect(self.flash_to("/settings", "err", as_app_error(e).user_message))
            m = re.fullmatch(r"/alerts/([^/]+)/ack", path)
            if m:
                acknowledge_alert(app, unquote(m.group(1)), s.user)
                return self.redirect("/")
            raise AppError("NOT_FOUND", path)

        if path == "/":
            return self.page(s, "ما يحتاجك الآن", self.dashboard(s), query)
        m = re.fullmatch(r"/p/([^/]+)", path)
        if m:
            ref = unquote(m.group(1))
            return self.page(s, f"التوقع {ref}", self.prediction_page(s, ref), query)
        m = re.fullmatch(r"/d/([^/]+)", path)
        if m:
            ref = unquote(m.group(1))
            return self.page(s, f"الفارق {ref}", self.discrepancy_page(s, ref), query)
        m = re.fullmatch(r"/a/([^/]+)", path)
        if m:
            ref = unquote(m.group(1))
            return self.page(s, f"مسودة الفعل {ref}", self.action_page(s, ref), query)
        if path == "/outcomes":
            return self.page(s, "إدخال المقياس الفعلي بعد الولادة", self.outcomes_page(s), query)
        if path == "/drafts":
            return self.page(s, "المسودات (لا شيء منها يُنفَّذ)", self.drafts_page(), query)
        if path == "/metrics":
            return self.page(s, "مؤشرات النجاح", self.metrics_page(query)
                             + '<p>تصدير: <a href="/export/predictions.csv">التوقعات</a> · <a href="/export/outcomes.csv">المقاييس</a> · <a href="/export/discrepancies.csv">المقارنات</a></p>', query)
        if path == "/audit":
            return self.page(s, "سجل التدقيق", self.audit_page(query), query)
        if path == "/hitl-log":
            return self.page(s, "سجل قرارات الإنسان", self.hitl_log_page(), query)
        if path == "/settings":
            return self.page(s, "الإعدادات", self.settings_page(s), query)
        m = re.fullmatch(r"/export/(predictions|outcomes|discrepancies)\.csv", path)
        if m:
            return self.export_csv(m.group(1))
        raise AppError("NOT_FOUND", path)

    async def dispatch(self, req: Request) -> Response:
        try:
            return await self.handle(req)
        except Exception as e:
            err = as_app_error(e)
            if err.status >= 500:
                log_server_error(f"{req.method} {req.target}", e, self.app.tracer.scrub)
            if err.code == "CSRF":
                return self.send(403, layout(title="انتهت صلاحية النموذج", body=f'<p>{esc(err.user_message)}</p><p><a href="/">الرئيسية</a></p>'))
            return self.send(err.status, layout(title="تعذّر إكمال الطلب", body=f'<p>{esc(err.user_message)}</p><p><a href="/">الرئيسية</a></p>'))


def _make_handler(web: "WebServer") -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "AGENTE"
        sys_version = ""

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 — لا سجل وصول (المسارات تحمل مراجع)
            pass

        def _serve(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            too_large = length > BODY_LIMIT
            body = b"" if too_large else (self.rfile.read(length) if length > 0 else b"")
            if too_large:
                self.close_connection = True
            req = Request(method=self.command, target=self.path, headers={k.lower(): v for k, v in self.headers.items()},
                          body=body, remote=self.client_address[0] if self.client_address else "?", body_too_large=too_large)
            res = web.run(web.webapp.dispatch(req))
            self.send_response(res.status)
            for k, v in res.headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(res.body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(res.body)

        do_GET = _serve
        do_POST = _serve
        do_HEAD = _serve

    return Handler


class WebServer:
    """الخادم + حلقة asyncio الخاصة بالتطبيق (في خيط مخصص)"""

    def __init__(self, app: AppContext, host: str | None = None, port: int | None = None):
        self.app = app
        self.webapp = WebApp(app)
        self.loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self.loop.run_forever, name="agente-loop", daemon=True)
        self._loop_thread.start()
        cfg = app.cfg["server"]
        self.server = ThreadingHTTPServer((cfg["host"] if host is None else host, cfg["port"] if port is None else port), _make_handler(self))
        self.server.daemon_threads = True
        if self.webapp.secure:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(resolve_path(app.cfg, cfg["tls_cert"]), resolve_path(app.cfg, cfg["tls_key"]))
            self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
        self._serve_thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    @property
    def background(self) -> set[asyncio.Future[Any]]:
        return self.webapp.background

    def run(self, coro: Awaitable[Any]) -> Any:
        """ينفّذ coroutine على حلقة التطبيق وينتظر نتيجته (من أي خيط)"""
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result()  # type: ignore[arg-type]

    def start(self) -> "WebServer":
        self._serve_thread = threading.Thread(target=self.server.serve_forever, name="agente-http", daemon=True)
        self._serve_thread.start()
        return self

    def serve_forever(self) -> None:
        self.server.serve_forever()

    def settle(self) -> None:
        """ينتظر المتابعات الجارية في الخلفية (للاختبارات)"""
        async def wait() -> None:
            while self.webapp.background:
                await asyncio.gather(*list(self.webapp.background), return_exceptions=True)
        self.run(wait())

    def close(self) -> None:
        if self._serve_thread:
            self.server.shutdown()
        self.server.server_close()

        async def cancel_all() -> None:
            tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        try:
            asyncio.run_coroutine_threadsafe(cancel_all(), self.loop).result(timeout=5)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._loop_thread.join(timeout=5)


def create_server(app: AppContext, host: str | None = None, port: int | None = None) -> WebServer:
    return WebServer(app, host, port)
