/**
 * Demo mode: deterministic, rule-based scenarios used when no AI API key is configured.
 *
 * This is NOT a language model and is always labelled as such in the UI. It exists so the whole product loop
 * (plan -> review -> confirm -> real writes -> report -> dashboard) can be demonstrated offline and reproducibly.
 * It uses the SAME validated tools and plan pipeline as live mode; only the "thinking" is scripted.
 */
import * as store from "../store.ts";
import type { TaskView } from "../store.ts";
import { riskReportForProject } from "../insights.ts";
import { addHours, now } from "../util.ts";
import type { StepDraft } from "./plans.ts";

export interface DemoToolLog {
  tool: string;
  input: unknown;
  status: "completed" | "failed";
  summary: string;
}

export interface DemoResult {
  text: string;
  toolCalls: DemoToolLog[];
  steps: StepDraft[];
}

const HELP = [
  "I'm running in **demo mode**: scripted scenarios, not a language model. I can still do real work on your data. Try:",
  "• “We have three days until our hackathon submission. Create a project plan for four team members, break the work into tasks, assign owners, identify dependencies, check for scheduling conflicts, and show us the biggest risks.”",
  "• “What are our biggest risks?”",
  "• “Who is overloaded?”",
  "• “Mark the Devpost registration as done.”",
  "• “Assign the brand task to Priya.”",
  "• “Add task: Record a backup demo video, high priority, for Diego, due in 2 days.”",
  "Set `ANTHROPIC_API_KEY` (or an OpenAI-compatible key) on the server to switch to a live model that understands free-form requests.",
].join("\n");

interface PlanTemplate {
  ref: string;
  title: string;
  description: string;
  roles: RegExp[];
  est: number;
  start: number; // hours after the plan start, for a 72h window
  due: number;
  priority: "low" | "medium" | "high" | "critical";
  deps: string[];
  milestone?: boolean;
  unassigned?: boolean;
}

// Role preferences are tried in order; the first pattern that matches anyone decides the candidate pool.
const ROLE_LEAD = [/full-?stack/i, /developer|engineer|backend|frontend/i];
const ROLE_AI = [/\bai\b|agent|\bml\b|machine/i, /full-?stack|developer|engineer/i];
const ROLE_DESIGN = [/design|\bux\b|\bui\b/i];
const ROLE_PM = [/product|\bpm\b|manager|demo|present/i];

