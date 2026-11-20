/**
 * TL-1 / C-1 — قراءة بيانات الحوامل من سجلات المشفى حصراً (BR-3 / K-5)، نافذة الأسبوع الأخير حصراً (BR-5).
 * المدخل { as_of, window_days } → المخرج { cases, source_system, fetched_at } — فشل: SOURCE_UNAVAILABLE.
 *
 * داخل الأداة نفسها (قبل أن يرى الوكيل أي شيء):
 *  - MIT-5: حذف حقول الهوية وإبدالها برقم مرجعي H-0001 (الخريطة محلية — C-15)، وحجب أي معرف في النص الحر
 *  - MIT-1: الملاحظات نص معزول؛ عبارات أوامر بداخلها تُعلَّم للإنسان ولا تُنفَّذ
 *  - EV-2: الحقل الناقص null — لا يُملأ
 *  - MIT-7 / RT-4: عدد حالات أو أجنّة يتجاوز السقف = توقف آمن وتصعيد، لا قص صامت
 * مصدر الإدخال في هذا الإصدار: ملف تصدير JSON/CSV يضعه نظام المشفى في data/inbox (DEV-3 — الربط الفعلي يحتاج قراراً).
 */
import fs from "node:fs";
import { resolvePath, type Config } from "../config/config.ts";
import { AppError } from "../observability/errors.ts";
import { tx, nowIso, writeAudit, randomRef } from "../storage/db.ts";
import { identityTokens, redactText, injectionFlag } from "../guards/pii.ts";
import { raiseAlert } from "../hitl/alerts.ts";
import { defineTool, actorLabel, type ToolCtx } from "./registry.ts";

export type IndicatorValue = number | string | null;

/** Case — S2 حرفياً */
export interface Case {
  case_ref: string;
  gestation_week: number;
  in_last_week_window: true;
  indicators: Record<string, IndicatorValue>;
  notes_raw: string | null;
}

export interface ReadResult { cases: Case[]; source_system: string; fetched_at: string }

export interface ReadInput { cycle_id: string; as_of: string; window_days: number }

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

export function readSourceRecords(cfg: Config): Record<string, unknown>[] {
  const file = resolvePath(cfg, cfg.source.path);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new AppError("SOURCE_UNAVAILABLE", `${cfg.source.type}: ${(e as NodeJS.ErrnoException).code || "read error"}`);
  }
  try {
    if (cfg.source.type === "csv_file") return parseCsv(raw);
    const j = JSON.parse(raw);
    const list = Array.isArray(j) ? j : Array.isArray(j?.records) ? j.records : null;
    if (!list) throw new Error("expected an array or {records: []}");
    return list.filter((r: unknown) => r && typeof r === "object") as Record<string, unknown>[];
  } catch (e) {
    throw new AppError("SOURCE_UNAVAILABLE", `parse: ${(e as Error).message}`, "ملف سجلات المشفى غير صالح — توقفت الدورة بلا توقع.");
  }
}

function normalize(v: unknown): IndicatorValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? "نعم" : "لا";
  const s = String(v).trim();
  if (s === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s.slice(0, 200);
}

