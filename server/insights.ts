import { allDependencies, getProject, listActivity, listMembers, listProjects, listTasks } from "./store.ts";
import type { ProjectView, TaskView } from "./store.ts";
import { analyzeRisks, computeWorkload } from "./risk.ts";
import type { RiskReport } from "./risk.ts";
import { DomainError, now } from "./util.ts";

export function riskReportForProject(projectId: string): RiskReport {
  const project = getProject(projectId);
  if (!project) throw new DomainError("not_found", `Project "${projectId}" does not exist.`);
  return analyzeRisks({
    now: now(),
    project,
    tasks: listTasks({ project_id: projectId }),
    deps: allDependencies(projectId),
    members: listMembers(),
  });
}

/** Everything the dashboard shows is derived from rows in the database at request time. */
export function buildDashboard(focusProjectId?: string) {
  const current = now();
  const projects = listProjects();
  const members = listMembers();
  const tasks = listTasks();
  const open = tasks.filter((t) => t.status !== "done");
  const horizon = current.getTime() + 7 * 24 * 3_600_000;

  const upcomingTasks = open
    .filter((t) => t.due_at && new Date(t.due_at).getTime() >= current.getTime() && new Date(t.due_at).getTime() <= horizon)
    .sort((a, b) => a.due_at!.localeCompare(b.due_at!))
    .slice(0, 8);
  const upcomingProjects = projects
    .filter((p) => p.status === "active" && p.deadline && new Date(p.deadline).getTime() >= current.getTime() && new Date(p.deadline).getTime() <= horizon)
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!));

  const focus: ProjectView | undefined =
    projects.find((p) => p.id === focusProjectId) ?? projects.find((p) => p.status === "active") ?? projects[0];

  let timeline: null | { project: ProjectView; tasks: TaskView[]; deps: { task_id: string; depends_on_id: string }[] } = null;
  let risk: RiskReport | null = null;
  if (focus) {
    const projectTasks = tasks.filter((t) => t.project_id === focus.id);
    const deps = allDependencies(focus.id);
    timeline = { project: focus, tasks: projectTasks, deps };
    risk = analyzeRisks({ now: current, project: focus, tasks: projectTasks, deps, members });
  }

  return {
    generated_at: current.toISOString(),
    metrics: {
      active_projects: projects.filter((p) => p.status === "active").length,
      total_projects: projects.length,
      tasks_total: tasks.length,
      tasks_done: tasks.length - open.length,
      tasks_open: open.length,
      overdue: open.filter((t) => t.is_overdue).length,
      blocked: open.filter((t) => t.is_blocked).length,
      unassigned_open: open.filter((t) => !t.assignee_id).length,
      upcoming_7d: upcomingTasks.length + upcomingProjects.length,
    },
    upcoming: { tasks: upcomingTasks, project_deadlines: upcomingProjects },
    overdue: open.filter((t) => t.is_overdue),
    workload: computeWorkload(tasks, members),
    activity: listActivity({ limit: 12 }),
    projects,
    focus_project_id: focus?.id ?? null,
    timeline,
    risk: risk && { level: risk.level, summary: risk.summary, top: risk.risks.slice(0, 3), counts: {
      high: risk.risks.filter((r) => r.severity === "high").length,
      medium: risk.risks.filter((r) => r.severity === "medium").length,
      low: risk.risks.filter((r) => r.severity === "low").length,
    } },
  };
}
