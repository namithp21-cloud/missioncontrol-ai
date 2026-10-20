/**
 * Scheduling and risk analysis. Pure functions: given a snapshot of a project, return findings.
 * Everything here is a transparent heuristic - it flags where a plan looks fragile and explains why.
 * It never claims to predict that something WILL be late.
 */
import type { Member, ProjectView, TaskView } from "./store.ts";

export type Severity = "high" | "medium" | "low";

export interface Risk {
  id: string;
  severity: Severity;
  type: string;
  title: string;
  explanation: string;
  mitigation: string;
  task_ids: string[];
  member_id?: string;
}

export interface OverlapConflict {
  member_id: string;
  member_name: string;
  from: string;
  to: string;
  demand_hours: number;
  capacity_hours: number;
  ratio: number;
  task_ids: string[];
  kind: "overlap" | "tight_window";
}

export interface WorkloadRow {
  member_id: string;
  name: string;
  role: string;
  color: string;
  open_tasks: number;
  open_hours: number;
  done_tasks: number;
  overdue_tasks: number;
  share_of_open_hours: number | null;
}

export interface RiskReport {
  project_id: string;
  project_name: string;
  generated_at: string;
  level: "high" | "medium" | "low" | "none";
  summary: string;
  risks: Risk[];
  blocked: { task_id: string; title: string; waiting_on: { id: string; title: string; status: string; due_at: string | null }[] }[];
  overdue: { task_id: string; title: string; hours_overdue: number }[];
  unassigned: { task_id: string; title: string; priority: string }[];
  overlaps: OverlapConflict[];
  workload: WorkloadRow[];
  critical_chain: { task_ids: string[]; focus_hours: number; wall_hours: number; hours_remaining: number | null } | null;
  coverage: { open_tasks: number; schedulable_tasks: number };
  disclaimer: string;
}

export const DISCLAIMER =
  "Heuristic analysis of the data in this workspace. It highlights where the plan looks fragile; it does not predict outcomes, and estimates can be wrong.";

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const isOpen = (t: Pick<TaskView, "status">) => t.status !== "done";
const h1 = (n: number) => `${Math.round(n * 10) / 10}h`;

