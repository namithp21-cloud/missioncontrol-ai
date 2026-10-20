/**
 * Tool registry. This is the ONLY surface the AI agent can act through.
 * - Every tool has a strict schema (used both to validate input and to describe the tool to the model).
 * - Tools call the same store functions the REST API uses; there is no arbitrary code, SQL or network access.
 * - Read tools run immediately. Write tools are proposed first and only run after the user approves.
 *
 * The registry is transport-agnostic, so it can later be exposed through an MCP server unchanged.
 */
import { v } from "../validate.ts";
import type { Schema } from "../validate.ts";
import * as store from "../store.ts";
import { PRIORITIES, PROJECT_STATUSES, TASK_STATUSES } from "../store.ts";
import { riskReportForProject } from "../insights.ts";
import { DomainError } from "../util.ts";

export interface ToolContext {
  actor: "ai" | "user";
  /** ref name -> real id, for entities created earlier in the same plan */
  refs: Map<string, string>;
  /** the project the conversation is focused on */
  defaultProjectId?: string | null;
}

export interface ToolDef {
  name: string;
  description: string;
  write: boolean;
  schema: Schema;
  run(ctx: ToolContext, input: any): unknown;
  /** human-readable one-liner for the review card */
  describe(input: any, ctx: ToolContext): string;
  /** which result field holds the id registered under input.ref */
  producesRef?: boolean;
}

const REF_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ref = () =>
  v.string({ pattern: REF_RE, max: 32 }).desc("Optional short name (lowercase letters, digits, - or _) so later steps in the same plan can refer to this item.").optional();
const idField = (what: string) => v.string({ min: 1, max: 64 }).desc(`${what}: an existing id, or the ref of an item created earlier in this plan.`);

/** Resolve a model-supplied id-or-ref to a real id. */
export function resolve(ctx: ToolContext, value: string): string {
  const mapped = ctx.refs.get(value);
  if (mapped) return mapped;
  return value;
}

function resolveProjectId(ctx: ToolContext, value: string | undefined): string {
  const id = value ? resolve(ctx, value) : ctx.defaultProjectId;
  if (!id) throw new DomainError("missing_project", "No project specified and the conversation has no current project. Ask the user which project to use.");
  return id;
}

const taskName = (ctx: ToolContext, id: string) => store.getTask(resolve(ctx, id))?.title ?? id;
const memberName = (id?: string | null) => (id ? store.getMember(id)?.name ?? id : "nobody");
const short = (iso?: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "no date");

const t = {
  status: v.enum(TASK_STATUSES),
  priority: v.enum(PRIORITIES),
};

