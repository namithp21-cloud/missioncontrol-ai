import { db, tx } from "./db.ts";
import { DomainError, newId, now, nowIso } from "./util.ts";

export type Actor = "user" | "ai" | "system";
export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export const PROJECT_STATUSES = ["active", "on_hold", "completed"] as const;

export interface Member {
  id: string;
  name: string;
  role: string;
  daily_hours: number;
  color: string;
  is_demo: number;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: (typeof PROJECT_STATUSES)[number];
  deadline: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: (typeof TASK_STATUSES)[number];
  priority: (typeof PRIORITIES)[number];
  assignee_id: string | null;
  start_at: string | null;
  due_at: string | null;
  estimate_hours: number | null;
  is_milestone: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskView extends Task {
  assignee_name: string | null;
  depends_on: string[];
  open_dependencies: string[];
  is_blocked: boolean;
  is_overdue: boolean;
  is_demo: number;
}

export interface ProjectView extends Project {
  tasks_total: number;
  tasks_done: number;
  tasks_open: number;
  tasks_overdue: number;
  progress: number | null;
}

// ---------- small SQL helpers ----------
const all = <T = any>(sql: string, ...p: any[]): T[] => db().prepare(sql).all(...p) as T[];
const get = <T = any>(sql: string, ...p: any[]): T | undefined => db().prepare(sql).get(...p) as T | undefined;
const run = (sql: string, ...p: any[]) => db().prepare(sql).run(...p);

// ---------- activity ----------
export function logActivity(actor: Actor, action: string, entityType: string, entityId: string | null, projectId: string | null, summary: string): void {
  let demo = 0;
  if (projectId) demo = get<{ is_demo: number }>("SELECT is_demo FROM projects WHERE id = ?", projectId)?.is_demo ?? 0;
  else if (entityType === "member" && entityId) demo = get<{ is_demo: number }>("SELECT is_demo FROM members WHERE id = ?", entityId)?.is_demo ?? 0;
  run(
    "INSERT INTO activity (ts, actor, action, entity_type, entity_id, project_id, summary, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    nowIso(), actor, action, entityType, entityId, projectId, summary, demo,
  );
}

export function listActivity(opts: { limit?: number; projectId?: string; before?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: string[] = [];
  const params: any[] = [];
  if (opts.projectId) { where.push("project_id = ?"); params.push(opts.projectId); }
  if (opts.before) { where.push("id < ?"); params.push(opts.before); }
  return all(`SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...params, limit);
}

// ---------- team ----------
const PALETTE = ["#7c83ff", "#38bdf8", "#a78bfa", "#34d399", "#f59e0b", "#f472b6", "#22d3ee", "#fb7185"];

export function listMembers(): Member[] {
  return all<Member>("SELECT * FROM members ORDER BY is_demo DESC, created_at, name");
}

export function getMember(id: string): Member | undefined {
  return get<Member>("SELECT * FROM members WHERE id = ?", id);
}

export function requireMember(id: string): Member {
  const m = getMember(id);
  if (!m) throw new DomainError("invalid_reference", `Team member "${id}" does not exist.`);
  return m;
}

export function createMember(input: { name: string; role: string; daily_hours?: number }, actor: Actor): Member {
  return tx(() => {
    const id = newId("m");
    const count = (get<{ n: number }>("SELECT COUNT(*) AS n FROM members")?.n) ?? 0;
    run(
      "INSERT INTO members (id, name, role, daily_hours, color, is_demo, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      id, input.name, input.role, input.daily_hours ?? 6, PALETTE[count % PALETTE.length], nowIso(),
    );
    logActivity(actor, "member.created", "member", id, null, `Added team member ${input.name} (${input.role})`);
    return getMember(id)!;
  });
}

export function updateMember(id: string, patch: { name?: string; role?: string; daily_hours?: number }, actor: Actor): Member {
  return tx(() => {
    const cur = requireMember(id);
    run(
      "UPDATE members SET name = ?, role = ?, daily_hours = ? WHERE id = ?",
      patch.name ?? cur.name, patch.role ?? cur.role, patch.daily_hours ?? cur.daily_hours, id,
    );
    logActivity(actor, "member.updated", "member", id, null, `Updated team member ${patch.name ?? cur.name}`);
    return getMember(id)!;
  });
}

export function deleteMember(id: string, actor: Actor): { unassigned_tasks: number } {
  return tx(() => {
    const m = requireMember(id);
    const n = get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ?", id)?.n ?? 0;
    run("DELETE FROM members WHERE id = ?", id);
    logActivity(actor, "member.deleted", "member", id, null, `Removed team member ${m.name}${n ? ` (${n} task${n === 1 ? "" : "s"} now unassigned)` : ""}`);
    return { unassigned_tasks: n };
  });
}

// ---------- projects ----------
function projectStats(p: Project): ProjectView {
  const t = get<{ total: number; done: number; overdue: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'done'), 0) AS done,
            COALESCE(SUM(status <> 'done' AND due_at IS NOT NULL AND due_at < ?), 0) AS overdue
       FROM tasks WHERE project_id = ?`,
    nowIso(), p.id,
  )!;
  return {
    ...p,
    tasks_total: t.total,
    tasks_done: t.done,
    tasks_open: t.total - t.done,
    tasks_overdue: t.overdue,
    progress: t.total === 0 ? null : t.done / t.total,
  };
}

export function listProjects(): ProjectView[] {
  return all<Project>("SELECT * FROM projects ORDER BY is_demo DESC, created_at DESC").map(projectStats);
}

export function getProject(id: string): ProjectView | undefined {
  const p = get<Project>("SELECT * FROM projects WHERE id = ?", id);
  return p ? projectStats(p) : undefined;
}

export function requireProject(id: string): ProjectView {
  const p = getProject(id);
  if (!p) throw new DomainError("not_found", `Project "${id}" does not exist.`);
  return p;
}

export function createProject(
  input: { name: string; description?: string; deadline?: string; status?: Project["status"] },
  actor: Actor,
  opts: { isDemo?: boolean; id?: string } = {},
): ProjectView {
  return tx(() => {
    const id = opts.id ?? newId("p");
    const ts = nowIso();
    run(
      "INSERT INTO projects (id, name, description, status, deadline, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, input.name, input.description ?? "", input.status ?? "active", input.deadline ?? null, opts.isDemo ? 1 : 0, ts, ts,
    );
    logActivity(actor, "project.created", "project", id, id, `Created project “${input.name}”${input.deadline ? ` with deadline ${input.deadline.slice(0, 10)}` : ""}`);
    return getProject(id)!;
  });
}

export function updateProject(
  id: string,
  patch: { name?: string; description?: string; deadline?: string | null; status?: Project["status"] },
  actor: Actor,
): ProjectView {
  return tx(() => {
    const cur = requireProject(id);
    const next = {
      name: patch.name ?? cur.name,
      description: patch.description ?? cur.description,
      deadline: patch.deadline === undefined ? cur.deadline : patch.deadline,
      status: patch.status ?? cur.status,
    };
    run("UPDATE projects SET name = ?, description = ?, deadline = ?, status = ?, updated_at = ? WHERE id = ?",
      next.name, next.description, next.deadline, next.status, nowIso(), id);
    const changes: string[] = [];
    if (next.name !== cur.name) changes.push(`renamed to “${next.name}”`);
    if (next.deadline !== cur.deadline) changes.push(next.deadline ? `deadline set to ${next.deadline.slice(0, 16).replace("T", " ")} UTC` : "deadline cleared");
    if (next.status !== cur.status) changes.push(`status ${cur.status} → ${next.status}`);
    if (next.description !== cur.description) changes.push("description updated");
    if (changes.length) logActivity(actor, "project.updated", "project", id, id, `Project “${cur.name}”: ${changes.join(", ")}`);
    return getProject(id)!;
  });
}

export function deleteProject(id: string, actor: Actor): void {
  tx(() => {
    const p = requireProject(id);
    // activity rows are kept (project_id has no FK) so the history survives
    logActivity(actor, "project.deleted", "project", id, id, `Deleted project “${p.name}” and its ${p.tasks_total} task(s)`);
    run("DELETE FROM projects WHERE id = ?", id);
  });
}

// ---------- tasks ----------
export interface TaskFilters {
  project_id?: string;
  status?: string;
  assignee_id?: string; // member id or "unassigned"
  priority?: string;
  q?: string;
  blocked?: boolean;
  overdue?: boolean;
  limit?: number;
}

function enrich(rows: (Task & { assignee_name: string | null; is_demo: number })[], depRows: { task_id: string; depends_on_id: string }[], statusById: Map<string, string>): TaskView[] {
  const deps = new Map<string, string[]>();
  for (const d of depRows) {
    const list = deps.get(d.task_id) ?? [];
    list.push(d.depends_on_id);
    deps.set(d.task_id, list);
  }
  const nowMs = now().getTime();
  return rows.map((t) => {
    const depends_on = deps.get(t.id) ?? [];
    const open_dependencies = depends_on.filter((id) => statusById.get(id) !== "done");
    const open = t.status !== "done";
    return {
      ...t,
      depends_on,
      open_dependencies,
      is_blocked: open && open_dependencies.length > 0,
      is_overdue: open && !!t.due_at && new Date(t.due_at).getTime() < nowMs,
    };
  });
}

export function listTasks(f: TaskFilters = {}): TaskView[] {
  const where: string[] = [];
  const params: any[] = [];
  if (f.project_id) { where.push("t.project_id = ?"); params.push(f.project_id); }
  if (f.status) { where.push("t.status = ?"); params.push(f.status); }
  if (f.priority) { where.push("t.priority = ?"); params.push(f.priority); }
  if (f.assignee_id === "unassigned") where.push("t.assignee_id IS NULL");
  else if (f.assignee_id) { where.push("t.assignee_id = ?"); params.push(f.assignee_id); }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  const rows = all<any>(
    `SELECT t.*, m.name AS assignee_name, p.is_demo AS is_demo
       FROM tasks t
       LEFT JOIN members m ON m.id = t.assignee_id
       JOIN projects p ON p.id = t.project_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY COALESCE(t.due_at, '9999'), t.created_at, t.id`,
    ...params,
  );
  const scope = f.project_id
    ? all<any>("SELECT d.* FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?", f.project_id)
    : all<any>("SELECT * FROM task_deps");
  const statusById = new Map<string, string>(all<any>("SELECT id, status FROM tasks").map((r) => [r.id, r.status]));
  let out = enrich(rows, scope, statusById);
  if (f.blocked !== undefined) out = out.filter((t) => t.is_blocked === f.blocked);
  if (f.overdue !== undefined) out = out.filter((t) => t.is_overdue === f.overdue);
  if (f.limit) out = out.slice(0, Math.min(Math.max(f.limit, 1), 500));
  return out;
}

export function getTask(id: string): TaskView | undefined {
  const row = get<any>(
    `SELECT t.*, m.name AS assignee_name, p.is_demo AS is_demo FROM tasks t
       LEFT JOIN members m ON m.id = t.assignee_id JOIN projects p ON p.id = t.project_id WHERE t.id = ?`, id);
  if (!row) return undefined;
  const deps = all<any>("SELECT * FROM task_deps WHERE task_id = ?", id);
  const statusById = new Map<string, string>(all<any>("SELECT id, status FROM tasks").map((r) => [r.id, r.status]));
  return enrich([row], deps, statusById)[0];
}

export function requireTask(id: string): TaskView {
  const t = getTask(id);
  if (!t) throw new DomainError("not_found", `Task "${id}" does not exist.`);
  return t;
}

function checkDates(start: string | null | undefined, due: string | null | undefined) {
  if (start && due && new Date(start).getTime() > new Date(due).getTime()) {
    throw new DomainError("invalid_dates", "A task's start time must not be after its due time.");
  }
}

export interface NewTask {
  project_id: string;
  title: string;
  description?: string;
  status?: Task["status"];
  priority?: Task["priority"];
  assignee_id?: string | null;
  start_at?: string | null;
  due_at?: string | null;
  estimate_hours?: number | null;
  is_milestone?: boolean;
  depends_on?: string[];
}

export function createTask(input: NewTask, actor: Actor, opts: { id?: string } = {}): TaskView {
  return tx(() => {
    const project = requireProject(input.project_id);
    if (input.assignee_id) requireMember(input.assignee_id);
    checkDates(input.start_at, input.due_at);
    const id = opts.id ?? newId("t");
    const ts = nowIso();
    const status = input.status ?? "todo";
    run(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, assignee_id, start_at, due_at, estimate_hours, is_milestone, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.project_id, input.title, input.description ?? "", status, input.priority ?? "medium",
      input.assignee_id ?? null, input.start_at ?? null, input.due_at ?? null, input.estimate_hours ?? null,
      input.is_milestone ? 1 : 0, ts, ts, status === "done" ? ts : null,
    );
    for (const dep of [...new Set(input.depends_on ?? [])]) addDependencyRaw(id, dep);
    logActivity(actor, "task.created", "task", id, project.id, `Created task “${input.title}”${input.assignee_id ? ` for ${requireMember(input.assignee_id).name}` : ""}`);
    return getTask(id)!;
  });
}

export function updateTask(
  id: string,
  patch: Partial<Omit<NewTask, "project_id" | "depends_on">>,
  actor: Actor,
): TaskView {
  return tx(() => {
    const cur = requireTask(id);
    if (patch.assignee_id) requireMember(patch.assignee_id);
    const next = {
      title: patch.title ?? cur.title,
      description: patch.description ?? cur.description,
      status: patch.status ?? cur.status,
      priority: patch.priority ?? cur.priority,
      assignee_id: patch.assignee_id === undefined ? cur.assignee_id : patch.assignee_id,
      start_at: patch.start_at === undefined ? cur.start_at : patch.start_at,
      due_at: patch.due_at === undefined ? cur.due_at : patch.due_at,
      estimate_hours: patch.estimate_hours === undefined ? cur.estimate_hours : patch.estimate_hours,
      is_milestone: patch.is_milestone === undefined ? cur.is_milestone : patch.is_milestone ? 1 : 0,
    };
    checkDates(next.start_at, next.due_at);
    const ts = nowIso();
    const completed_at = next.status === "done" ? (cur.status === "done" ? cur.completed_at : ts) : null;
    run(
      `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, start_at = ?, due_at = ?,
              estimate_hours = ?, is_milestone = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      next.title, next.description, next.status, next.priority, next.assignee_id, next.start_at, next.due_at,
      next.estimate_hours, next.is_milestone, ts, completed_at, id,
    );
    const changes: string[] = [];
    if (next.status !== cur.status) changes.push(`${cur.status.replace("_", " ")} → ${next.status.replace("_", " ")}`);
    if (next.priority !== cur.priority) changes.push(`priority ${cur.priority} → ${next.priority}`);
    if (next.assignee_id !== cur.assignee_id) {
      changes.push(next.assignee_id ? `assigned to ${requireMember(next.assignee_id).name}` : "unassigned");
    }
    if (next.due_at !== cur.due_at) changes.push(next.due_at ? `due ${next.due_at.slice(0, 16).replace("T", " ")} UTC` : "due date cleared");
    if (next.title !== cur.title) changes.push(`renamed to “${next.title}”`);
    if (next.start_at !== cur.start_at || next.estimate_hours !== cur.estimate_hours || next.description !== cur.description || next.is_milestone !== cur.is_milestone) changes.push("details updated");
    if (changes.length) {
      const action = next.status !== cur.status ? "task.status" : next.assignee_id !== cur.assignee_id ? "task.assigned" : "task.updated";
      logActivity(actor, action, "task", id, cur.project_id, `“${cur.title}”: ${changes.join(", ")}`);
    }
    return getTask(id)!;
  });
}

export function deleteTask(id: string, actor: Actor): void {
  tx(() => {
    const t = requireTask(id);
    run("DELETE FROM tasks WHERE id = ?", id);
    logActivity(actor, "task.deleted", "task", id, t.project_id, `Deleted task “${t.title}”`);
  });
}

// ---------- dependencies ----------

/** Returns the dependency path dependsOnId -> ... -> taskId if adding task -> dependsOn would close a cycle. */
export function findCycle(taskId: string, dependsOnId: string): string[] | null {
  const edges = all<{ task_id: string; depends_on_id: string }>("SELECT * FROM task_deps");
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.task_id, [...(next.get(e.task_id) ?? []), e.depends_on_id]);
  const parent = new Map<string, string | null>([[dependsOnId, null]]);
  const stack = [dependsOnId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) {
      const path: string[] = [];
      let n: string | null = cur;
      while (n) { path.unshift(n); n = parent.get(n) ?? null; }
      return path; // dependsOn ... -> task
    }
    for (const n of next.get(cur) ?? []) {
      if (!parent.has(n)) { parent.set(n, cur); stack.push(n); }
    }
  }
  return null;
}

function addDependencyRaw(taskId: string, dependsOnId: string): void {
  if (taskId === dependsOnId) throw new DomainError("invalid_reference", "A task cannot depend on itself.");
  const a = get<{ project_id: string; title: string }>("SELECT project_id, title FROM tasks WHERE id = ?", taskId);
  const b = get<{ project_id: string; title: string }>("SELECT project_id, title FROM tasks WHERE id = ?", dependsOnId);
  if (!a) throw new DomainError("invalid_reference", `Task "${taskId}" does not exist.`);
  if (!b) throw new DomainError("invalid_reference", `Dependency "${dependsOnId}" is not an existing task.`);
  if (a.project_id !== b.project_id) throw new DomainError("invalid_reference", "Dependencies must be between tasks in the same project.");
  if (get("SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on_id = ?", taskId, dependsOnId)) {
    throw new DomainError("conflict", `“${a.title}” already depends on “${b.title}”.`);
  }
  const cycle = findCycle(taskId, dependsOnId);
  if (cycle) {
    const titles = [a.title, ...cycle.map((id) => get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", id)?.title ?? id)];
    throw new DomainError("circular_dependency", `Circular dependency rejected: ${titles.map((t) => `“${t}”`).join(" → ")}.`);
  }
  run("INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)", taskId, dependsOnId);
}

export function addDependency(taskId: string, dependsOnId: string, actor: Actor): TaskView {
  return tx(() => {
    const t = requireTask(taskId);
    addDependencyRaw(taskId, dependsOnId);
    const d = requireTask(dependsOnId);
    logActivity(actor, "task.dependency_added", "task", taskId, t.project_id, `“${t.title}” now depends on “${d.title}”`);
    return getTask(taskId)!;
  });
}

export function removeDependency(taskId: string, dependsOnId: string, actor: Actor): TaskView {
  return tx(() => {
    const t = requireTask(taskId);
    const res = run("DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?", taskId, dependsOnId);
    if (Number(res.changes) === 0) throw new DomainError("not_found", "That dependency does not exist.");
    const d = get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", dependsOnId);
    logActivity(actor, "task.dependency_removed", "task", taskId, t.project_id, `“${t.title}” no longer depends on “${d?.title ?? dependsOnId}”`);
    return getTask(taskId)!;
  });
}

export function allDependencies(projectId: string): { task_id: string; depends_on_id: string }[] {
  return all("SELECT d.* FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?", projectId);
}