function parseDate(v: unknown): number | null {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const t = Date.parse(String(v).trim().slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(t) ? null : t;
}

const DAY = 86_400_000;

export const TL1_READ = defineTool<ReadInput, ReadResult>({
  tool: "TL-1",
  op: "read_cases",
  actors: ["AGT-1", "system"],
  run(ctx: ToolCtx, input: ReadInput): ReadResult {
    const { cfg, db } = ctx.app;
    const f = cfg.source.fields;
    if (input.window_days !== cfg.window_days) throw new AppError("REJECTED_SCHEMA", `window_days=${input.window_days}`, `النافذة ${cfg.window_days} أيام حصراً (BR-5).`);
    const asOf = parseDate(input.as_of);
    if (asOf === null) throw new AppError("REJECTED_SCHEMA", "as_of", "تاريخ الدورة غير صالح.");

    const records = readSourceRecords(cfg);
    const excluded = { no_key: 0, no_edd: 0, bad_gestation: 0, bad_infants: 0 };
    const picked: { key: string; rec: Record<string, unknown>; gw: number; infants: number | null; ids: { strong: string[]; weak: string[] } }[] = [];
    for (const rec of records) {
      const key = String(rec[f.source_key] ?? "").trim();
      if (!key) { excluded.no_key++; continue; }
      const edd = parseDate(rec[f.expected_delivery_date]);
      if (edd === null) { excluded.no_edd++; continue; }
      if (edd < asOf || edd > asOf + input.window_days * DAY) continue; // خارج النافذة: ليس من الدورة
      const gw = Number(rec[f.gestation_week]);
      if (!Number.isFinite(gw) || gw < 20 || gw > 45) { excluded.bad_gestation++; continue; }
      const infRaw = normalize(rec[f.expected_infants]);
      let infants: number | null = null;
      if (infRaw !== null) {
        if (typeof infRaw !== "number" || !Number.isInteger(infRaw) || infRaw < 1) { excluded.bad_infants++; continue; }
        infants = infRaw;
      }
      picked.push({ key, rec, gw: Math.round(gw), infants, ids: identityTokens(f.identity.map((k) => rec[k])) });
    }
    if (picked.length > cfg.caps.max_cases_per_cycle) {
      throw new AppError("CAP_EXCEEDED", `cases=${picked.length} > ${cfg.caps.max_cases_per_cycle}`, `عدد الحالات (${picked.length}) يتجاوز سقف الدورة — توقف آمن وصُعّد للإنسان.`);
    }
    for (const p of picked) {
      for (const id of p.ids.strong) ctx.app.identities.add(id);
      for (const w of p.ids.weak) ctx.app.nameParts.add(w);
    }

    const fetchedAt = nowIso();
    const cases: Case[] = tx(db, () => {
      const out: Case[] = [];
      let n = (db.prepare("SELECT COUNT(*) AS n FROM pseudonym_map").get() as { n: number }).n;
      for (const p of picked) {
        let row = db.prepare("SELECT case_ref FROM pseudonym_map WHERE source_key = ?").get(p.key) as { case_ref: string } | undefined;
        if (!row) {
          n++;
          row = { case_ref: `H-${String(n).padStart(4, "0")}` };
          db.prepare("INSERT INTO pseudonym_map (case_ref, map_ref, source_key, created_at) VALUES (?, ?, ?, ?)").run(row.case_ref, randomRef("M"), p.key, fetchedAt);
        }
        if (p.infants !== null && p.infants > cfg.caps.max_infants_per_case) {
          throw new AppError("CAP_EXCEEDED", `${row.case_ref} expected_infants=${p.infants}`, `الحالة ${row.case_ref}: عدد أجنّة شاذ (${p.infants}) يتجاوز السقف — توقف آمن وصُعّد للإنسان.`);
        }
        const indicators: Record<string, IndicatorValue> = {};
        for (const k of [...f.indicators, f.expected_infants]) indicators[k] = normalize(p.rec[k]);
        const notesRaw = p.rec[f.notes] === undefined || p.rec[f.notes] === null || String(p.rec[f.notes]).trim() === ""
          ? null : redactText(String(p.rec[f.notes]).slice(0, 2000), [...p.ids.strong, ...p.ids.weak]).text;
        const c: Case = { case_ref: row.case_ref, gestation_week: p.gw, in_last_week_window: true, indicators, notes_raw: notesRaw };
        db.prepare("INSERT INTO cycle_cases (cycle_id, case_ref, case_json, expected_infants, notes_flag) VALUES (?, ?, ?, ?, ?)")
          .run(input.cycle_id, c.case_ref, JSON.stringify(c), p.infants ?? 1, injectionFlag(notesRaw));
        out.push(c);
      }
      writeAudit(db, { actor: actorLabel(ctx), entity: "case", ref: input.cycle_id, action: "read_cases", after: { cases: out.length, excluded } });
      return out;
    });

    const skipped = excluded.no_key + excluded.no_edd + excluded.bad_gestation + excluded.bad_infants;
    if (skipped) {
      raiseAlert(ctx.app, "source", input.cycle_id,
        `${skipped} سجل/سجلات من المصدر لم تدخل الدورة ${input.cycle_id}: بلا رقم ملف ${excluded.no_key}، بلا تاريخ ولادة متوقع ${excluded.no_edd}، أسبوع حمل غير صالح ${excluded.bad_gestation}، عدد أجنّة غير صالح ${excluded.bad_infants} — راجع المصدر.`);
    }
    return { cases, source_system: cfg.source.system_name, fetched_at: fetchedAt };
  },
});

/** حالات الدورة المحفوظة (Case + عدد الأجنّة + علم الملاحظات) */
export function cycleCases(ctx: { app: { db: import("../storage/db.ts").Db } }, cycleId: string): { case: Case; expected_infants: number; notes_flag: string | null }[] {
  const rows = ctx.app.db.prepare("SELECT case_json, expected_infants, notes_flag FROM cycle_cases WHERE cycle_id = ? ORDER BY case_ref").all(cycleId) as
    { case_json: string; expected_infants: number; notes_flag: string | null }[];
  return rows.map((r) => ({ case: JSON.parse(r.case_json) as Case, expected_infants: r.expected_infants, notes_flag: r.notes_flag }));
}