function until(iso: string, now: Date): string {
  const diff = (new Date(iso).getTime() - now.getTime()) / 3_600_000;
  if (Math.abs(diff) < 1) return diff < 0 ? "less than an hour ago" : "in less than an hour";
  const abs = Math.abs(diff);
  const txt = abs < 48 ? `${Math.round(abs)}h` : `${Math.round(abs / 24)}d`;
  return diff < 0 ? `${txt} ago` : `in ${txt}`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day} ${time} UTC`;
}

export function computeWorkload(tasks: TaskView[], members: Member[]): WorkloadRow[] {
  const open = tasks.filter(isOpen);
  const totalHours = open.reduce((s, t) => s + (t.estimate_hours ?? 0), 0);
  return members.map((m) => {
    const mine = tasks.filter((t) => t.assignee_id === m.id);
    const mineOpen = mine.filter(isOpen);
    const hours = mineOpen.reduce((s, t) => s + (t.estimate_hours ?? 0), 0);
    return {
      member_id: m.id,
      name: m.name,
      role: m.role,
      color: m.color,
      open_tasks: mineOpen.length,
      open_hours: Math.round(hours * 10) / 10,
      done_tasks: mine.length - mineOpen.length,
      overdue_tasks: mineOpen.filter((t) => t.is_overdue).length,
      share_of_open_hours: totalHours > 0 ? hours / totalHours : null,
    };
  });
}

/** Finds windows where a member's overlapping tasks need more focused hours than their stated daily capacity provides. */
export function findOverlaps(tasks: TaskView[], members: Member[], now: Date): { conflicts: OverlapConflict[]; schedulable: number } {
  const conflicts: OverlapConflict[] = [];
  let schedulable = 0;
  const nowMs = now.getTime();
  for (const m of members) {
    const items = tasks
      .filter((t) => isOpen(t) && t.assignee_id === m.id && t.start_at && t.due_at && (t.estimate_hours ?? 0) > 0)
      .map((t) => ({
        t,
        s: Math.max(new Date(t.start_at!).getTime(), nowMs),
        e: new Date(t.due_at!).getTime(),
        est: t.estimate_hours!,
      }))
      .filter((x) => x.e > x.s);
    schedulable += items.length;
    if (!items.length) continue;
    const rate = m.daily_hours / 24; // focused hours available per wall-clock hour
    const points = [...new Set(items.flatMap((x) => [x.s, x.e]))].sort((a, b) => a - b);
    let cur: { from: number; to: number; demand: number; cap: number; ids: Set<string> } | null = null;
    const flush = () => {
      if (!cur) return;
      const kind = cur.ids.size > 1 ? "overlap" : "tight_window";
      conflicts.push({
        member_id: m.id,
        member_name: m.name,
        from: new Date(cur.from).toISOString(),
        to: new Date(cur.to).toISOString(),
        demand_hours: Math.round(cur.demand * 10) / 10,
        capacity_hours: Math.round(cur.cap * 10) / 10,
        ratio: Math.round((cur.demand / cur.cap) * 100) / 100,
        task_ids: [...cur.ids],
        kind,
      });
      cur = null;
    };
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const active = items.filter((x) => x.s <= a && x.e >= b);
      const lenH = (b - a) / 3_600_000;
      const demand = active.reduce((s, x) => s + x.est * ((b - a) / (x.e - x.s)), 0);
      const cap = lenH * rate;
      if (active.length && demand > cap * 1.05) {
        if (cur && cur.to === a) {
          cur.to = b; cur.demand += demand; cur.cap += cap;
          active.forEach((x) => cur!.ids.add(x.t.id));
        } else {
          flush();
          cur = { from: a, to: b, demand, cap, ids: new Set(active.map((x) => x.t.id)) };
        }
      } else flush();
    }
    flush();
  }
  // ignore slivers: a shortfall under an hour is noise, not a scheduling problem
  return { conflicts: conflicts.filter((c) => c.demand_hours - c.capacity_hours >= 1), schedulable };
}

function criticalChain(open: TaskView[], deps: { task_id: string; depends_on_id: string }[], members: Member[]) {
  const byId = new Map(open.map((t) => [t.id, t]));
  const memberById = new Map(members.map((m) => [m.id, m]));
  const depMap = new Map<string, string[]>();
  for (const d of deps) {
    if (byId.has(d.task_id) && byId.has(d.depends_on_id)) depMap.set(d.task_id, [...(depMap.get(d.task_id) ?? []), d.depends_on_id]);
  }
  const wall = (t: TaskView) => {
    const rate = (memberById.get(t.assignee_id ?? "")?.daily_hours ?? 6) / 24;
    return (t.estimate_hours ?? 0) / rate;
  };
  const memo = new Map<string, { wall: number; focus: number; path: string[] }>();
  const visiting = new Set<string>();
  const walk = (id: string): { wall: number; focus: number; path: string[] } => {
    const hit = memo.get(id);
    if (hit) return hit;
    const t = byId.get(id)!;
    if (visiting.has(id)) return { wall: 0, focus: 0, path: [] }; // defensive; the store rejects cycles
    visiting.add(id);
    let best = { wall: 0, focus: 0, path: [] as string[] };
    for (const dep of depMap.get(id) ?? []) {
      const r = walk(dep);
      if (r.wall > best.wall) best = r;
    }
    visiting.delete(id);
    const out = { wall: best.wall + wall(t), focus: best.focus + (t.estimate_hours ?? 0), path: [...best.path, id] };
    memo.set(id, out);
    return out;
  };
  let best: { wall: number; focus: number; path: string[] } | null = null;
  for (const t of open) {
    const r = walk(t.id);
    if (!best || r.wall > best.wall) best = r;
  }
  return best && best.path.length >= 2 ? best : null;
}

export interface RiskInput {
  now: Date;
  project: Pick<ProjectView, "id" | "name" | "deadline" | "status">;
  tasks: TaskView[];
  deps: { task_id: string; depends_on_id: string }[];
  members: Member[];
}

export function analyzeRisks(input: RiskInput): RiskReport {
  const { now, project, tasks, deps, members } = input;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = tasks.filter(isOpen);
  const risks: Risk[] = [];
  const title = (id: string) => byId.get(id)?.title ?? id;
  const deadlineMs = project.deadline ? new Date(project.deadline).getTime() : null;
  const critical = (t: TaskView) => t.priority === "critical" || t.priority === "high";

  // 1. project deadline already passed
  if (deadlineMs !== null && deadlineMs < now.getTime() && open.length > 0 && project.status === "active") {
    risks.push({
      id: "deadline_passed", severity: "high", type: "deadline_passed",
      title: "Project deadline has passed with open work",
      explanation: `The deadline was ${clock(project.deadline!)} (${until(project.deadline!, now)}) and ${open.length} task(s) are still open.`,
      mitigation: "Agree a new deadline, or cut scope to the tasks that are essential, then update the project deadline.",
      task_ids: open.map((t) => t.id),
    });
  }

  // 2. overdue tasks
  const overdue = open.filter((t) => t.is_overdue);
  for (const t of overdue) {
    risks.push({
      id: `overdue:${t.id}`, severity: critical(t) ? "high" : "medium", type: "overdue",
      title: `Overdue: ${t.title}`,
      explanation: `“${t.title}” was due ${until(t.due_at!, now)} and is still ${t.status.replace("_", " ")}${t.assignee_name ? ` (owner: ${t.assignee_name})` : " with no owner"}.`,
      mitigation: "Finish it now, move its due date to something realistic, or drop it if it is no longer needed.",
      task_ids: [t.id],
    });
  }

  // 3. tasks due after the project deadline
  if (deadlineMs !== null) {
    for (const t of open) {
      if (t.due_at && new Date(t.due_at).getTime() > deadlineMs) {
        risks.push({
          id: `after_deadline:${t.id}`, severity: "high", type: "after_deadline",
          title: `Due after the project deadline: ${t.title}`,
          explanation: `“${t.title}” is due ${clock(t.due_at)}, which is after the project deadline (${clock(project.deadline!)}).`,
          mitigation: "Pull the due date earlier, split the task, or negotiate the project deadline.",
          task_ids: [t.id],
        });
      }
    }
  }

  // 4. dependency timing problems + blocked tasks
  const blocked: RiskReport["blocked"] = [];
  for (const t of open) {
    const waiting = t.depends_on.map((id) => byId.get(id)).filter((d): d is TaskView => !!d && isOpen(d));
    if (waiting.length) {
      blocked.push({
        task_id: t.id, title: t.title,
        waiting_on: waiting.map((d) => ({ id: d.id, title: d.title, status: d.status, due_at: d.due_at })),
      });
    }
    for (const d of waiting) {
      if (t.due_at && d.due_at && new Date(d.due_at).getTime() > new Date(t.due_at).getTime()) {
        risks.push({
          id: `dep_inversion:${t.id}:${d.id}`, severity: "high", type: "dependency_conflict",
          title: `Schedule conflict: ${t.title} is due before its dependency`,
          explanation: `“${t.title}” is due ${clock(t.due_at)} but depends on “${d.title}”, which is not due until ${clock(d.due_at)}.`,
          mitigation: "Move the dependent task later, finish the dependency earlier, or remove the dependency if it is not truly needed.",
          task_ids: [t.id, d.id],
        });
      } else if (d.is_overdue) {
        risks.push({
          id: `blocked_overdue:${t.id}:${d.id}`, severity: critical(t) ? "high" : "medium", type: "blocked",
          title: `Blocked by an overdue task: ${t.title}`,
          explanation: `“${t.title}” cannot start cleanly until “${d.title}” is done, and that task is already overdue.`,
          mitigation: "Unblock the dependency first (reassign or help), or start the dependent task on the parts that do not need it.",
          task_ids: [t.id, d.id],
        });
      } else if (!d.assignee_id) {
        risks.push({
          id: `blocked_unowned:${t.id}:${d.id}`, severity: "medium", type: "blocked",
          title: `Waiting on an unassigned task: ${t.title}`,
          explanation: `“${t.title}” depends on “${d.title}”, which has no owner, so nobody is currently responsible for unblocking it.`,
          mitigation: "Assign an owner to the dependency.",
          task_ids: [t.id, d.id],
        });
      }
    }
  }

  // 5. unassigned tasks
  const unassigned = open.filter((t) => !t.assignee_id);
  for (const t of unassigned) {
    risks.push({
      id: `unassigned:${t.id}`, severity: t.priority === "critical" ? "high" : "medium", type: "unassigned",
      title: `Unassigned: ${t.title}`,
      explanation: `“${t.title}” (${t.priority} priority) has no owner, so it may not get picked up.`,
      mitigation: "Assign it to the teammate with the most available capacity in the Team view.",
      task_ids: [t.id],
    });
  }

  // 6. overlapping commitments (needs start time, due time, estimate and an owner)
  const { conflicts, schedulable } = findOverlaps(open, members, now);
  const byMember = new Map<string, OverlapConflict[]>();
  for (const c of conflicts) byMember.set(c.member_id, [...(byMember.get(c.member_id) ?? []), c]);
  for (const [memberId, list] of byMember) {
    const sorted = [...list].sort((a, b) => b.ratio - a.ratio);
    const worst = sorted[0];
    const hasOverlap = list.some((c) => c.kind === "overlap");
    const ids = [...new Set(list.flatMap((c) => c.task_ids))];
    const lines = sorted.slice(0, 2).map((c) => {
      const names = c.task_ids.map(title).map((s) => `“${s}”`).join(", ");
      return `Between ${clock(c.from)} and ${clock(c.to)} they are scheduled for ${h1(c.demand_hours)} of work (${names}) against roughly ${h1(c.capacity_hours)} of stated capacity.`;
    });
    const more = sorted.length > 2 ? ` (${sorted.length - 2} more window${sorted.length === 3 ? "" : "s"} like this)` : "";
    risks.push({
      id: `overlap:${memberId}`,
      severity: worst.demand_hours - worst.capacity_hours >= 4 || (worst.ratio >= 2 && worst.demand_hours - worst.capacity_hours >= 2) ? "high" : "medium",
      type: hasOverlap ? "overlap" : "tight_window",
      title: hasOverlap ? `${worst.member_name} has overlapping commitments` : `${worst.member_name}'s estimates may not fit their time windows`,
      explanation: `${lines.join(" ")}${more} This could slip or force late nights.`,
      mitigation: hasOverlap
        ? "Stagger the start times, hand one of these tasks to a teammate with spare capacity, or reduce the scope of one."
        : "Extend the windows, cut the scope, or split the work across people.",
      task_ids: ids,
      member_id: memberId,
    });
  }

  // 7. concentration of work on one person
  const workload = computeWorkload(tasks, members);
  const totalOpenHours = open.reduce((s, t) => s + (t.estimate_hours ?? 0), 0);
  if (members.length >= 2 && totalOpenHours >= 8) {
    for (const w of workload) {
      if (w.share_of_open_hours !== null && w.share_of_open_hours > 0.4 && members.length >= 3) {
        risks.push({
          id: `concentration:${w.member_id}`, severity: "medium", type: "workload",
          title: `${w.name} carries ${Math.round(w.share_of_open_hours * 100)}% of the open work`,
          explanation: `${w.name} holds ${h1(w.open_hours)} of ${h1(totalOpenHours)} estimated open hours. If they are unavailable, much of the plan is exposed.`,
          mitigation: "Rebalance a few tasks to teammates with lighter workloads, or pair on the riskiest one.",
          task_ids: open.filter((t) => t.assignee_id === w.member_id).map((t) => t.id),
          member_id: w.member_id,
        });
      }
    }
  }

  // 8. critical dependency chain vs. time remaining
  const chain = criticalChain(open, deps, members);
  let chainOut: RiskReport["critical_chain"] = null;
  if (chain) {
    const remaining = deadlineMs !== null ? (deadlineMs - now.getTime()) / 3_600_000 : null;
    chainOut = {
      task_ids: chain.path, focus_hours: Math.round(chain.focus * 10) / 10,
      wall_hours: Math.round(chain.wall * 10) / 10, hours_remaining: remaining === null ? null : Math.round(remaining * 10) / 10,
    };
    if (remaining !== null && remaining > 0 && chain.wall > remaining * 0.7) {
      const over = chain.wall > remaining;
      risks.push({
        id: "critical_chain", severity: over ? "high" : "medium", type: "critical_chain",
        title: over ? "The longest dependency chain may not fit before the deadline" : "The longest dependency chain uses most of the remaining time",
        explanation:
          `The chain ${chain.path.map(title).map((s) => `“${s}”`).join(" → ")} needs about ${h1(chain.focus)} of focused work. ` +
          `At each owner's stated daily capacity that is roughly ${h1(chain.wall)} of calendar time, against ${h1(remaining)} remaining. ` +
          `Tasks in a chain cannot run in parallel, so there is ${over ? "no" : "little"} slack.`,
        mitigation: "Shorten the chain: make some of these tasks run in parallel, trim scope on the longest ones, or start the earliest task now.",
        task_ids: chain.path,
      });
    }
  }

  // 9. thin buffer before the deadline
  if (deadlineMs !== null && deadlineMs > now.getTime()) {
    const lastDue = open.filter((t) => t.due_at).map((t) => new Date(t.due_at!).getTime()).sort((a, b) => b - a)[0];
    if (lastDue !== undefined && lastDue <= deadlineMs && (deadlineMs - lastDue) / 3_600_000 < 2 && open.length >= 4) {
      const last = open.filter((t) => t.due_at && new Date(t.due_at).getTime() === lastDue);
      risks.push({
        id: "thin_buffer", severity: "medium", type: "thin_buffer",
        title: "Almost no buffer before the deadline",
        explanation: `The last open task is due ${Math.round(((deadlineMs - lastDue) / 3_600_000) * 10) / 10}h before the project deadline, leaving little room for surprises or a failed upload.`,
        mitigation: "Aim to finish the final tasks at least a few hours early, and rehearse the submission steps beforehand.",
        task_ids: last.map((t) => t.id),
      });
    }
  }

  // 10. tasks that cannot be checked
  const unscheduled = open.filter((t) => !t.due_at);
  if (unscheduled.length) {
    risks.push({
      id: "no_due_date", severity: "low", type: "no_due_date",
      title: `${unscheduled.length} open task(s) have no due date`,
      explanation: "Without a due date these tasks are invisible to deadline and overlap checks, so problems with them cannot be flagged.",
      mitigation: "Give each one a due date (and a start time and estimate for overlap checks).",
      task_ids: unscheduled.map((t) => t.id),
    });
  }

  risks.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.task_ids.length - a.task_ids.length);
  const high = risks.filter((r) => r.severity === "high").length;
  const med = risks.filter((r) => r.severity === "medium").length;
  const low = risks.length - high - med;
  const level: RiskReport["level"] = high ? "high" : med ? "medium" : low ? "low" : "none";
  const summary = risks.length === 0
    ? open.length === 0 ? "No open tasks, so there is nothing to flag." : "No scheduling risks found in the current data."
    : `${risks.length} possible risk${risks.length === 1 ? "" : "s"} found: ${high} high, ${med} medium, ${low} low.`;

  return {
    project_id: project.id,
    project_name: project.name,
    generated_at: now.toISOString(),
    level,
    summary,
    risks,
    blocked,
    overdue: overdue.map((t) => ({ task_id: t.id, title: t.title, hours_overdue: Math.round(((now.getTime() - new Date(t.due_at!).getTime()) / 3_600_000) * 10) / 10 })),
    unassigned: unassigned.map((t) => ({ task_id: t.id, title: t.title, priority: t.priority })),
    overlaps: conflicts,
    workload,
    critical_chain: chainOut,
    coverage: { open_tasks: open.length, schedulable_tasks: schedulable },
    disclaimer: DISCLAIMER,
  };
}
