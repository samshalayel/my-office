/**
 * خادم الواجهة الداخلية (DEC-16 أ) على node:http/https — بلا إطار ولا مكتبات.
 * داخل شبكة المشفى (DEC-14 أ): يستمع على host من الإعدادات، و HTTPS إن ضُبطت الشهادة (BASE-11).
 * الأمان: جلسة + CSRF لكل POST، ترويسات أمان و CSP صارمة (لا سكربتات)، هروب كل مخرج، رسائل خطأ مفهومة بلا تفاصيل تقنية (BASE-10).
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import type { AppContext } from "../agents/context.ts";
import { runCycle, compareOutcome, evalStatus, modelFor, openEscalations } from "../agents/agt1.ts";
import { loadPrompt } from "../agents/prompts.ts";
import { resolvePath } from "../config/config.ts";
import { AppError, asAppError, logServerError } from "../observability/errors.ts";
import { newRunId } from "../observability/trace.ts";
import { readControls, setControls, TOOL_NAMES } from "../guards/killswitch.ts";
import { invoke } from "../tools/registry.ts";
import { TL3_RECORD, listDiscrepancies } from "../tools/tl3_outcomes.ts";
import { listPredictions, getPrediction } from "../tools/tl2_predictions.ts";
import { listDrafts } from "../tools/tl4_drafts.ts";
import { packageC5, packageC6, packageC7, decideHitl1, decideHitl2, decideHitl3, decisionFor, c9For, type HumanEdit } from "../hitl/decisions.ts";
import { openAlerts, acknowledgeAlert } from "../hitl/alerts.ts";
import { computeMetrics } from "../hitl/metrics.ts";
import { Auth, type Session, setPassword } from "./auth.ts";
import { layout, esc, table, classBadge, statusAr, fmtDate, csrfField, CSS, type Banner } from "./views.ts";

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
type Form = Record<string, string>;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function readBody(req: Req, limit = 64 * 1024): Promise<Form> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new AppError("BAD_REQUEST", "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const out: Form = {};
      for (const [k, v] of params) out[k] = v;
      resolve(out);
    });
    req.on("error", reject);
  });
}

function cookies(req: Req): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** CSV بصيغة UTF-8 مع BOM (يفتح في Excel بالعربي)، وحماية من حقن الصيغ */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function createServer(app: AppContext) {
  const { cfg, db } = app;
  const auth = new Auth(db, cfg.server);
  const secure = Boolean(cfg.server.tls_cert && cfg.server.tls_key);
  /** متابعات تعمل في الخلفية بعد القرار (التحضير، دورة جديدة) — تُنتظر في الاختبارات */
  const background = new Set<Promise<unknown>>();
  const track = (p?: Promise<unknown>) => {
    if (!p) return;
    const w = p.catch((e) => logServerError("background", e, (s) => app.tracer.scrub(s))).finally(() => background.delete(w));
    background.add(w);
  };
  let cycleRunning = false;

  function send(res: Res, status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  }
  const redirect = (res: Res, to: string, extra: Record<string, string | string[]> = {}) => {
    res.writeHead(303, { ...SECURITY_HEADERS, Location: to, ...extra });
    res.end();
  };
  const flashTo = (path: string, kind: "ok" | "err", text: string) => `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(text)}`;

  function banners(): Banner[] {
    const out: Banner[] = [];
    const c = readControls(cfg);
    if (c.enabled) out.push({ kind: "danger", text: "مفتاح الإيقاف مفعّل: الوكيل والأدوات متوقفة. أعد التشغيل من الإعدادات." });
    else if (c.disabled_tools.length) out.push({ kind: "warn", text: `أدوات موقوفة: ${c.disabled_tools.join("، ")}` });
    const model = modelFor(app);
    if (model.kind === "demo") out.push({ kind: "danger", text: "وضع تجريبي: «التوقعات» من قاعدة ثابتة لا من نموذج — للتجربة فقط، لا تُستخدم لأي قرار." });
    try {
      const ev = evalStatus(app, model, loadPrompt(cfg, "AGT-1").version);
      if (!ev.ok) out.push({ kind: "warn", text: `الوكيل لن يعمل قبل تقييم ناجح للنموذج الحالي (${ev.reason}) — شغّل: npm run eval:live` });
    } catch { /* الإعدادات تظهر في صفحتها */ }
    return out;
  }

  function page(res: Res, s: Session | null, title: string, body: string, url?: URL, status = 200) {
    const flash = url?.searchParams.get("ok") ? { kind: "ok" as const, text: url.searchParams.get("ok")! }
      : url?.searchParams.get("err") ? { kind: "err" as const, text: url.searchParams.get("err")! } : null;
    send(res, status, layout({ title, user: s?.user, csrf: s?.csrf, banners: s ? banners() : [], body, flash }));
  }

  // ── الصفحات ──────────────────────────────────────────────────────────────
  function dashboard(s: Session): string {
    const alerts = openAlerts(app);
    const pending = listPredictions(db, "status = 'draft'");
    const esc2 = openEscalations(app);
    const actions = listDrafts(db, "draft_type = 'action' AND status = 'pending'");
    const cycles = db.prepare("SELECT * FROM cycles ORDER BY started_at DESC LIMIT 8").all() as Record<string, string>[];
    const now = Date.now();
    return `
<div class="grid">
  <div class="card"><div class="muted">توقعات بانتظار قرارك (HITL-1)</div><div class="stat">${pending.length}</div></div>
  <div class="card"><div class="muted">خلافات بانتظار قرارك (HITL-2)</div><div class="stat">${esc2.length}</div></div>
  <div class="card"><div class="muted">أفعال بانتظار موافقتك (HITL-3)</div><div class="stat">${actions.length}</div></div>
</div>
<h2>تنبيهات مفتوحة</h2>
${table(["النوع", "الرسالة", "منذ", ""], alerts.map((a) => [
    a.kind === "critical" ? classBadge("high") : esc(a.kind), esc(a.message), fmtDate(a.created_at),
    `<form method="post" action="/alerts/${esc(a.alert_id)}/ack" class="inline">${csrfField(s.csrf)}<button class="secondary">إقرار</button></form>`,
  ]), "لا تنبيهات مفتوحة.")}
<h2>توقعات بانتظار قرارك</h2>
${table(["التوقع", "الدورة", "العدد", "أعلى فئة", "الموعد", ""], pending.map((p) => [
    esc(p.prediction_ref), esc(p.cycle_id), esc(p.count_value), classBadge(p.risk_class),
    p.batch_deadline && Date.parse(p.batch_deadline) < now ? `<span class="flag">تأخر: ${fmtDate(p.batch_deadline)}</span>` : fmtDate(p.batch_deadline),
    `<a href="/p/${encodeURIComponent(p.prediction_ref)}">راجع وقرر</a>`,
  ]))}
<h2>خلافات بانتظار قرارك</h2>
${table(["الفارق", "التوقع", "المقياس", ""], esc2.map((d) => [esc(d.discrepancy_ref), esc(d.prediction_ref), esc(d.actual_ref), `<a href="/d/${encodeURIComponent(d.discrepancy_ref)}">راجع وقرر</a>`]))}
<h2>أفعال بانتظار موافقتك</h2>
${table(["المسودة", "النوع", "الملخص", ""], actions.map((a) => [esc(a.draft_ref), esc(a.action_kind), esc(a.payload?.summary), `<a href="/a/${encodeURIComponent(a.draft_ref)}">راجع وقرر</a>`]))}
<h2>الدورات</h2>
<form method="post" action="/cycle/run" class="actions">${csrfField(s.csrf)}<button>${cycleRunning ? "دورة جارية…" : "شغّل دورة التوقع الآن"}</button>
<span class="muted">الدورة اليومية تعمل تلقائياً الساعة ${esc(cfg.schedule.daily_cycle_time)}.</span></form>
${table(["الدورة", "الحالة", "البداية", "الخطأ"], cycles.map((c) => [esc(c.cycle_id), statusAr(c.status), fmtDate(c.started_at), esc(c.error_code ?? "")]))}`;
  }

  function predictionPage(s: Session, ref: string): string {
    const { c5, prediction: p, basis, cases } = packageC5(app, ref);
    const dec = decisionFor(db, "HITL-1", ref);
    const caseRows = cases.map(({ case: c, expected_infants, notes_flag }) => [
      esc(c.case_ref), esc(c.gestation_week), esc(expected_infants),
      Object.entries(c.indicators).map(([k, v]) => `${esc(k)}: ${v === null ? '<span class="flag">ناقص</span>' : esc(v)}`).join("<br>"),
      c.notes_raw ? `<div class="data">${esc(c.notes_raw)}</div>${notes_flag ? `<div class="flag">⚠ ${esc(notes_flag)}</div>` : ""}` : '<span class="muted">—</span>',
    ]);
    const infants = p.per_infant.map((i) => [esc(i.infant_ref), esc(i.apgar_value_estimate ?? "—"), classBadge(i.apgar_class), esc(i.basis_ref)]);
    const editRows = p.per_infant.map((i, n) => `
<tr><td>${esc(i.infant_ref)}<input type="hidden" name="inf_${n}_ref" value="${esc(i.infant_ref)}"></td>
<td><select name="inf_${n}_class">${["low", "medium", "high"].map((c) => `<option value="${c}"${c === i.apgar_class ? " selected" : ""}>${esc({ low: "منخفضة", medium: "متوسطة", high: "عالية" }[c])}</option>`).join("")}</select></td>
<td><input name="inf_${n}_est" type="number" min="0" max="10" step="1" value="${esc(i.apgar_value_estimate ?? "")}"></td>
<td><label><input type="checkbox" name="inf_${n}_keep" value="1" checked> متوقع وصوله</label></td></tr>`).join("");
    const form = p.status === "draft" ? `
<form method="post" action="/p/${encodeURIComponent(ref)}/decide" class="card">${csrfField(s.csrf)}
<fieldset><legend>قرارك (HITL-1)</legend><div class="radio">
<label><input type="radio" name="decision" value="approve" required> اعتماد</label>
<label><input type="radio" name="decision" value="modify"> تعديل ثم اعتماد</label>
<label><input type="radio" name="decision" value="reject"> رفض</label></div>
<label for="reason">السبب (إلزامي)</label><textarea id="reason" name="reason" required minlength="3" maxlength="1000"></textarea></fieldset>
<fieldset><legend>التعديل (يُستخدم فقط إن اخترت «تعديل»)</legend>
<div class="scroll"><table><thead><tr><th>الطفل</th><th>الفئة</th><th>تقدير Apgar</th><th></th></tr></thead><tbody>${editRows}</tbody></table></div>
<input type="hidden" name="inf_count" value="${p.per_infant.length}"></fieldset>
<div class="actions"><button>سجّل القرار</button><span class="muted">لا شيء يُنفَّذ: الاعتماد يجهّز مسودة تحضير فقط.</span></div></form>`
      : `<div class="card"><strong>القرار:</strong> ${statusAr(p.status)}${dec ? ` — ${esc(dec.decided_by)} ${fmtDate(dec.decided_at)} — السبب: ${esc(dec.reason)}` : ""}</div>`;
    return `
<div class="card"><div class="grid">
  <div><div class="muted">الحالة</div><strong>${statusAr(p.status)}</strong></div>
  <div><div class="muted">العدد المتوقع</div><div class="stat">${esc(c5.count_value)}</div></div>
  <div><div class="muted">أعلى فئة</div>${classBadge(c5.risk_class)}${c5.critical_alert ? ' <span class="flag">تنبيه فوري</span>' : ""}</div>
  <div><div class="muted">الثقة</div>${basis.confidence_flag === "low" ? '<span class="flag">منخفضة — بيانات ناقصة أو أساس ضعيف</span>' : "عادية"}</div>
</div></div>
<h2>الأساس (من سجلات المشفى فقط: ${esc(basis.sources.join("، "))})</h2><div class="card data">${esc(basis.weighting_note)}</div>
<h2>الحقول الناقصة (لم تُملأ)</h2>${c5.missing_fields.length ? `<div class="card">${c5.missing_fields.map((f) => `<span class="badge none">${esc(f)}</span>`).join(" ")}</div>` : '<p class="muted">لا نواقص.</p>'}
<h2>الأطفال المتوقعون</h2>${table(["الطفل", "تقدير Apgar", "الفئة", "أساس التقدير"], infants)}
<h2>الحالات كما وردت من المصدر (بيانات لا تعليمات)</h2>${table(["الحالة", "أسبوع الحمل", "الأجنّة", "المؤشرات", "ملاحظات المصدر"], caseRows)}
${form}<p class="muted">النموذج: ${esc(p.model ?? "إنسان")} · التعليمات: ${esc(p.prompt_version ?? "—")} · تشغيل: ${esc(p.run_id)}</p>`;
  }

  function editFrom(f: Form): HumanEdit {
    const n = Math.min(Number(f.inf_count) || 0, 200);
    const per_infant = [];
    for (let i = 0; i < n; i++) {
      const est = (f[`inf_${i}_est`] ?? "").trim();
      if (est !== "" && !/^\d{1,2}$/.test(est)) throw new AppError("REJECTED_RANGE", "estimate", "تقدير Apgar عدد صحيح من 0 إلى 10.");
      per_infant.push({ infant_ref: f[`inf_${i}_ref`] ?? "", apgar_class: f[`inf_${i}_class`] ?? "", apgar_value_estimate: est === "" ? null : Number(est), keep: f[`inf_${i}_keep`] === "1" });
    }
    return { per_infant, note: (f.reason || "").slice(0, 300) };
  }

  function discrepancyPage(s: Session, ref: string): string {
    const { c6, discrepancy: d, outcome: o, reserved, prediction } = packageC6(app, ref);
    const dec = decisionFor(db, "HITL-2", ref);
    const editRows = prediction ? prediction.per_infant.map((i, n) => `
<tr><td>${esc(i.infant_ref)}<input type="hidden" name="inf_${n}_ref" value="${esc(i.infant_ref)}"></td>
<td><select name="inf_${n}_class">${["low", "medium", "high"].map((c) => `<option value="${c}"${c === i.apgar_class ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></td>
<td><input name="inf_${n}_est" type="number" min="0" max="10" value="${esc(i.apgar_value_estimate ?? "")}"></td>
<td><label><input type="checkbox" name="inf_${n}_keep" value="1" checked> باقٍ</label></td></tr>`).join("") : "";
    const form = d.escalated && !dec ? `
<form method="post" action="/d/${encodeURIComponent(ref)}/decide" class="card">${csrfField(s.csrf)}
<fieldset><legend>قرارك (HITL-2)</legend><div class="radio">
<label><input type="radio" name="decision" value="approve" required> إبقاء التوزيع</label>
<label><input type="radio" name="decision" value="modify"> تعديل التوزيع</label>
<label><input type="radio" name="decision" value="reject"> إعادة تقييم (دورة جديدة)</label></div>
<label for="reason">السبب (إلزامي — خصوصاً عند الإبقاء)</label><textarea id="reason" name="reason" required minlength="3"></textarea></fieldset>
${prediction ? `<fieldset><legend>تعديل التوزيع (عند اختيار «تعديل»)</legend><div class="scroll"><table><thead><tr><th>الطفل</th><th>الفئة</th><th>Apgar</th><th></th></tr></thead><tbody>${editRows}</tbody></table></div>
<input type="hidden" name="inf_count" value="${prediction.per_infant.length}"></fieldset>` : ""}
<div class="actions"><button>سجّل القرار</button></div></form>`
      : dec ? `<div class="card"><strong>القرار:</strong> ${esc(dec.decision)} — ${esc(dec.decided_by)} ${fmtDate(dec.decided_at)} — ${esc(dec.reason)}</div>`
      : `<div class="card muted">هذا الفارق مسجَّل فقط (لا موارد محجوزة — لا يحتاج قرار HITL-2).</div>`;
    return `
<div class="card"><div class="grid">
  <div><div class="muted">التوقع</div><strong>${esc(c6.prediction_ref)}</strong></div>
  <div><div class="muted">الفئة المتوقعة للطفل ${esc(d.infant_ref ?? "")}</div>${classBadge(d.predicted?.infant_class ?? null)}</div>
  <div><div class="muted">الفعلي (Apgar ${esc(o.apgar_value)})</div>${classBadge(o.apgar_class)}</div>
  <div><div class="muted">موارد محجوزة</div><strong>${d.resources_reserved ? "نعم" : "لا"}</strong></div>
</div></div>
${reserved.length ? `<h2>الموارد المحجوزة</h2>${table(["المسودة", "البنود"], reserved.map((r) => [esc(r.draft_ref), esc((r.items || []).map((i) => `${i.item}${i.qty !== undefined ? ` × ${i.qty}` : ""}`).join("، "))]))}` : ""}
${o.note ? `<h2>ملاحظة الإدخال (نص فقط)</h2><div class="data card">${esc(o.note)}</div>` : ""}
${form}`;
  }

  function actionPage(s: Session, ref: string): string {
    const { c7, draft, prediction } = packageC7(app, ref);
    const c9 = c9For(db, ref);
    const form = draft.status === "pending" ? `
<form method="post" action="/a/${encodeURIComponent(ref)}/decide" class="card">${csrfField(s.csrf)}
<fieldset><legend>قرارك (HITL-3)</legend><div class="radio">
<label><input type="radio" name="decision" value="approve" required> موافقة — أنا أنفّذ خارج النظام (END-2)</label>
<label><input type="radio" name="decision" value="reject"> رفض — لا تنفيذ (END-1)</label></div>
<label for="reason">السبب (إلزامي)</label><textarea id="reason" name="reason" required minlength="3"></textarea></fieldset>
<div class="actions"><button>سجّل القرار</button><span class="muted">النظام لا ينفّذ أي فعل؛ الموافقة تُسجَّل وتنقل التنفيذ إليك.</span></div></form>`
      : `<div class="card"><strong>${c9?.outcome === "END_2_HUMAN_EXECUTES" ? "END-2: التنفيذ بيد الإنسان خارج النظام" : "END-1: لا تنفيذ"}</strong> — ${esc(c9?.decided_by)} ${fmtDate(c9?.decided_at)}</div>`;
    return `
<div class="card"><div class="grid">
  <div><div class="muted">النوع</div><strong>${esc(c7.kind)}</strong></div>
  <div><div class="muted">مبني على التوقع المعتمد</div><a href="/p/${encodeURIComponent(c7.based_on)}">${esc(c7.based_on)}</a> ${classBadge(prediction?.risk_class)}</div>
  <div><div class="muted">الحالة</div>${statusAr(draft.status)}</div>
</div></div>
<h2>الملخص</h2><div class="card data">${esc(c7.payload_summary)}</div>
<h2>المبرر</h2><div class="card data">${esc(draft.payload?.justification)}</div>
<h2>الأطفال المعنيون</h2><p>${(draft.payload?.infant_refs || []).map((r) => esc(r)).join("، ")}</p>
${c7.alternatives.length ? `<h2>البدائل</h2><ul>${c7.alternatives.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
${form}`;
  }

  function outcomesPage(s: Session): string {
    const refs = db.prepare("SELECT DISTINCT case_ref FROM cycle_cases ORDER BY case_ref").all() as { case_ref: string }[];
    const rows = db.prepare("SELECT o.*, d.discrepancy_ref, d.class_mismatch, d.escalated FROM outcomes o LEFT JOIN discrepancies d ON d.actual_ref = o.actual_ref ORDER BY o.stored_at DESC LIMIT 100").all() as Record<string, string | number>[];
    return `
<form method="post" action="/outcomes" class="card">${csrfField(s.csrf)}
<p class="muted">نقطة الإدخال الوحيدة للمقياس الفعلي (TB-2). القيمة خارج 0..10 تُرفض ولا تُصحَّح. الملاحظة نص فقط.</p>
<label for="case_ref">الحالة</label><select id="case_ref" name="case_ref" required>${refs.map((r) => `<option>${esc(r.case_ref)}</option>`).join("")}</select>
<label for="birth_datetime">وقت الولادة</label><input id="birth_datetime" name="birth_datetime" type="datetime-local" required>
<label for="apgar_value">مقياس Apgar (0–10)</label><input id="apgar_value" name="apgar_value" inputmode="numeric" pattern="\\d{1,2}" required>
<label for="note">ملاحظة (اختيارية)</label><textarea id="note" name="note" maxlength="500"></textarea>
<div class="actions"><button>سجّل المقياس</button></div></form>
<h2>آخر المقاييس والمقارنة</h2>
${table(["المقياس", "الحالة", "الولادة", "Apgar", "الفئة", "أدخله", "المقارنة"], rows.map((r) => [
    esc(r.actual_ref), esc(r.case_ref), fmtDate(String(r.birth_datetime)), esc(r.apgar_value), classBadge(String(r.apgar_class)), esc(r.entered_by),
    r.discrepancy_ref ? `<a href="/d/${encodeURIComponent(String(r.discrepancy_ref))}">${Number(r.class_mismatch) ? (Number(r.escalated) ? '<span class="flag">خلاف مصعَّد</span>' : "خلاف مسجَّل") : "مطابق"}</a>` : "—",
  ]))}`;
  }

  function draftsPage(): string {
    const d = listDrafts(db);
    return table(["المسودة", "النوع", "مبنية على", "المحتوى", "الحالة", "التاريخ"], d.map((x) => [
      x.draft_type === "action" ? `<a href="/a/${encodeURIComponent(x.draft_ref)}">${esc(x.draft_ref)}</a>` : esc(x.draft_ref),
      x.draft_type === "action" ? `فعل: ${esc(x.action_kind)}` : "تحضير",
      `<a href="/p/${encodeURIComponent(x.based_on)}">${esc(x.based_on)}</a>`,
      esc(x.draft_type === "action" ? x.payload?.summary : (x.items || []).map((i) => `${i.item}${i.qty !== undefined ? ` × ${i.qty}` : ""}`).join("، ")),
      statusAr(x.status), fmtDate(x.created_at),
    ]));
  }

  function metricsPage(url: URL): string {
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
    const m = computeMetrics(app, days);
    const verdict = (p: boolean | null) => (p === null ? '<span class="muted">لا بيانات كافية بعد</span>' : p ? '<span class="badge low">يحقق العتبة</span>' : '<span class="badge high">دون العتبة</span>');
    return `
<p class="muted">آخر ${esc(days)} يوماً · العتبات من قرارك DEC-3.</p>
<div class="grid">
 <div class="card"><div class="muted">مطابقة الفئة (≥${esc(m.class_match.threshold)}%)</div><div class="stat">${m.class_match.pct ?? "—"}%</div>${verdict(m.class_match.pass)}<div class="muted">${esc(m.class_match.matched)} من ${esc(m.class_match.compared)} مقارنة</div></div>
 <div class="card"><div class="muted">مطابقة العدد (≥${esc(m.count_match.threshold)}%)</div><div class="stat">${m.count_match.pct ?? "—"}%</div>${verdict(m.count_match.pass)}<div class="muted">${esc(m.count_match.cycles)} دورة انتهت نافذتها</div></div>
 <div class="card"><div class="muted">خلاف بلا تصعيد (يجب 0)</div><div class="stat">${esc(m.unescalated)}</div>${m.unescalated === 0 ? '<span class="badge low">سليم</span>' : '<span class="badge high">خلل</span>'}</div>
 <div class="card"><div class="muted">ولادات بلا توقع سابق</div><div class="stat">${esc(m.unplanned)}</div></div>
</div>
${table(["التوقع", "المتوقع", "الفعلي"], m.count_match.detail.map((d) => [esc(d.prediction_ref), esc(d.predicted), esc(d.actual)]))}`;
  }

  function auditPage(url: URL): string {
    const pageN = Math.max(Number(url.searchParams.get("page")) || 1, 1);
    const rows = db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT 100 OFFSET ?").all((pageN - 1) * 100) as Record<string, string>[];
    return table(["الرقم", "الوقت", "الفاعل", "الكيان", "المرجع", "الفعل", "السبب"], rows.map((r) => [esc(r.audit_id), fmtDate(r.ts), esc(r.actor), esc(r.entity), esc(r.ref), esc(r.action), esc(r.reason ?? "")]))
      + `<p><a href="/audit?page=${pageN + 1}">الأقدم ←</a></p>`;
  }

  function hitlLogPage(): string {
    const rows = db.prepare("SELECT * FROM hitl_log ORDER BY seq DESC LIMIT 200").all() as Record<string, string>[];
    return table(["الوقت", "النقطة", "الموضوع", "من قرر", "القرار", "السبب", "ماذا حدث بعدها"], rows.map((r) => [fmtDate(r.ts), esc(r.hitl), esc(r.subject_ref), esc(r.decided_by), esc(r.decision), esc(r.reason), esc(r.after_effect)]));
  }

  function settingsPage(s: Session): string {
    const c = readControls(cfg);
    const model = modelFor(app);
    return `
<form method="post" action="/settings/kill" class="card">${csrfField(s.csrf)}
<h2>مفتاح الإيقاف</h2><p class="muted">يعمل فوراً بلا نشر جديد. ${c.updated_at ? `آخر تغيير: ${esc(c.updated_by)} ${fmtDate(c.updated_at)}` : ""}</p>
<label><input type="checkbox" name="enabled" value="1"${c.enabled ? " checked" : ""}> إيقاف كل شيء (الوكيل وكل الأدوات)</label>
<p>أو أوقف أدوات بعينها:</p>${TOOL_NAMES.map((t) => `<label><input type="checkbox" name="tool_${t}" value="1"${c.disabled_tools.includes(t) ? " checked" : ""}> ${esc(t === "model" ? "استدعاء النموذج" : t)}</label>`).join("")}
<label for="kreason">السبب (إلزامي)</label><input id="kreason" name="reason" required minlength="3" style="width:100%">
<div class="actions"><button class="danger">احفظ حالة الإيقاف</button></div></form>
<div class="card"><h2>الإعدادات الحالية (للقراءة)</h2><div class="data">${esc(JSON.stringify({
      model: { provider: cfg.model.provider, model: model.modelId, fallback: cfg.model.fallback_model, key_env: cfg.model.api_key_env },
      caps: cfg.caps, window_days: cfg.window_days, thresholds: cfg.thresholds, schedule: cfg.schedule, source: { type: cfg.source.type, system: cfg.source.system_name },
    }, null, 2))}</div><p class="muted">التعديل في config/settings.local.json على الخادم — والأسرار في متغيرات البيئة فقط.</p></div>
<form method="post" action="/password" class="card">${csrfField(s.csrf)}<h2>تغيير كلمة السر</h2>
<label for="pw">كلمة السر الجديدة (10 أحرف على الأقل)</label><input id="pw" name="password" type="password" minlength="10" required autocomplete="new-password">
<div class="actions"><button class="secondary">غيّر كلمة السر</button></div></form>`;
  }

  function exportCsv(res: Res, what: string) {
    let csv: string;
    if (what === "predictions") {
      csv = toCsv(["prediction_ref", "cycle_id", "status", "count_value", "risk_class", "per_infant", "missing_fields", "confidence", "created_at"],
        listPredictions(db).map((p) => [p.prediction_ref, p.cycle_id, p.status, p.count_value, p.risk_class, p.per_infant.map((i) => `${i.infant_ref}:${i.apgar_class}`).join(" "), p.missing_fields.join(" "), p.basis.confidence_flag, p.created_at]));
    } else if (what === "outcomes") {
      csv = toCsv(["actual_ref", "case_ref", "birth_datetime", "apgar_value", "apgar_class", "entered_by", "stored_at"],
        (db.prepare("SELECT * FROM outcomes ORDER BY stored_at").all() as Record<string, unknown>[]).map((o) => [o.actual_ref, o.case_ref, o.birth_datetime, o.apgar_value, o.apgar_class, o.entered_by, o.stored_at]));
    } else if (what === "discrepancies") {
      csv = toCsv(["discrepancy_ref", "prediction_ref", "actual_ref", "infant_ref", "class_mismatch", "resources_reserved", "escalated", "created_at"],
        listDiscrepancies(db).map((d) => [d.discrepancy_ref, d.prediction_ref, d.actual_ref, d.infant_ref, d.class_mismatch, d.resources_reserved, d.escalated, d.created_at]));
    } else throw new AppError("NOT_FOUND", what);
    send(res, 200, csv, "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="agente-${what}.csv"` });
  }

  // ── التوجيه ───────────────────────────────────────────────────────────────
  async function handle(req: Req, res: Res): Promise<void> {
    const url = new URL(req.url || "/", "http://local");
    const path = url.pathname;
    const method = req.method || "GET";
    if (path === "/static/app.css") return send(res, 200, CSS, "text/css; charset=utf-8", { "Cache-Control": "max-age=3600" });
    if (path === "/healthz") return send(res, 200, "ok", "text/plain");
    const sid = cookies(req)["agente_sid"];
    const s = auth.get(sid);
    const cookieFlags = `HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;

    if (path === "/login") {
      if (method === "POST") {
        const f = await readBody(req, 4096);
        try {
          const ns = auth.login(String(req.socket.remoteAddress || "?"), f.username || "", f.password || "");
          return redirect(res, "/", { "Set-Cookie": `agente_sid=${ns.token}; ${cookieFlags}; Max-Age=${cfg.server.session_hours * 3600}` });
        } catch (e) {
          return redirect(res, flashTo("/login", "err", asAppError(e).userMessage));
        }
      }
      return page(res, null, "الدخول", `<form method="post" action="/login" class="card" autocomplete="on">
<label for="u">اسم المستخدم</label><input id="u" name="username" required autocomplete="username">
<label for="p">كلمة السر</label><input id="p" name="password" type="password" required autocomplete="current-password">
<div class="actions"><button>دخول</button></div></form>`, url);
    }
    if (!s) return redirect(res, "/login");

    if (method === "POST") {
      const f = await readBody(req);
      auth.checkCsrf(s, f.csrf);
      delete f.csrf;
      const ctxHuman = { app, run_id: newRunId("h"), actor: "human" as const, actorName: s.user };
      if (path === "/logout") { auth.logout(sid); return redirect(res, "/login", { "Set-Cookie": `agente_sid=; ${cookieFlags}; Max-Age=0` }); }
      if (path === "/cycle/run") {
        if (cycleRunning) return redirect(res, flashTo("/", "err", "دورة جارية الآن."));
        cycleRunning = true;
        track(runCycle(app, { trigger: "manual", actor: `human:${s.user}` }).finally(() => { cycleRunning = false; }));
        return redirect(res, flashTo("/", "ok", "بدأت دورة التوقع — حدّث الصفحة بعد قليل."));
      }
      let m = /^\/p\/([^/]+)\/decide$/.exec(path);
      if (m) {
        const ref = decodeURIComponent(m[1]);
        try {
          const r = decideHitl1(app, { prediction_ref: ref, decision: f.decision, reason: f.reason, edit: f.decision === "modify" ? editFrom(f) : undefined }, s.user);
          track(r.prepare);
          return redirect(res, flashTo(`/p/${encodeURIComponent(ref)}`, "ok", `سُجّل القرار ${r.decision_id}.`));
        } catch (e) { return redirect(res, flashTo(`/p/${encodeURIComponent(ref)}`, "err", asAppError(e).userMessage)); }
      }
      m = /^\/d\/([^/]+)\/decide$/.exec(path);
      if (m) {
        const ref = decodeURIComponent(m[1]);
        try {
          const r = decideHitl2(app, { discrepancy_ref: ref, decision: f.decision, reason: f.reason, edit: f.decision === "modify" ? editFrom(f) : undefined }, s.user);
          track(r.followup);
          return redirect(res, flashTo(`/d/${encodeURIComponent(ref)}`, "ok", `سُجّل القرار ${r.decision_id}.`));
        } catch (e) { return redirect(res, flashTo(`/d/${encodeURIComponent(ref)}`, "err", asAppError(e).userMessage)); }
      }
      m = /^\/a\/([^/]+)\/decide$/.exec(path);
      if (m) {
        const ref = decodeURIComponent(m[1]);
        try {
          const r = decideHitl3(app, { draft_ref: ref, decision: f.decision, reason: f.reason }, s.user);
          return redirect(res, flashTo(`/a/${encodeURIComponent(ref)}`, "ok", r.end_state === "END_2_HUMAN_EXECUTES" ? "سُجّلت الموافقة — التنفيذ بيدك خارج النظام (END-2)." : "سُجّل الرفض — لا تنفيذ (END-1)."));
        } catch (e) { return redirect(res, flashTo(`/a/${encodeURIComponent(ref)}`, "err", asAppError(e).userMessage)); }
      }
      if (path === "/outcomes") {
        try {
          const local = f.birth_datetime || "";
          const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? new Date(local).toISOString() : local;
          const r = await invoke(TL3_RECORD, ctxHuman, { case_ref: f.case_ref, birth_datetime: iso, apgar_value: f.apgar_value, note: f.note });
          const c = await compareOutcome(app, r.actual_ref);
          const msg = c.escalated ? `سُجّل ${r.actual_ref} — خلاف على موارد محجوزة، يحتاج قرارك (HITL-2).` : c.class_mismatch ? `سُجّل ${r.actual_ref} — خلاف مسجَّل.` : `سُجّل ${r.actual_ref} — مطابق للتوقع.`;
          return redirect(res, flashTo("/outcomes", "ok", msg));
        } catch (e) { return redirect(res, flashTo("/outcomes", "err", asAppError(e).userMessage)); }
      }
      if (path === "/settings/kill") {
        try {
          if (!f.reason || f.reason.trim().length < 3) throw new AppError("BAD_REQUEST", "reason", "السبب إلزامي.");
          setControls(cfg, db, { enabled: f.enabled === "1", disabled_tools: TOOL_NAMES.filter((t) => f[`tool_${t}`] === "1") }, `human:${s.user}`, f.reason.trim());
          return redirect(res, flashTo("/settings", "ok", "حُفظت حالة مفتاح الإيقاف."));
        } catch (e) { return redirect(res, flashTo("/settings", "err", asAppError(e).userMessage)); }
      }
      if (path === "/password") {
        try { setPassword(db, s.user, f.password || "", `human:${s.user}`); return redirect(res, flashTo("/settings", "ok", "تغيّرت كلمة السر.")); }
        catch (e) { return redirect(res, flashTo("/settings", "err", asAppError(e).userMessage)); }
      }
      m = /^\/alerts\/([^/]+)\/ack$/.exec(path);
      if (m) { acknowledgeAlert(app, decodeURIComponent(m[1]), s.user); return redirect(res, "/"); }
      throw new AppError("NOT_FOUND", path);
    }

    if (path === "/") return page(res, s, "ما يحتاجك الآن", dashboard(s), url);
    let m = /^\/p\/([^/]+)$/.exec(path);
    if (m) return page(res, s, `التوقع ${decodeURIComponent(m[1])}`, predictionPage(s, decodeURIComponent(m[1])), url);
    m = /^\/d\/([^/]+)$/.exec(path);
    if (m) return page(res, s, `الفارق ${decodeURIComponent(m[1])}`, discrepancyPage(s, decodeURIComponent(m[1])), url);
    m = /^\/a\/([^/]+)$/.exec(path);
    if (m) return page(res, s, `مسودة الفعل ${decodeURIComponent(m[1])}`, actionPage(s, decodeURIComponent(m[1])), url);
    if (path === "/outcomes") return page(res, s, "إدخال المقياس الفعلي بعد الولادة", outcomesPage(s), url);
    if (path === "/drafts") return page(res, s, "المسودات (لا شيء منها يُنفَّذ)", draftsPage(), url);
    if (path === "/metrics") return page(res, s, "مؤشرات النجاح", metricsPage(url) + `<p>تصدير: <a href="/export/predictions.csv">التوقعات</a> · <a href="/export/outcomes.csv">المقاييس</a> · <a href="/export/discrepancies.csv">المقارنات</a></p>`, url);
    if (path === "/audit") return page(res, s, "سجل التدقيق", auditPage(url), url);
    if (path === "/hitl-log") return page(res, s, "سجل قرارات الإنسان", hitlLogPage(), url);
    if (path === "/settings") return page(res, s, "الإعدادات", settingsPage(s), url);
    m = /^\/export\/(predictions|outcomes|discrepancies)\.csv$/.exec(path);
    if (m) return exportCsv(res, m[1]);
    throw new AppError("NOT_FOUND", path);
  }

  const handler = (req: Req, res: Res) => {
    handle(req, res).catch((e) => {
      const err = asAppError(e);
      if (err.status >= 500) logServerError(`${req.method} ${req.url}`, e, (x) => app.tracer.scrub(x));
      if (res.headersSent) { res.end(); return; }
      if (err.code === "CSRF") return send(res, 403, layout({ title: "انتهت صلاحية النموذج", body: `<p>${esc(err.userMessage)}</p><p><a href="/">الرئيسية</a></p>` }));
      send(res, err.status, layout({ title: "تعذّر إكمال الطلب", body: `<p>${esc(err.userMessage)}</p><p><a href="/">الرئيسية</a></p>` }));
    });
  };

  const server = secure
    ? https.createServer({ cert: fs.readFileSync(resolvePath(cfg, cfg.server.tls_cert)), key: fs.readFileSync(resolvePath(cfg, cfg.server.tls_key)) }, handler)
    : http.createServer(handler);
  return { server, auth, background, settle: () => Promise.all([...background]), getPrediction: (r: string) => getPrediction(db, r) };
}