const TEMPLATE: PlanTemplate[] = [
  { ref: "scope", title: "Lock scope and demo storyline", description: "Agree the one workflow the demo must show and cut everything else.", roles: ROLE_PM, est: 2, start: 0, due: 8, priority: "critical", deps: [] },
  { ref: "api", title: "Database schema and API scaffolding", description: "Persistent storage and validated server endpoints.", roles: ROLE_LEAD, est: 5, start: 8, due: 24, priority: "high", deps: ["scope"] },
  { ref: "tools", title: "Agent tool definitions with input validation", description: "Typed tools the agent is allowed to call; no arbitrary code or SQL.", roles: ROLE_AI, est: 6, start: 8, due: 28, priority: "critical", deps: ["scope"] },
  { ref: "design", title: "Design system and key screens", description: "Dashboard, assistant panel and Kanban board designs.", roles: ROLE_DESIGN, est: 7, start: 8, due: 30, priority: "high", deps: ["scope"] },
  { ref: "ui", title: "Dashboard and Kanban UI", description: "Build the main screens from the design.", roles: ROLE_LEAD, est: 9, start: 24, due: 48, priority: "high", deps: ["api", "design"] },
  { ref: "loop", title: "Agent planning loop and confirmation flow", description: "Plan generation, review-and-confirm, execution report.", roles: ROLE_AI, est: 8, start: 28, due: 50, priority: "critical", deps: ["api", "tools"] },
  { ref: "risk", title: "Risk analysis and scheduling checks", description: "Deadline, dependency and overlap checks with explanations.", roles: ROLE_AI, est: 6, start: 30, due: 46, priority: "high", deps: ["api"] },
  { ref: "readme", title: "Write README and submission description", description: "Setup steps, features and honest limitations.", roles: ROLE_PM, est: 3, start: 8, due: 56, priority: "medium", deps: ["scope"] },
  { ref: "integrate", title: "Integrate UI with agent and test end to end", description: "Run the full demo workflow and fix what breaks.", roles: ROLE_LEAD, est: 4, start: 50, due: 62, priority: "critical", deps: ["ui", "loop", "risk"] },
  { ref: "polish", title: "Polish, accessibility and bug bash", description: "Keyboard navigation, contrast, empty and error states.", roles: ROLE_DESIGN, est: 5, start: 48, due: 64, priority: "high", deps: ["design", "ui"] },
  { ref: "video", title: "Record and edit the demo video", description: "Under three minutes, showing the real running product.", roles: ROLE_PM, est: 3, start: 58, due: 68, priority: "critical", deps: ["integrate", "polish"] },
  { ref: "feedback", title: "Write product feedback for the tools we used", description: "Short notes on what worked and what did not.", roles: [], est: 2, start: 40, due: 60, priority: "low", deps: [], unassigned: true },
  { ref: "submit", title: "Submit the project", description: "Final upload and confirmation.", roles: ROLE_PM, est: 0.5, start: 68, due: 70, priority: "critical", deps: ["readme", "video"], milestone: true },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
const stem = (w: string) => w.slice(0, 5);
const STOP = new Set(["the", "and", "for", "task", "tasks", "mark", "set", "move", "assign", "done", "complete", "completed", "finished", "progress", "review", "todo", "as", "to", "a", "an", "of", "our", "my", "please", "now", "into", "in", "on"]);

function findTask(query: string, tasks: TaskView[]): TaskView | null {
  const words = norm(query).split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
  if (!words.length) return null;
  let best: { t: TaskView; score: number } | null = null;
  let tie = false;
  for (const t of tasks) {
    const tw = new Set(norm(t.title).split(/\s+/).map(stem));
    const score = words.filter((w) => tw.has(w)).length;
    if (!score) continue;
    if (!best || score > best.score) { best = { t, score }; tie = false; }
    else if (score === best.score) tie = true;
  }
  return best && !tie ? best.t : null;
}

function findMember(text: string, members: store.Member[]): store.Member | null {
  const q = norm(text);
  for (const m of members) {
    const first = norm(m.name).trim().split(" ")[0];
    if (first && new RegExp(`\\b${first}\\b`).test(q)) return m;
  }
  return null;
}

function pickOwner(roles: RegExp[], members: store.Member[], load: Map<string, number>): store.Member | null {
  if (!members.length) return null;
  let pool: store.Member[] = [];
  for (const re of roles) {
    pool = members.filter((m) => re.test(m.role));
    if (pool.length) break;
  }
  if (!pool.length) pool = members;
  return [...pool].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0];
}

const HOURS = (n: number) => `${Math.round(n * 10) / 10}h`;

