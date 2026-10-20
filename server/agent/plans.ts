/**
 * Plans = ordered write-tool calls the agent PROPOSES. Nothing changes until the user confirms.
 *
 * Validation of a proposal is a real dry run: the same tool code runs inside a database transaction that is
 * always rolled back. That gives exact validation (references, dependency cycles, dates) and a faithful
 * before/after risk preview without maintaining a second, simulated implementation.
 */
import { db, tx } from "../db.ts";
import { ValidationError } from "../validate.ts";
import { DomainError, newId, nowIso } from "../util.ts";
import { TOOL_MAP } from "./tools.ts";
import type { ToolContext } from "./tools.ts";
import { logActivity } from "../store.ts";
import { riskReportForProject } from "../insights.ts";
import type { RiskReport } from "../risk.ts";

export interface StepDraft {
  tool: string;
  input: unknown;
}

export interface DryRunStep {
  tool: string;
  input: any;
  ref: string | null;
  description: string;
  ok: boolean;
  error?: string;
}

export interface DryRunResult {
  steps: DryRunStep[];
  preview: RiskReport | null;
  projectId: string | null;
}

const REF_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function errorMessage(err: unknown): string {
  if (err instanceof ValidationError) return `Invalid input - ${err.message}`;
  if (err instanceof DomainError) return err.message;
  console.error("[agent] unexpected error:", err);
  return "Unexpected internal error while running this step.";
}

function runSteps(steps: StepDraft[], baseCtx: { defaultProjectId?: string | null }, mode: "dry"): DryRunResult {
  const ctx: ToolContext = { actor: "ai", refs: new Map(), defaultProjectId: baseCtx.defaultProjectId ?? null };
  const out: DryRunStep[] = [];
  const touchedProjects: string[] = [];
  for (const draft of steps) {
    const tool = TOOL_MAP.get(draft.tool);
    if (!tool || !tool.write) {
      out.push({ tool: draft.tool, input: draft.input, ref: null, description: draft.tool, ok: false, error: `"${draft.tool}" is not an available action.` });
      continue;
    }
    let input: any;
    try {
      input = tool.schema.parse(draft.input);
    } catch (err) {
      out.push({ tool: draft.tool, input: draft.input, ref: null, description: tool.name, ok: false, error: errorMessage(err) });
      continue;
    }
    const ref: string | null = input.ref ?? null;
    let description = tool.name;
    try {
      if (ref) {
        if (!REF_RE.test(ref)) throw new DomainError("invalid_ref", `Ref "${ref}" is invalid.`);
        if (ctx.refs.has(ref)) throw new DomainError("duplicate_ref", `Ref "${ref}" is already used by an earlier step; refs must be unique.`);
        if (db().prepare("SELECT 1 FROM tasks WHERE id = ? UNION SELECT 1 FROM projects WHERE id = ? UNION SELECT 1 FROM members WHERE id = ?").get(ref, ref, ref)) {
          throw new DomainError("duplicate_ref", `Ref "${ref}" collides with an existing id.`);
        }
      }
      // each step in its own savepoint so a failing step leaves nothing behind
      const result: any = tx(() => tool.run(ctx, input));
      if (ref && result?.id) ctx.refs.set(ref, result.id);
      if (result?.project_id) touchedProjects.push(result.project_id);
      else if ((tool.name === "create_project" || tool.name === "update_project") && result?.id) touchedProjects.push(result.id);
      description = tool.describe(input, ctx);
      out.push({ tool: tool.name, input, ref, description, ok: true });
    } catch (err) {
      try { description = tool.describe(input, ctx); } catch { /* keep the tool name */ }
      out.push({ tool: tool.name, input, ref, description, ok: false, error: errorMessage(err) });
    }
  }
  const focus = touchedProjects.length ? touchedProjects[touchedProjects.length - 1] : baseCtx.defaultProjectId ?? null;
  const projectId = focus;
  let preview: RiskReport | null = null;
  if (focus) {
    try { preview = riskReportForProject(focus); } catch { preview = null; }
  }
  return { steps: out, preview, projectId: focus };
}

