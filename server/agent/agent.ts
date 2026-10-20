/**
 * The agent orchestrator.
 *
 *  live mode  : a real language model (via the provider abstraction) calls validated tools. Read tools run at once;
 *               write tools are collected into a PROPOSED plan that the user must approve.
 *  demo mode  : deterministic scripted scenarios (never presented as AI output), same tools and plan pipeline.
 *
 * The assistant's prose is only ever a description. What actually happened is reported from plan_steps rows
 * written by the executor, so a model can't claim success for something that failed.
 */
import { db, tx } from "../db.ts";
import * as store from "../store.ts";
import { newId, nowIso, now, DomainError } from "../util.ts";
import { TOOL_MAP, toolSpecs } from "./tools.ts";
import type { ToolContext } from "./tools.ts";
import { createPlan, confirmPlan, rejectPlan, errorMessage, getPlan, tryAppend } from "./plans.ts";
import type { PlanView, StepDraft } from "./plans.ts";
import { getProvider, providerStatus, ProviderError } from "./providers.ts";
import type { ChatMessage, LLMProvider } from "./providers.ts";
import { runDemo } from "./demoAgent.ts";
import type { DemoToolLog } from "./demoAgent.ts";

const MAX_TURNS = 8;
const MAX_TOOL_RESULT_CHARS = 12_000;

export function agentStatus() {
  const s = providerStatus();
  return {
    ...s,
    label: s.mode === "live" ? `Live AI · ${s.provider} · ${s.model}` : "Demo mode · scripted scenarios, not an AI model",
    daily_limit: dailyLimit(),
  };
}

// ------------------------------------------------------------------ usage guard (protects a public deployment's API key)
function dailyLimit(): number {
  const n = Number(process.env.AGENT_DAILY_LIMIT ?? 300);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}
function spendCall(): void {
  const key = `llm_calls:${now().toISOString().slice(0, 10)}`;
  const row = db().prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined;
  const used = row ? Number(row.value) : 0;
  if (used >= dailyLimit()) throw new DomainError("daily_limit", `The daily limit of ${dailyLimit()} AI calls for this deployment has been reached. Try again tomorrow, or raise AGENT_DAILY_LIMIT.`);
  db().prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(used + 1));
}

// ------------------------------------------------------------------ conversation storage
export interface MessageView {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  meta: Record<string, any>;
  created_at: string;
  plan: PlanView | null;
}

