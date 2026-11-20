/**
 * TL-4 / C-4 — مسودة التحضير ومسودة الفعل. مسودات فقط: لا أداة تنفيذ في النظام كله (DEC-9 / HR-6).
 * القيد: based_on توقع معتمد حصراً (approved أو modified بقرار الإنسان) — وإلا REJECTED_NOT_APPROVED (BR-1 / EV-8).
 * مسودة تحضير نشطة واحدة لكل توقع: الجديدة تحل محل السابقة (superseded) وتُسجَّل في التدقيق.
 */
import { AppError } from "../observability/errors.ts";
import { tx, nowIso, writeAudit, nextDailyRef, type Db } from "../storage/db.ts";
import { validatePreparation, validateAction, type ActionKind } from "../guards/validate.ts";
import { assertNoPII } from "../guards/pii.ts";
import { defineTool, actorLabel, type ToolCtx } from "./registry.ts";
import { getPrediction, type PredictionRow } from "./tl2_predictions.ts";

export type DraftStatus = "active" | "pending" | "approved" | "rejected" | "superseded";

export interface DraftRow {
  draft_ref: string;
  draft_type: "preparation" | "action";
  based_on: string;
  items: { item: string; qty?: number }[] | null;
  action_kind: ActionKind | null;
  payload: { summary: string; infant_refs: string[]; justification: string } | null;
  alternatives: string[];
  status: DraftStatus;
  origin: "agent" | "human";
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Raw {
  draft_ref: string; draft_type: "preparation" | "action"; based_on: string; items_json: string | null; action_kind: ActionKind | null;
  payload_json: string | null; alternatives_json: string | null; status: DraftStatus; origin: "agent" | "human"; run_id: string | null;
  created_at: string; updated_at: string;
}

function fromRaw(r: Raw): DraftRow {
  return {
    draft_ref: r.draft_ref, draft_type: r.draft_type, based_on: r.based_on,
    items: r.items_json ? JSON.parse(r.items_json) : null, action_kind: r.action_kind,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null, alternatives: r.alternatives_json ? JSON.parse(r.alternatives_json) : [],
    status: r.status, origin: r.origin, run_id: r.run_id, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function getDraft(db: Db, ref: string): DraftRow | null {
  const r = db.prepare("SELECT * FROM drafts WHERE draft_ref = ?").get(ref) as Raw | undefined;
  return r ? fromRaw(r) : null;
}

export function listDrafts(db: Db, where = "1=1", ...params: (string | number)[]): DraftRow[] {
  return (db.prepare(`SELECT * FROM drafts WHERE ${where} ORDER BY created_at DESC`).all(...params) as unknown as Raw[]).map(fromRaw);
}

export function approvedPrediction(db: Db, ref: string): PredictionRow {
  const p = getPrediction(db, ref);
  if (!p) throw new AppError("NOT_FOUND", ref);
  if (p.status !== "approved" && p.status !== "modified") throw new AppError("REJECTED_NOT_APPROVED", `${ref} status=${p.status}`);
  return p;
}

export interface DraftResult { draft_ref: string; stored_at: string }

export const TL4_PREPARATION = defineTool<{ based_on: string; draft: unknown }, DraftResult>({
  tool: "TL-4",
  op: "create_preparation_draft",
  actors: ["AGT-1"],
  run(ctx: ToolCtx, input) {
    const { db } = ctx.app;
    approvedPrediction(db, input.based_on);
    const v = validatePreparation(input.draft);
    assertNoPII(v, [...ctx.app.identities], "TL-4 preparation");
    const at = nowIso();
    return tx(db, () => {
      for (const old of listDrafts(db, "draft_type = 'preparation' AND based_on = ? AND status = 'active'", input.based_on)) {
        db.prepare("UPDATE drafts SET status = 'superseded', updated_at = ? WHERE draft_ref = ?").run(at, old.draft_ref);
        writeAudit(db, { actor: actorLabel(ctx), entity: "draft", ref: old.draft_ref, action: "supersede", before: { status: "active" }, after: { status: "superseded" } });
      }
      const ref = nextDailyRef(db, "PD", "drafts", "draft_ref");
      db.prepare(`INSERT INTO drafts (draft_ref, draft_type, based_on, items_json, status, origin, run_id, created_at, updated_at)
                  VALUES (?, 'preparation', ?, ?, 'active', 'agent', ?, ?, ?)`).run(ref, input.based_on, JSON.stringify(v.items), ctx.run_id, at, at);
      writeAudit(db, { actor: actorLabel(ctx), entity: "draft", ref, action: "create_preparation", after: { based_on: input.based_on, ...v } });
      return { draft_ref: ref, stored_at: at };
    });
  },
});

export const TL4_ACTION = defineTool<{ based_on: string; draft: unknown }, DraftResult>({
  tool: "TL-4",
  op: "create_action_draft",
  actors: ["AGT-1"],
  run(ctx: ToolCtx, input) {
    const { db } = ctx.app;
    const p = approvedPrediction(db, input.based_on);
    const v = validateAction(input.draft, p);
    assertNoPII(v, [...ctx.app.identities], "TL-4 action");
    const at = nowIso();
    return tx(db, () => {
      const ref = nextDailyRef(db, "AD", "drafts", "draft_ref");
      db.prepare(`INSERT INTO drafts (draft_ref, draft_type, based_on, action_kind, payload_json, alternatives_json, status, origin, run_id, created_at, updated_at)
                  VALUES (?, 'action', ?, ?, ?, ?, 'pending', 'agent', ?, ?, ?)`)
        .run(ref, input.based_on, v.kind, JSON.stringify(v.payload), JSON.stringify(v.alternatives), ctx.run_id, at, at);
      writeAudit(db, { actor: actorLabel(ctx), entity: "draft", ref, action: "create_action", after: { based_on: input.based_on, ...v } });
      return { draft_ref: ref, stored_at: at };
    });
  },
});