/** Validate a proposed list of steps against the live data, then roll everything back. */
export function dryRun(steps: StepDraft[], baseCtx: { defaultProjectId?: string | null }): DryRunResult {
  return tx(() => runSteps(steps, baseCtx, "dry"), { rollback: true });
}

/** Try to add one step to a draft plan. Returns the validation outcome for that step only. */
export function tryAppend(draft: StepDraft[], next: StepDraft, baseCtx: { defaultProjectId?: string | null }): { ok: true; description: string } | { ok: false; error: string } {
  const res = dryRun([...draft, next], baseCtx);
  const last = res.steps[res.steps.length - 1];
  if (last.ok) {
    draft.push(next);
    return { ok: true, description: last.description };
  }
  return { ok: false, error: last.error ?? "Step rejected." };
}

// ---------------------------------------------------------------- persistence

export interface PlanStepView {
  id: string;
  position: number;
  tool: string;
  description: string;
  status: "proposed" | "completed" | "failed" | "skipped" | "rejected";
  ref: string | null;
  result: any;
  error: string | null;
  executed_at: string | null;
  input: any;
}

export interface PlanView {
  id: string;
  conversation_id: string;
  project_id: string | null;
  summary: string;
  status: "proposed" | "executing" | "completed" | "partial" | "failed" | "rejected";
  source: "live_ai" | "demo_mode";
  provider: string | null;
  model: string | null;
  preview: RiskReport | null;
  created_at: string;
  resolved_at: string | null;
  steps: PlanStepView[];
  counts: Record<string, number>;
}

export function createPlan(opts: {
  conversationId: string;
  projectId: string | null;
  summary: string;
  source: "live_ai" | "demo_mode";
  provider?: string | null;
  model?: string | null;
  steps: StepDraft[];
}): PlanView {
  const dry = dryRun(opts.steps, { defaultProjectId: opts.projectId });
  const bad = dry.steps.find((s) => !s.ok);
  if (bad) throw new DomainError("invalid_plan", `The proposed plan did not validate: ${bad.error}`);
  const id = newId("plan");
  tx(() => {
    db().prepare(
      "INSERT INTO plans (id, conversation_id, project_id, summary, status, source, provider, model, preview, created_at) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)",
    ).run(id, opts.conversationId, opts.projectId, opts.summary, opts.source, opts.provider ?? null, opts.model ?? null, JSON.stringify(dry.preview), nowIso());
    dry.steps.forEach((s, i) => {
      db().prepare("INSERT INTO plan_steps (id, plan_id, position, tool, input, ref, description) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(newId("step"), id, i + 1, s.tool, JSON.stringify(s.input), s.ref, s.description);
    });
    logActivity("ai", "plan.proposed", "plan", id, opts.projectId, `AI proposed a plan with ${dry.steps.length} step(s) — awaiting approval`);
  });
  return getPlan(id)!;
}

export function getPlan(id: string): PlanView | undefined {
  const row = db().prepare("SELECT * FROM plans WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  const steps = (db().prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY position").all(id) as any[]).map((s) => ({
    id: s.id, position: s.position, tool: s.tool, description: s.description, status: s.status, ref: s.ref,
    result: s.result ? JSON.parse(s.result) : null, error: s.error, executed_at: s.executed_at, input: JSON.parse(s.input),
  })) as PlanStepView[];
  const counts: Record<string, number> = { proposed: 0, completed: 0, failed: 0, skipped: 0, rejected: 0 };
  for (const s of steps) counts[s.status]++;
  return { ...row, preview: JSON.parse(row.preview || "null"), steps, counts };
}

function mentionsRef(value: unknown, refs: Set<string>): string | null {
  if (typeof value === "string") return refs.has(value) ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) { const r = mentionsRef(v, refs); if (r) return r; }
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) { const r = mentionsRef(v, refs); if (r) return r; }
  }
  return null;
}