export const TOOLS: ToolDef[] = [
  // ---------------- read tools ----------------
  {
    name: "get_workspace_summary",
    description: "Overview of the workspace: projects with progress, team size, counts of open, overdue and unassigned tasks.",
    write: false,
    schema: v.object({}),
    run() {
      const projects = store.listProjects();
      const tasks = store.listTasks();
      const open = tasks.filter((x) => x.status !== "done");
      return {
        projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status, deadline: p.deadline, tasks_total: p.tasks_total, tasks_done: p.tasks_done, progress: p.progress })),
        team_size: store.listMembers().length,
        tasks_open: open.length,
        tasks_overdue: open.filter((x) => x.is_overdue).length,
        tasks_blocked: open.filter((x) => x.is_blocked).length,
        tasks_unassigned: open.filter((x) => !x.assignee_id).length,
      };
    },
    describe: () => "Read workspace summary",
  },
  {
    name: "list_projects",
    description: "List all projects with status, deadline and task progress.",
    write: false,
    schema: v.object({}),
    run: () => store.listProjects(),
    describe: () => "List projects",
  },
  {
    name: "get_project",
    description: "Get one project's details and progress.",
    write: false,
    schema: v.object({ project_id: v.string({ min: 1, max: 64 }).optional().desc("Project id. Defaults to the conversation's current project.") }),
    run(ctx, input) {
      return store.requireProject(resolveProjectId(ctx, input.project_id));
    },
    describe: () => "Read project details",
  },
  {
    name: "list_tasks",
    description: "List/search tasks with optional filters. Each task includes assignee, due date, dependencies, and whether it is blocked or overdue.",
    write: false,
    schema: v.object({
      project_id: v.string({ min: 1, max: 64 }).optional().desc("Defaults to the conversation's current project. Pass 'all' for every project."),
      status: t.status.optional(),
      assignee_id: v.string({ max: 64 }).optional().desc("Member id, or 'unassigned'."),
      priority: t.priority.optional(),
      search: v.string({ max: 100 }).optional().desc("Text to search for in titles and descriptions."),
      blocked: v.boolean().optional(),
      overdue: v.boolean().optional(),
      limit: v.number({ int: true, min: 1, max: 100 }).optional(),
    }),
    run(ctx, input) {
      const project_id = input.project_id === "all" ? undefined : input.project_id ? resolve(ctx, input.project_id) : ctx.defaultProjectId ?? undefined;
      return store.listTasks({ ...input, project_id, q: input.search, limit: input.limit ?? 60 }).map((x) => ({
        id: x.id, title: x.title, status: x.status, priority: x.priority, assignee_id: x.assignee_id, assignee: x.assignee_name,
        start_at: x.start_at, due_at: x.due_at, estimate_hours: x.estimate_hours, depends_on: x.depends_on,
        is_blocked: x.is_blocked, is_overdue: x.is_overdue, project_id: x.project_id,
      }));
    },
    describe: () => "List tasks",
  },
  {
    name: "list_team",
    description: "List team members with their ids, roles, daily capacity (hours) and current open workload.",
    write: false,
    schema: v.object({}),
    run() {
      const tasks = store.listTasks().filter((x) => x.status !== "done");
      return store.listMembers().map((m) => {
        const mine = tasks.filter((x) => x.assignee_id === m.id);
        return { id: m.id, name: m.name, role: m.role, daily_hours: m.daily_hours, open_tasks: mine.length, open_hours: mine.reduce((s, x) => s + (x.estimate_hours ?? 0), 0) };
      });
    },
    describe: () => "List team members",
  },
  {
    name: "get_risk_report",
    description:
      "Run the scheduling and risk analysis for a project: overdue tasks, blocked tasks, dependency conflicts, overlapping commitments, workload and deadline risks, with mitigations. Findings are heuristics, not predictions.",
    write: false,
    schema: v.object({ project_id: v.string({ min: 1, max: 64 }).optional().desc("Defaults to the conversation's current project.") }),
    run(ctx, input) {
      return riskReportForProject(resolveProjectId(ctx, input.project_id));
    },
    describe: () => "Run risk analysis",
  },

  // ---------------- write tools (proposed, then confirmed) ----------------
  {
    name: "create_project",
    description: "Create a new project.",
    write: true,
    producesRef: true,
    schema: v.object({
      ref: ref(),
      name: v.string({ min: 1, max: 120 }),
      description: v.string({ max: 1000 }).optional(),
      deadline: v.datetime().optional(),
      status: v.enum(PROJECT_STATUSES).optional(),
    }),
    run(ctx, input) {
      const { ref: _r, ...rest } = input;
      return store.createProject(rest, ctx.actor);
    },
    describe: (i) => `Create project “${i.name}”${i.deadline ? `, deadline ${short(i.deadline)}` : ""}`,
  },
  {
    name: "update_project",
    description: "Update a project's name, description, status or deadline.",
    write: true,
    schema: v.object({
      project_id: v.string({ min: 1, max: 64 }).optional().desc("Defaults to the conversation's current project."),
      name: v.string({ min: 1, max: 120 }).optional(),
      description: v.string({ max: 1000 }).optional(),
      deadline: v.nullable(v.datetime()).optional().desc("ISO date-time, or null to clear."),
      status: v.enum(PROJECT_STATUSES).optional(),
    }),
    run(ctx, input) {
      const { project_id, ...patch } = input;
      return store.updateProject(resolveProjectId(ctx, project_id), patch, ctx.actor);
    },
    describe: (i) => {
      const bits = [i.name && `rename to “${i.name}”`, i.deadline !== undefined && (i.deadline ? `deadline ${short(i.deadline)}` : "clear deadline"), i.status && `status ${i.status}`, i.description !== undefined && "update description"].filter(Boolean);
      return `Update project: ${bits.join(", ") || "no changes"}`;
    },
  },
  {
    name: "create_task",
    description:
      "Create a task. Include start_at, due_at and estimate_hours whenever possible so scheduling and overlap checks work. depends_on may list ids or refs of tasks that must finish first.",
    write: true,
    producesRef: true,
    schema: v.object({
      ref: ref(),
      project_id: v.string({ min: 1, max: 64 }).optional().desc("Project id or ref. Defaults to the conversation's current project."),
      title: v.string({ min: 1, max: 160 }),
      description: v.string({ max: 2000 }).optional(),
      assignee_id: v.string({ min: 1, max: 64 }).optional().desc("Existing team member id (see list_team)."),
      priority: t.priority.optional(),
      status: t.status.optional(),
      start_at: v.datetime().optional(),
      due_at: v.datetime().optional(),
      estimate_hours: v.number({ min: 0, max: 1000 }).optional(),
      is_milestone: v.boolean().optional(),
      depends_on: v.array(v.string({ min: 1, max: 64 }), { max: 12 }).optional().desc("Ids or refs of tasks this task depends on."),
    }),
    run(ctx, input) {
      const { ref: _r, project_id, depends_on, ...rest } = input;
      return store.createTask(
        { ...rest, project_id: resolveProjectId(ctx, project_id), depends_on: (depends_on ?? []).map((d: string) => resolve(ctx, d)) },
        ctx.actor,
      );
    },
    describe: (i, ctx) =>
      `Create task “${i.title}”${i.assignee_id ? ` → ${memberName(i.assignee_id)}` : " (unassigned)"}${i.due_at ? `, due ${short(i.due_at)}` : ""}${i.depends_on?.length ? `, after ${i.depends_on.length} other task(s)` : ""}`,
  },
  {
    name: "update_task",
    description: "Update a task's status, priority, title, description, dates or estimate. Use assign_task to change the owner.",
    write: true,
    schema: v.object({
      task_id: idField("Task"),
      title: v.string({ min: 1, max: 160 }).optional(),
      description: v.string({ max: 2000 }).optional(),
      status: t.status.optional(),
      priority: t.priority.optional(),
      start_at: v.nullable(v.datetime()).optional(),
      due_at: v.nullable(v.datetime()).optional(),
      estimate_hours: v.nullable(v.number({ min: 0, max: 1000 })).optional(),
      is_milestone: v.boolean().optional(),
    }),
    run(ctx, input) {
      const { task_id, ...patch } = input;
      return store.updateTask(resolve(ctx, task_id), patch, ctx.actor);
    },
    describe: (i, ctx) => {
      const bits = [i.status && `status → ${i.status.replace("_", " ")}`, i.priority && `priority → ${i.priority}`, i.due_at !== undefined && (i.due_at ? `due ${short(i.due_at)}` : "clear due date"), i.title && `rename to “${i.title}”`].filter(Boolean);
      return `Update “${taskName(ctx, i.task_id)}”: ${bits.join(", ") || "details"}`;
    },
  },
  {
    name: "assign_task",
    description: "Assign a task to a team member, or pass assignee_id null to unassign.",
    write: true,
    schema: v.object({ task_id: idField("Task"), assignee_id: v.nullable(v.string({ min: 1, max: 64 })).desc("Existing member id, or null.") }),
    run(ctx, input) {
      return store.updateTask(resolve(ctx, input.task_id), { assignee_id: input.assignee_id }, ctx.actor);
    },
    describe: (i, ctx) => `Assign “${taskName(ctx, i.task_id)}” to ${memberName(i.assignee_id)}`,
  },
  {
    name: "add_dependency",
    description: "Make one task depend on another (task_id cannot start until depends_on_id is done). Rejected if the reference is invalid or would create a cycle.",
    write: true,
    schema: v.object({ task_id: idField("The dependent task"), depends_on_id: idField("The task that must finish first") }),
    run(ctx, input) {
      return store.addDependency(resolve(ctx, input.task_id), resolve(ctx, input.depends_on_id), ctx.actor);
    },
    describe: (i, ctx) => `Make “${taskName(ctx, i.task_id)}” depend on “${taskName(ctx, i.depends_on_id)}”`,
  },
  {
    name: "remove_dependency",
    description: "Remove an existing dependency between two tasks.",
    write: true,
    schema: v.object({ task_id: idField("The dependent task"), depends_on_id: idField("The dependency to remove") }),
    run(ctx, input) {
      return store.removeDependency(resolve(ctx, input.task_id), resolve(ctx, input.depends_on_id), ctx.actor);
    },
    describe: (i, ctx) => `Remove dependency: “${taskName(ctx, i.task_id)}” no longer waits on “${taskName(ctx, i.depends_on_id)}”`,
  },
  {
    name: "delete_task",
    description: "Permanently delete a task. Only use when the user explicitly asks to delete or remove it.",
    write: true,
    schema: v.object({ task_id: idField("Task") }),
    run(ctx, input) {
      store.deleteTask(resolve(ctx, input.task_id), ctx.actor);
      return { deleted: true };
    },
    describe: (i, ctx) => `Delete task “${taskName(ctx, i.task_id)}”`,
  },
  {
    name: "create_team_member",
    description: "Add a team member to the workspace.",
    write: true,
    producesRef: true,
    schema: v.object({
      ref: ref(),
      name: v.string({ min: 1, max: 80 }),
      role: v.string({ min: 1, max: 80 }),
      daily_hours: v.number({ min: 0.5, max: 16 }).optional().desc("Focused working hours per day (default 6)."),
    }),
    run(ctx, input) {
      const { ref: _r, ...rest } = input;
      return store.createMember(rest, ctx.actor);
    },
    describe: (i) => `Add team member ${i.name} (${i.role})`,
  },
];

export const TOOL_MAP = new Map(TOOLS.map((x) => [x.name, x]));

/** Tool definitions in a provider-neutral shape (JSON Schema parameters). */
export function toolSpecs() {
  return TOOLS.map((x) => ({ name: x.name, description: `${x.description}${x.write ? " [Requires user approval before it takes effect.]" : ""}`, parameters: x.schema.json() }));
}