export function runDemo(text: string, ctx: { projectId: string | null }): DemoResult {
  const q = text.toLowerCase();
  const logs: DemoToolLog[] = [];
  const projects = store.listProjects();
  const project = (ctx.projectId && store.getProject(ctx.projectId)) || projects.find((p) => p.status === "active") || null;
  const members = store.listMembers();

  if (/^\s*(help|\?|what can you do|hi|hello)\b/.test(q)) return { text: HELP, toolCalls: [], steps: [] };

  // ---------- risks / status ----------
  if (/\b(risks?|what could go wrong|conflicts?|how are we doing|status|on track)\b/.test(q) && !/\b(create|build|make|generate)\b.*\bplan\b/.test(q) && !/\bplan\b.*\b(for|with)\b/.test(q)) {
    if (!project) return { text: "There is no project yet. Create one, or ask me to plan one with a deadline.", toolCalls: [], steps: [] };
    const report = riskReportForProject(project.id);
    logs.push({ tool: "get_risk_report", input: { project_id: project.id }, status: "completed", summary: `${report.risks.length} risk(s) found` });
    if (!report.risks.length) return { text: `${report.summary} (${project.name})`, toolCalls: logs, steps: [] };
    const top = report.risks.slice(0, 5).map((r, i) => `${i + 1}. **${r.title}** (${r.severity}). ${r.explanation} *Mitigation:* ${r.mitigation}`);
    return { text: `**${project.name}**: ${report.summary} The biggest ones:\n\n${top.join("\n\n")}\n\n_${report.disclaimer}_`, toolCalls: logs, steps: [] };
  }

  // ---------- workload ----------
  if (/\b(workload|overloaded|overload|who is (busy|overloaded)|capacity|balance)\b/.test(q)) {
    const tasks = store.listTasks(project ? { project_id: project.id } : {});
    const rows = members.map((m) => {
      const mine = tasks.filter((t) => t.assignee_id === m.id && t.status !== "done");
      return { m, n: mine.length, h: mine.reduce((s, t) => s + (t.estimate_hours ?? 0), 0) };
    }).sort((a, b) => b.h - a.h);
    logs.push({ tool: "list_team", input: {}, status: "completed", summary: `${members.length} member(s)` });
    logs.push({ tool: "list_tasks", input: { project_id: project?.id ?? "all" }, status: "completed", summary: `${tasks.length} task(s)` });
    if (!members.length) return { text: "There are no team members yet. Add them in the Team view.", toolCalls: logs, steps: [] };
    const lines = rows.map((r) => `• **${r.m.name}** (${r.m.role}): ${r.n} open task(s), ${HOURS(r.h)} estimated`);
    const un = tasks.filter((t) => !t.assignee_id && t.status !== "done");
    return { text: `Open workload${project ? ` in **${project.name}**` : ""}:\n${lines.join("\n")}${un.length ? `\n\n${un.length} open task(s) have no owner: ${un.slice(0, 4).map((t) => `“${t.title}”`).join(", ")}.` : ""}`, toolCalls: logs, steps: [] };
  }

  // ---------- assign ----------
  const assign = q.match(/\bassign\b\s+(.+?)\s+to\s+(.+)/);
  if (assign) {
    const tasks = store.listTasks(project ? { project_id: project.id } : {});
    const task = findTask(assign[1], tasks);
    const member = findMember(assign[2], members);
    logs.push({ tool: "list_tasks", input: { project_id: project?.id ?? "all" }, status: "completed", summary: `${tasks.length} task(s)` });
    if (!task) return { text: `I couldn't match “${assign[1].trim()}” to exactly one task. Open the Tasks view to see the exact titles, or name it more specifically.`, toolCalls: logs, steps: [] };
    if (!member) return { text: `I couldn't find a team member matching “${assign[2].trim()}”. Team: ${members.map((m) => m.name).join(", ") || "(none yet)"}.`, toolCalls: logs, steps: [] };
    return {
      text: `I'll propose assigning **${task.title}** to **${member.name}**. Approve it below to apply the change.`,
      toolCalls: logs,
      steps: [{ tool: "assign_task", input: { task_id: task.id, assignee_id: member.id } }],
    };
  }

  // ---------- mark / move status ----------
  const statusWord = q.match(/\b(done|complete|completed|finished|in progress|started|review|to ?do|reopen)\b/);
  if (/\b(mark|set|move|update)\b/.test(q) && statusWord) {
    const target = /done|complete|completed|finished/.test(statusWord[1]) ? "done" : /progress|started/.test(statusWord[1]) ? "in_progress" : /review/.test(statusWord[1]) ? "review" : "todo";
    const tasks = store.listTasks(project ? { project_id: project.id } : {});
    const task = findTask(text.replace(statusWord[0], " "), tasks);
    logs.push({ tool: "list_tasks", input: { project_id: project?.id ?? "all" }, status: "completed", summary: `${tasks.length} task(s)` });
    if (!task) return { text: "I couldn't match that to exactly one task. Try quoting more of the task title.", toolCalls: logs, steps: [] };
    if (task.status === target) return { text: `“${task.title}” is already ${target.replace("_", " ")}. Nothing to change.`, toolCalls: logs, steps: [] };
    return {
      text: `I'll propose moving **${task.title}** from ${task.status.replace("_", " ")} to ${target.replace("_", " ")}.${task.is_blocked && target !== "todo" ? " Note: it still has unfinished dependencies." : ""}`,
      toolCalls: logs,
      steps: [{ tool: "update_task", input: { task_id: task.id, status: target } }],
    };
  }

  // ---------- add a single task ----------
  const add = text.match(/\b(?:add|create|new)\s+(?:a\s+)?task\s*[:\-]?\s*(.+)/i);
  if (add) {
    if (!project) return { text: "Which project should the task go in? There is no project yet.", toolCalls: [], steps: [] };
    let rest = add[1].trim();
    const input: Record<string, unknown> = { project_id: project.id };
    const who = findMember(rest.match(/\bfor\s+(.+?)(?:,|$)/i)?.[1] ?? rest.match(/\bto\s+(.+?)(?:,|$)/i)?.[1] ?? "", members);
    if (who) input.assignee_id = who.id;
    const pr = rest.match(/\b(low|medium|high|critical)\s+priority\b/i);
    if (pr) input.priority = pr[1].toLowerCase();
    const due = rest.match(/\bdue\s+in\s+(\d+)\s*(hours?|days?|h|d)\b/i);
    if (due) input.due_at = addHours(now(), Number(due[1]) * (/^d/i.test(due[2]) ? 24 : 1)).toISOString();
    rest = rest.split(/,|\bdue\b|\bfor\b|\bassign/i)[0].replace(/\b(low|medium|high|critical)\s+priority\b/i, "").trim();
    if (!rest) return { text: "What should the task be called?", toolCalls: [], steps: [] };
    input.title = rest.charAt(0).toUpperCase() + rest.slice(1);
    return { text: `I'll propose creating **${input.title}** in ${project.name}. Approve it below to add it.`, toolCalls: [], steps: [{ tool: "create_task", input }] };
  }

  // ---------- the headline scenario: plan the work ----------
  if (/\b(plan|breakdown|break (?:it|this|the work|work|everything) (?:down|into))\b/.test(q)) {
    if (!project) return { text: "I need a project to plan into. Which project is this for, and when is the deadline?", toolCalls: [], steps: [] };
    if (!members.length) return { text: "I need to know who is on the team. Add your teammates in the Team view (name and role), then ask again.", toolCalls: [], steps: [] };
    if (!project.deadline) {
      return { text: `**${project.name}** has no deadline set. When is the submission due? Tell me (e.g. “the deadline is 2026-10-23 17:00 UTC”) or set it on the project, and I'll build the plan around it.`, toolCalls: [], steps: [] };
    }
    const start = new Date(Math.ceil(now().getTime() / 3_600_000) * 3_600_000);
    const windowH = (new Date(project.deadline).getTime() - start.getTime()) / 3_600_000;
    if (windowH < 12) {
      return { text: `The deadline for **${project.name}** is only ${HOURS(Math.max(windowH, 0))} away (or has passed), which is too short to plan a full breakdown. Move the deadline or tell me which tasks matter most.`, toolCalls: [], steps: [] };
    }
    const scale = windowH / 72;
    const existing = store.listTasks({ project_id: project.id });
    const have = new Set(existing.map((t) => t.title.toLowerCase()));
    logs.push({ tool: "get_project", input: { project_id: project.id }, status: "completed", summary: `${project.name}, ${existing.length} existing task(s)` });
    logs.push({ tool: "list_team", input: {}, status: "completed", summary: `${members.length} member(s)` });
    logs.push({ tool: "list_tasks", input: { project_id: project.id }, status: "completed", summary: `${existing.length} task(s)` });

    const load = new Map<string, number>();
    for (const t of existing) if (t.assignee_id && t.status !== "done") load.set(t.assignee_id, (load.get(t.assignee_id) ?? 0) + (t.estimate_hours ?? 0));
    const steps: StepDraft[] = [];
    const planned = new Set<string>();
    let skipped = 0;
    const unowned: string[] = [];
    for (const tpl of TEMPLATE) {
      if (have.has(tpl.title.toLowerCase())) { skipped++; continue; }
      const owner = tpl.unassigned ? null : pickOwner(tpl.roles, members, load);
      if (owner) load.set(owner.id, (load.get(owner.id) ?? 0) + tpl.est);
      else unowned.push(tpl.title);
      const at = (h: number) => addHours(start, Math.round(h * scale)).toISOString();
      steps.push({
        tool: "create_task",
        input: {
          ref: tpl.ref,
          project_id: project.id,
          title: tpl.title,
          description: tpl.description,
          ...(owner ? { assignee_id: owner.id } : {}),
          priority: tpl.priority,
          start_at: at(tpl.start),
          due_at: at(tpl.due),
          estimate_hours: tpl.est,
          is_milestone: !!tpl.milestone,
          depends_on: tpl.deps.filter((d) => planned.has(d)),
        },
      });
      planned.add(tpl.ref);
    }
    if (!steps.length) return { text: `Every task from my standard hackathon breakdown already exists in **${project.name}**, so there is nothing new to propose. Ask me for the biggest risks instead.`, toolCalls: logs, steps: [] };
    const mentioned = q.match(/\b(\w+) days?\b/);
    const lines = [
      `Here's a proposed plan for **${project.name}**: **${steps.length} tasks** across ${new Set(steps.map((s) => (s.input as any).assignee_id).filter(Boolean)).size} teammate(s), scheduled over the ${HOURS(windowH)} until the project deadline, with dependencies between them.`,
      skipped ? `${skipped} task(s) from my template already exist here, so I left them out.` : "",
      unowned.length ? `I left ${unowned.map((t) => `“${t}”`).join(", ")} unassigned. Decide who takes it before approving, or assign it afterwards.` : "",
      mentioned && !/\b(three|3)\b/.test(mentioned[1]) ? `You mentioned "${mentioned[0]}", but I planned against the project's deadline instead.` : "",
      "**Nothing is created yet.** Review the steps and the risk preview below, then approve or discard.",
    ].filter(Boolean);
    return { text: lines.join("\n\n"), toolCalls: logs, steps };
  }

  return { text: `I didn't recognise that request in demo mode.\n\n${HELP}`, toolCalls: [], steps: [] };
}