function summarizeResult(result: any): any {
  if (!result || typeof result !== "object") return result ?? null;
  const label = result.title ?? result.name ?? null;
  return { id: result.id ?? null, label, project_id: result.project_id ?? null };
}

/** Execute an approved plan step by step. Each step commits independently so partial success is reported honestly. */
export function confirmPlan(planId: string): PlanView {
  const plan = getPlan(planId);
  if (!plan) throw new DomainError("not_found", "Plan not found.");
  if (plan.status !== "proposed") throw new DomainError("conflict", `This plan was already ${plan.status}.`);
  // claim it so a double click cannot run it twice
  const claim = db().prepare("UPDATE plans SET status = 'executing' WHERE id = ? AND status = 'proposed'").run(planId);
  if (Number(claim.changes) === 0) throw new DomainError("conflict", "This plan is already being executed.");

  const ctx: ToolContext = { actor: "ai", refs: new Map(), defaultProjectId: plan.project_id };
  const unavailable = new Set<string>(); // refs whose producing step failed/was skipped
  let firstCreatedProject: string | null = null;

  for (const step of plan.steps) {
    const tool = TOOL_MAP.get(step.tool);
    let status: PlanStepView["status"] = "completed";
    let result: any = null;
    let error: string | null = null;

    const blockedBy = mentionsRef(step.input, unavailable);
    if (blockedBy) {
      status = "skipped";
      error = `Skipped because the earlier step that creates "${blockedBy}" did not succeed.`;
      if (step.ref) unavailable.add(step.ref);
    } else if (!tool || !tool.write) {
      status = "failed";
      error = `"${step.tool}" is not an available action.`;
    } else {
      try {
        const input = tool.schema.parse(step.input);
        const out: any = tx(() => tool.run(ctx, input));
        if (step.ref && out?.id) ctx.refs.set(step.ref, out.id);
        if (tool.name === "create_project" && out?.id && !firstCreatedProject) firstCreatedProject = out.id;
        result = summarizeResult(out);
      } catch (err) {
        status = "failed";
        error = errorMessage(err);
        if (step.ref) unavailable.add(step.ref);
      }
    }
    db().prepare("UPDATE plan_steps SET status = ?, result = ?, error = ?, executed_at = ? WHERE id = ?")
      .run(status, result ? JSON.stringify(result) : null, error, nowIso(), step.id);
  }

  const done = getPlan(planId)!;
  const ok = done.counts.completed;
  const total = done.steps.length;
  const finalStatus: PlanView["status"] = ok === total ? "completed" : ok === 0 ? "failed" : "partial";
  const projectId = firstCreatedProject ?? plan.project_id;
  db().prepare("UPDATE plans SET status = ?, resolved_at = ?, project_id = ? WHERE id = ?").run(finalStatus, nowIso(), projectId, planId);
  if (firstCreatedProject) db().prepare("UPDATE conversations SET project_id = ? WHERE id = ?").run(firstCreatedProject, plan.conversation_id);
  logActivity("ai", "plan.executed", "plan", planId, projectId, `Plan executed: ${ok} of ${total} step(s) succeeded${done.counts.failed ? `, ${done.counts.failed} failed` : ""}${done.counts.skipped ? `, ${done.counts.skipped} skipped` : ""}`);
  return getPlan(planId)!;
}

export function rejectPlan(planId: string): PlanView {
  const plan = getPlan(planId);
  if (!plan) throw new DomainError("not_found", "Plan not found.");
  if (plan.status !== "proposed") throw new DomainError("conflict", `This plan was already ${plan.status}.`);
  tx(() => {
    db().prepare("UPDATE plan_steps SET status = 'rejected' WHERE plan_id = ? AND status = 'proposed'").run(planId);
    db().prepare("UPDATE plans SET status = 'rejected', resolved_at = ? WHERE id = ?").run(nowIso(), planId);
    logActivity("user", "plan.rejected", "plan", planId, plan.project_id, `Plan with ${plan.steps.length} step(s) was discarded — no changes made`);
  });
  return getPlan(planId)!;
}
