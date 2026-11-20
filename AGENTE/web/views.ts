/**
 * صفحات الواجهة الداخلية (DEC-16 أ) — عربية RTL (BASE-9). كل نص يمر بـ esc(): لا HTML خام من النموذج أو البيانات.
 * بلا JavaScript: نماذج وأزرار فقط (قرار مهيكل حصراً — لا نص حر كقرار).
 */
export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]!));

const CLASS_AR: Record<string, string> = { low: "منخفضة", medium: "متوسطة", high: "عالية (حرجة)" };
export const classBadge = (c: string | null | undefined) =>
  c ? `<span class="badge ${esc(c)}">${esc(CLASS_AR[c] ?? c)}</span>` : `<span class="badge none">—</span>`;

const STATUS_AR: Record<string, string> = {
  draft: "بانتظار قرارك", approved: "معتمد", modified: "معدَّل ومعتمد", rejected: "مرفوض",
  active: "نشطة", pending: "بانتظار موافقتك", superseded: "استُبدلت",
  running: "جارية", awaiting_hitl1: "بانتظار HITL-1", failed: "فشلت", stopped: "أوقفت",
};
export const statusAr = (s: string) => esc(STATUS_AR[s] ?? s);

/** تاريخ ووقت بصيغة عربية واضحة بأرقام لاتينية (لا لبس في الأرقام بين الأجهزة) */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return esc(d.toLocaleString("ar", { numberingSystem: "latn", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }));
}

export interface Banner { kind: "danger" | "warn" | "info"; text: string }

export function layout(o: { title: string; user?: string; csrf?: string; banners?: Banner[]; body: string; flash?: { kind: "ok" | "err"; text: string } | null }): string {
  const nav = o.user ? `
  <nav>
    <a href="/">الرئيسية</a>
    <a href="/outcomes">إدخال المقياس</a>
    <a href="/drafts">المسودات</a>
    <a href="/metrics">المؤشرات</a>
    <a href="/audit">سجل التدقيق</a>
    <a href="/hitl-log">سجل القرارات</a>
    <a href="/settings">الإعدادات</a>
    <form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button class="link">خروج (${esc(o.user)})</button></form>
  </nav>` : "";
  const banners = (o.banners || []).map((b) => `<div class="banner ${b.kind}">${esc(b.text)}</div>`).join("");
  const flash = o.flash ? `<div class="flash ${o.flash.kind}">${esc(o.flash.text)}</div>` : "";
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} — AGENTE</title><link rel="stylesheet" href="/static/app.css"></head>
<body><header><strong>AGENTE</strong> <span class="muted">توقع الخدج القادمين — الوكيل يقترح والإنسان يقرر</span></header>
${nav}${banners}<main>${flash}<h1>${esc(o.title)}</h1>${o.body}</main></body></html>`;
}

export const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

export function table(headers: string[], rows: string[][], empty = "لا شيء هنا الآن."): string {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export const CSS = `
:root{--bg:#f6f7fb;--card:#fff;--ink:#141a33;--muted:#5b6480;--line:#dfe3ee;--brand:#3730a3;--danger:#b91c1c;--warn:#92400e;--ok:#166534}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,"Segoe UI",Tahoma,"Noto Sans Arabic",sans-serif}
header{background:var(--brand);color:#fff;padding:10px 18px}header .muted{color:#e0e7ff}
nav{display:flex;flex-wrap:wrap;gap:4px 14px;padding:8px 18px;background:#fff;border-bottom:1px solid var(--line)}
nav a{color:var(--brand);text-decoration:none;font-weight:600}main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:6px 0 14px}h2{font-size:17px;margin:20px 0 8px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.stat{font-size:28px;font-weight:700}.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:#fff}th,td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:right;vertical-align:top}
th{background:#eef0f7;font-size:13px;color:#2c3557}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:13px;font-weight:600;border:1px solid}
.badge.low{color:var(--ok);border-color:#86efac;background:#f0fdf4}.badge.medium{color:var(--warn);border-color:#fcd34d;background:#fffbeb}
.badge.high{color:#fff;border-color:var(--danger);background:var(--danger)}.badge.none{color:var(--muted);border-color:var(--line)}
.banner{padding:10px 18px;font-weight:600}.banner.danger{background:#fee2e2;color:var(--danger)}.banner.warn{background:#fef3c7;color:var(--warn)}.banner.info{background:#e0e7ff;color:#1e1b4b}
.flash{padding:10px 12px;border-radius:8px;margin-bottom:12px;font-weight:600}.flash.ok{background:#dcfce7;color:var(--ok)}.flash.err{background:#fee2e2;color:var(--danger)}
.data{background:#f8fafc;border:1px dashed #94a3b8;border-radius:8px;padding:8px;white-space:pre-wrap;font-size:14px}
.flag{color:var(--danger);font-weight:700;font-size:13px}
label{display:block;font-weight:600;margin:8px 0 4px}input,select,textarea{font:inherit;padding:7px 9px;border:1px solid #b8bfd3;border-radius:7px;background:#fff;color:var(--ink);max-width:100%}
textarea{width:100%;min-height:70px}button{font:inherit;font-weight:700;padding:8px 16px;border-radius:8px;border:1px solid var(--brand);background:var(--brand);color:#fff;cursor:pointer}
button.secondary{background:#fff;color:var(--brand)}button.danger{background:var(--danger);border-color:var(--danger)}button.link{background:none;border:none;color:var(--danger);padding:0;font-weight:600}
form.inline{display:inline}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:10px}
fieldset{border:1px solid var(--line);border-radius:8px;padding:10px;margin:10px 0}legend{font-weight:700;padding:0 6px}
.radio{display:flex;gap:16px;flex-wrap:wrap}.radio label{font-weight:500;display:flex;gap:6px;align-items:center;margin:0}
@media (max-width:640px){main{padding:10px}.stat{font-size:22px}}
`;
