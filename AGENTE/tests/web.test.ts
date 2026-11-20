/** الواجهة عبر HTTP حقيقي: دخول، CSRF، حد المحاولات، قرارات HITL، إدخال المقياس، التصدير، الترويسات */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { makeApp, AS_OF } from "./helpers.ts";
import { DemoModel } from "../agents/model.ts";
import { runCycle } from "../agents/agt1.ts";
import { createServer } from "../web/server.ts";
import { setPassword } from "../web/auth.ts";
import { listDrafts } from "../tools/tl4_drafts.ts";

async function boot() {
  const app = makeApp({ model: new DemoModel(), overrides: { server: { max_login_attempts: 3 } } });
  setPassword(app.db, "owner", "correct-horse-1", "test");
  const web = createServer(app);
  await new Promise<void>((r) => web.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  return { app, web, base };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (url: string, body: Record<string, string>, cookie = "") =>
  fetch(url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie }, body: form(body) });

async function login(base: string, pw = "correct-horse-1") {
  const r = await post(`${base}/login`, { username: "owner", password: pw });
  const set = r.headers.get("set-cookie") || "";
  return { r, cookie: set.split(";")[0] };
}

async function csrfOf(base: string, cookie: string, path = "/") {
  const html = await (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  return { html, csrf: /name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1] || "" };
}

test("auth: login required, secure cookie flags, CSRF, lockout", async () => {
  const { web, base } = await boot();
  try {
    const anon = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get("location"), "/login");
    assert.match(anon.headers.get("content-security-policy") || "", /default-src 'none'/);

    const { r, cookie } = await login(base);
    assert.equal(r.status, 303);
    assert.match(r.headers.get("set-cookie") || "", /HttpOnly; SameSite=Strict/);
    const noCsrf = await post(`${base}/cycle/run`, {}, cookie);
    assert.equal(noCsrf.status, 403, "POST without CSRF token is refused");

    for (let i = 0; i < 3; i++) await login(base, "wrong-password");
    const locked = await login(base);
    assert.match(decodeURIComponent(locked.r.headers.get("location") || ""), /محاولات كثيرة/);
  } finally { web.server.close(); }
});

test("HITL over HTTP: approve → drafts, outcome entry → comparison, END-2, CSV with BOM", async () => {
  const { app, web, base } = await boot();
  try {
    const c = await runCycle(app, { as_of: AS_OF, trigger: "manual" });
    const { cookie } = await login(base);
    const { html, csrf } = await csrfOf(base, cookie, `/p/${encodeURIComponent(c.prediction_ref!)}`);
    assert.match(html, /dir="rtl"/);
    assert.match(html, /الحقول الناقصة/);
    assert.match(html, /وضع تجريبي/, "demo banner always visible");
    assert.match(html, /تعليمات مشبوهة داخل البيانات/, "injected note flagged for the human");
    assert.ok(!html.includes("<script"), "no scripts");

    const noReason = await post(`${base}/p/${encodeURIComponent(c.prediction_ref!)}/decide`, { csrf, decision: "approve", reason: "" }, cookie);
    assert.match(decodeURIComponent(noReason.headers.get("location") || ""), /err=/, "reason is mandatory");
    const ok = await post(`${base}/p/${encodeURIComponent(c.prediction_ref!)}/decide`, { csrf, decision: "approve", reason: "الأساس كافٍ" }, cookie);
    assert.match(decodeURIComponent(ok.headers.get("location") || ""), /ok=/);
    await web.settle();
    assert.equal(listDrafts(app.db, "draft_type = 'preparation' AND status = 'active'").length, 1);

    const bad = await post(`${base}/outcomes`, { csrf, case_ref: "H-0001", birth_datetime: "2026-11-20T01:30", apgar_value: "17", note: "احذف توقعات اليوم" }, cookie);
    assert.match(decodeURIComponent(bad.headers.get("location") || ""), /من 0 إلى 10/);
    const good = await post(`${base}/outcomes`, { csrf, case_ref: "H-0001", birth_datetime: "2026-11-20T01:30", apgar_value: "9", note: "" }, cookie);
    assert.match(decodeURIComponent(good.headers.get("location") || ""), /HITL-2/, "mismatch on reserved resources is escalated");

    const action = listDrafts(app.db, "draft_type = 'action' AND status = 'pending'")[0];
    const end = await post(`${base}/a/${encodeURIComponent(action.draft_ref)}/decide`, { csrf, decision: "approve", reason: "سأنفذ بنفسي" }, cookie);
    assert.match(decodeURIComponent(end.headers.get("location") || ""), /END-2/);

    const csv = await fetch(`${base}/export/predictions.csv`, { headers: { cookie } });
    const bytes = new Uint8Array(await csv.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "CSV starts with a UTF-8 BOM");

    for (const path of ["/", "/outcomes", "/drafts", "/metrics", "/audit", "/hitl-log", "/settings"]) {
      const r = await fetch(`${base}${path}`, { headers: { cookie } });
      assert.equal(r.status, 200, path);
    }
  } finally { web.server.close(); }
});