function addMessage(conversationId: string, role: MessageView["role"], content: string, meta: Record<string, unknown> = {}): number {
  const r = db().prepare("INSERT INTO messages (conversation_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, role, content, JSON.stringify(meta), nowIso());
  return Number(r.lastInsertRowid);
}

function toView(row: any): MessageView {
  const meta = JSON.parse(row.meta || "{}");
  return { id: row.id, role: row.role, content: row.content, meta, created_at: row.created_at, plan: meta.plan_id ? getPlan(meta.plan_id) ?? null : null };
}

export function getConversation(id: string) {
  const conv = db().prepare("SELECT * FROM conversations WHERE id = ?").get(id) as any;
  if (!conv) return null;
  const rows = db().prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id").all(id) as any[];
  return { id: conv.id, project_id: conv.project_id as string | null, is_demo: !!conv.is_demo, messages: rows.map(toView) };
}

/** Most recent conversation, so a page refresh returns to where the user was. */
export function latestConversationId(): string | null {
  const row = db().prepare("SELECT id FROM conversations ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

function ensureConversation(conversationId: string | undefined, projectId: string | null): { id: string; project_id: string | null } {
  if (conversationId) {
    const c = db().prepare("SELECT id, project_id FROM conversations WHERE id = ?").get(conversationId) as any;
    if (!c) throw new DomainError("not_found", "Conversation not found.");
    if (projectId !== null && projectId !== c.project_id) {
      store.requireProject(projectId);
      db().prepare("UPDATE conversations SET project_id = ? WHERE id = ?").run(projectId, c.id);
      return { id: c.id, project_id: projectId };
    }
    return c;
  }
  if (projectId) store.requireProject(projectId);
  const id = newId("conv");
  const demo = projectId ? store.getProject(projectId)?.is_demo ?? 1 : 1;
  db().prepare("INSERT INTO conversations (id, project_id, is_demo, created_at) VALUES (?, ?, ?, ?)").run(id, projectId, demo, nowIso());
  return { id, project_id: projectId };
}

// ------------------------------------------------------------------ live mode
function systemPrompt(projectId: string | null): string {
  const project = projectId ? store.getProject(projectId) : null;
  const members = store.listMembers();
  return [
    "You are MissionControl AI, a team-coordination agent inside a project-management web app used by students and hackathon teams.",
    `Current date and time (UTC): ${now().toISOString()}.`,
    project
      ? `The conversation is focused on project "${project.name}" (id ${project.id}), status ${project.status}, deadline ${project.deadline ?? "not set"}.`
      : "The conversation has no current project yet. Use list_projects, or ask the user which project they mean.",
    `Team members (use these exact ids): ${members.length ? members.map((m) => `${m.name} (${m.role}, id ${m.id}, ${m.daily_hours}h/day)`).join("; ") : "none yet"}.`,
    "",
    "How to work:",
    "- Look up real data with the read tools before planning. Never invent ids, names or dates.",
    "- If something essential is missing and cannot be reasonably inferred (which project, the deadline, who is on the team), ask ONE short clarifying question and do not call write tools.",
    "- To change anything, call the write tools. They are NOT executed immediately: the user reviews your proposed steps and must approve them. Never say a change has been made; say you have proposed it.",
    "- Order steps so dependencies come first. Give every task you create a short unique lowercase `ref`, and refer to it from later steps (depends_on, task_id, ...).",
    "- For every task include assignee_id, priority, start_at, due_at (ISO 8601 with Z) and estimate_hours. Keep all due dates before the project deadline and respect each member's daily hours; avoid stacking overlapping heavy tasks on one person. If a step is rejected, read the error and fix it.",
    "- When asked about risks, call get_risk_report and explain the findings plainly. Findings are heuristics: say 'may' and 'could', never claim certainty about delays.",
    "- You can only act through the provided tools. You cannot run code or SQL.",
    "- After proposing, reply with a brief plain-language summary: what you propose, why, and the main risks. Keep it short.",
  ].join("\n");
}

function historyFor(conversationId: string): ChatMessage[] {
  const rows = db().prepare("SELECT role, content, meta FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20").all(conversationId) as any[];
  const out: ChatMessage[] = [];
  for (const r of rows.reverse()) {
    const meta = JSON.parse(r.meta || "{}");
    if (meta.kind === "error") continue;
    if (r.role === "user") out.push({ role: "user", content: r.content });
    else if (r.role === "assistant") out.push({ role: "assistant", content: r.content });
    else out.push({ role: "user", content: `[Application note, not from the user] ${r.content}` });
  }
  // providers require the conversation to start with a user turn
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function clip(value: unknown): string {
  const s = JSON.stringify(value);
  return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : s;
}

interface AgentOutcome {
  text: string;
  toolLog: (DemoToolLog | { tool: string; input: unknown; status: "completed" | "failed"; summary: string })[];
  steps: StepDraft[];
  error?: string;
}

async function runLive(provider: LLMProvider, conversationId: string, projectId: string | null): Promise<AgentOutcome> {
  const messages = historyFor(conversationId);
  const ctx: ToolContext = { actor: "ai", refs: new Map(), defaultProjectId: projectId };
  const draft: StepDraft[] = [];
  const log: AgentOutcome["toolLog"] = [];
  let finalText = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    spendCall();
    const res = await provider.chat({ system: systemPrompt(projectId), messages, tools: toolSpecs() });
    if (!res.toolCalls.length) { finalText = res.text; break; }
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    for (const call of res.toolCalls) {
      const tool = TOOL_MAP.get(call.name);
      let content: string;
      if (!tool) {
        content = `Error: "${call.name}" is not an available tool.`;
        log.push({ tool: call.name, input: call.arguments, status: "failed", summary: "unknown tool" });
      } else if (call.parseError) {
        content = `Error: ${call.parseError}`;
        log.push({ tool: call.name, input: null, status: "failed", summary: call.parseError });
      } else if (tool.write) {
        const r = tryAppend(draft, { tool: tool.name, input: call.arguments }, { defaultProjectId: projectId });
        if (r.ok) {
          content = `Proposed as step ${draft.length}: ${r.description}. It will only take effect if the user approves the plan.`;
          log.push({ tool: tool.name, input: call.arguments, status: "completed", summary: `proposed: ${r.description}` });
        } else {
          content = `Rejected, nothing was added to the plan: ${r.error}`;
          log.push({ tool: tool.name, input: call.arguments, status: "failed", summary: r.error });
        }
      } else {
        try {
          const input = tool.schema.parse(call.arguments ?? {});
          const out = tx(() => tool.run(ctx, input), { rollback: true }); // read tools never persist anything
          content = clip(out);
          log.push({ tool: tool.name, input, status: "completed", summary: "ok" });
        } catch (err) {
          content = `Error: ${errorMessage(err)}`;
          log.push({ tool: tool.name, input: call.arguments, status: "failed", summary: errorMessage(err) });
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
    if (turn === MAX_TURNS - 1) finalText = res.text || "I stopped after reaching the step limit for one request.";
  }
  return { text: finalText.trim(), toolLog: log, steps: draft };
}

// ------------------------------------------------------------------ public entry points
export interface AgentReply {
  conversation_id: string;
  project_id: string | null;
  messages: MessageView[];
}

export async function handleUserMessage(input: { conversationId?: string; projectId?: string | null; text: string }): Promise<AgentReply> {
  const conv = ensureConversation(input.conversationId, input.projectId ?? null);
  const userMsgId = addMessage(conv.id, "user", input.text);
  const created: number[] = [userMsgId];
  const provider = getProvider();
  const source = provider ? "live_ai" : "demo_mode";
  const baseMeta = { source, provider: provider?.name ?? null, model: provider?.model ?? null };

  let outcome: AgentOutcome;
  try {
    if (provider) outcome = await runLive(provider, conv.id, conv.project_id);
    else {
      const r = runDemo(input.text, { projectId: conv.project_id });
      outcome = { text: r.text, toolLog: r.toolCalls, steps: r.steps };
    }
  } catch (err) {
    const msg = err instanceof ProviderError || err instanceof DomainError ? err.message : "Something went wrong while handling that request.";
    if (!(err instanceof ProviderError || err instanceof DomainError)) console.error("[agent] failure:", err);
    created.push(addMessage(conv.id, "assistant", msg, { ...baseMeta, kind: "error" }));
    return reply(conv.id, created);
  }

  let planId: string | null = null;
  let text = outcome.text;
  if (outcome.steps.length) {
    try {
      const plan = createPlan({
        conversationId: conv.id,
        projectId: conv.project_id ?? firstProjectOf(outcome.steps),
        summary: text.slice(0, 300) || `${outcome.steps.length} proposed change(s)`,
        source,
        provider: provider?.name,
        model: provider?.model,
        steps: outcome.steps,
      });
      planId = plan.id;
      if (!text) text = `I've prepared ${plan.steps.length} change(s) for your review. Nothing has been applied yet.`;
    } catch (err) {
      text = `I couldn't prepare a valid plan: ${errorMessage(err)}`;
      outcome.steps = [];
    }
  }
  if (!text) text = "I didn't have anything to add. Could you tell me more about what you'd like done?";
  created.push(addMessage(conv.id, "assistant", text, { ...baseMeta, kind: planId ? "plan" : "text", tool_calls: outcome.toolLog, ...(planId ? { plan_id: planId } : {}) }));
  return reply(conv.id, created);
}

function firstProjectOf(steps: StepDraft[]): string | null {
  for (const s of steps) {
    const pid = (s.input as any)?.project_id;
    if (typeof pid === "string" && store.getProject(pid)) return pid;
  }
  return null;
}

function reply(conversationId: string, ids: number[]): AgentReply {
  const conv = getConversation(conversationId)!;
  return { conversation_id: conv.id, project_id: conv.project_id, messages: conv.messages.filter((m) => ids.includes(m.id)) };
}

function planReport(plan: PlanView): string {
  const c = plan.counts;
  const parts = [`${c.completed} of ${plan.steps.length} step(s) completed`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return `Execution report: ${parts.join(", ")}.`;
}

export function approvePlan(planId: string): { plan: PlanView; message: MessageView } {
  const plan = confirmPlan(planId);
  const id = addMessage(plan.conversation_id, "system", planReport(plan), { kind: "report", plan_id: plan.id });
  const row = db().prepare("SELECT * FROM messages WHERE id = ?").get(id);
  return { plan, message: toView(row) };
}

export function discardPlan(planId: string): { plan: PlanView; message: MessageView } {
  const plan = rejectPlan(planId);
  const id = addMessage(plan.conversation_id, "system", "Plan discarded. No changes were made.", { kind: "report", plan_id: plan.id });
  const row = db().prepare("SELECT * FROM messages WHERE id = ?").get(id);
  return { plan, message: toView(row) };
}
