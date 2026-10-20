import { h, icon, mount } from "../dom.js";
import { api, qs } from "../api.js";
import { state, setCurrentProject } from "../state.js";
import { fmtDate, relTime, pill, statusPill, demoPill, progress, empty, skeleton, errorBox, avatar, toast } from "../ui.js";
import { memberById } from "../state.js";
import { timeline } from "../timeline.js";
import { taskDialog } from "../taskDialog.js";

export const DEMO_PROMPT =
  "We have three days until our hackathon submission. Create a project plan for four team members, break the work into tasks, assign owners, identify dependencies, check for scheduling conflicts, and show us the biggest risks.";

export function activityFeed(items) {
  if (!items.length) return empty("No activity recorded yet", "Approved plans and task updates will appear in this chronicle.");
  return h("ul", { class: "feed" }, items.map((a) =>
    h("li", null,
      h("span", { class: ["dot", a.actor] }, a.actor === "ai" ? "AI" : a.actor === "user" ? "You" : "Sys"),
      h("div", null, h("div", null, a.summary, a.is_demo ? " " : null, a.is_demo ? demoPill() : null), h("div", { class: "faint" }, a.action)),
      h("time", { datetime: a.ts, title: fmtDate(a.ts) }, relTime(a.ts)))));
}

function vitalItem(labelText, value, metaText, cls = "", suffix = "") {
  return h("div", { class: ["vital-item", cls] },
    h("div", { class: "vital-top" },
      h("span", { class: "vital-label" }, labelText),
      h("span", { class: "vital-num" }, String(value), suffix ? h("small", null, ` ${suffix}`) : null)
    ),
    h("div", { class: "vital-meta" }, metaText)
  );
}

export async function render(root, ctx) {
  mount(root, skeleton(4));
  let d;
  try { d = await api.get(`/api/dashboard${qs({ project: state.currentProjectId })}`); }
  catch (e) { mount(root, errorBox(e, () => render(root, ctx))); return; }
  if (ctx.cancelled()) return;

  const m = d.metrics;
  const focus = d.projects.find((p) => p.id === d.focus_project_id) || null;
  const total = m.tasks_total;
  const pctDone = total ? Math.round((m.tasks_done / total) * 100) : 0;

  // 1. Central AI Command Studio
  const input = h("input", {
    type: "text",
    id: "ask-input",
    maxlength: 2000,
    placeholder: "Describe a coordination goal, e.g., “Plan our final 72 hours before submission and assign owners”…",
    "aria-label": "Describe a goal for MissionControl AI"
  });
  const send = (text) => {
    if (!text.trim()) { input.focus(); return; }
    state.pendingPrompt = text.trim();
    location.hash = "#/assistant";
  };

  const commandStudio = h("section", { class: "command-studio", "aria-labelledby": "ask-h" },
    h("div", { class: "studio-head" },
      h("div", { class: "studio-title" },
        h("h2", { id: "ask-h" }, "What are we coordinating next?"),
        h("span", { class: "studio-badge" }, state.agent?.mode === "live" ? "Live Agent Ready" : "Interactive Scenario Ready")
      ),
      h("span", { class: "studio-sub" }, "Turns natural-language goals into reviewed, dependency-aware execution plans.")
    ),
    h("form", { class: "studio-form", onsubmit: (e) => { e.preventDefault(); send(input.value); } },
      input,
      h("button", { class: "btn btn-primary", type: "submit" }, icon("send", 15), "Coordinate Plan")
    ),
    h("div", { class: "studio-prompts" },
      h("span", { class: "studio-prompts-label" }, "Try:"),
      h("button", { class: "chip primary-chip", type: "button", onclick: () => send(DEMO_PROMPT) }, "Plan our final 72 hours before submission"),
      h("button", { class: "chip", type: "button", onclick: () => send("What are our biggest risks?") }, "Identify tasks that could delay our launch"),
      h("button", { class: "chip", type: "button", onclick: () => send("Who is overloaded?") }, "Balance the workload across our team")
    )
  );

  // 2. Editorial Vital Signs Ribbon (replaces the 6 boxy KPI cards)
  const vitalsRibbon = h("section", { class: "vitals-ribbon", "aria-label": "Workspace vital signs" },
    vitalItem("Completion Rate", `${pctDone}%`, `${m.tasks_done} of ${total} tasks completed`, pctDone === 100 && total > 0 ? "good" : ""),
    vitalItem("Overdue Attention", m.overdue, m.overdue ? "Past scheduled due time" : "All schedules on track", m.overdue ? "bad" : "good"),
    vitalItem("Dependency Locks", m.blocked, m.blocked ? "Awaiting upstream tasks" : "Zero blocked tasks", m.blocked ? "warn" : ""),
    vitalItem("Unassigned Work", m.unassigned_open, m.unassigned_open ? "Open tasks without an owner" : "Every task has an owner", m.unassigned_open ? "warn" : ""),
    vitalItem("7-Day Horizon", m.upcoming_7d, `Across ${m.active_projects} active workstream(s)`)
  );

  // 3. Primary Left Column: Execution Timeline + Critical Path & Team Capacity
  const openTask = (t) => taskDialog({ task: t, onSaved: () => render(root, ctx) });

  const timelineSection = h("section", { class: "ed-section", "aria-labelledby": "tl-h" },
    h("div", { class: "ed-head" },
      h("div", { class: "row" },
        h("h2", { id: "tl-h" }, focus ? `Execution Schedule — ${focus.name}` : "Execution Schedule"),
        focus ? statusPill(focus.status) : null
      ),
      h("span", { class: "sub" }, "Click any task bar to inspect or reschedule")
    ),
    d.timeline ? timeline({ project: d.timeline.project, tasks: d.timeline.tasks, deps: d.timeline.deps, onSelect: openTask })
      : empty("No active timeline", "Create a project or ask the coordinator above to draft a plan.", h("a", { class: "btn btn-primary", href: "#/projects" }, "Explore Workstreams"))
  );

  const r = d.risk;
  const riskSection = h("section", { class: "ed-section", "aria-labelledby": "risk-h" },
    h("div", { class: "ed-head" },
      h("h2", { id: "risk-h" }, "Risk & Bottleneck Briefing"),
      r ? pill(r.level === "none" ? "All clear" : `${r.level} exposure`, r.level === "high" ? "red" : r.level === "medium" ? "amber" : "green") : null
    ),
    !r ? empty("No risk telemetry", "Select an active project to evaluate schedule exposure.")
      : h("div", null,
        h("p", { class: "muted", style: { marginBottom: "12px" } }, r.summary),
        r.top.length ? r.top.map((k) => h("div", { class: ["risk", k.severity] },
          h("div", { class: "t" }, k.title, pill(k.severity, k.severity)),
          h("p", null, k.explanation))) : null,
        h("div", { class: "row", style: { justifyContent: "space-between", marginTop: "12px" } },
          h("span", { class: "disclaimer" }, "Derived live from task dependencies and deadlines."),
          h("button", { class: "btn btn-sm", type: "button", onclick: () => send("What are our biggest risks?") }, "Ask AI for mitigations →")
        ))
  );

  const maxH = Math.max(1, ...d.workload.map((w) => w.open_hours));
  const workloadSection = h("section", { class: "ed-section", "aria-labelledby": "wl-h" },
    h("div", { class: "ed-head" },
      h("h2", { id: "wl-h" }, "Team Capacity & Allocation"),
      h("span", { class: "sub" }, "Open estimated hours")
    ),
    d.workload.length ? h("div", null, d.workload.map((w) => h("div", { class: "bar-row" },
      h("div", { class: "who" }, h("i", { class: "swatch", style: { background: w.color } }), h("span", { title: w.role }, w.name)),
      h("div", { class: "progress", role: "img", "aria-label": `${w.name}: ${w.open_hours} open hours across ${w.open_tasks} tasks` }, h("span", { style: { width: `${(w.open_hours / maxH) * 100}%`, background: w.color } })),
      h("div", { class: "num" }, `${w.open_tasks} · ${w.open_hours}h`))))
      : empty("No team members", "Add teammates in the Team view."),
    m.unassigned_open ? h("p", { class: "disclaimer" }, `${m.unassigned_open} open task(s) are currently unassigned.`) : null
  );

  // 4. Right Editorial Rail: Immediate Priorities (Overdue + Deadlines), Active Workstreams, Chronicle
  const overdueBlock = d.overdue.length ? h("section", { class: "ed-section", "aria-labelledby": "od-h" },
    h("div", { class: "ed-head" },
      h("h2", { id: "od-h" }, "Requires Immediate Action"),
      pill(`${d.overdue.length} overdue`, "red")
    ),
    h("ul", { class: "list" }, d.overdue.map((t) => h("li", null,
      h("div", null,
        h("button", { class: "link-btn", type: "button", onclick: () => openTask(t) }, t.title),
        h("div", { class: "sub" }, `Due ${fmtDate(t.due_at)} (${relTime(t.due_at)}) · ${t.assignee_name || "Unassigned"}`)
      ),
      statusPill(t.status)
    )))
  ) : null;

  const upcomingItems = [
    ...d.upcoming.project_deadlines.map((p) => ({ when: p.deadline, el: h("li", null, h("div", null, h("div", { class: "title" }, p.name), h("div", { class: "sub" }, "Project milestone deadline")), h("span", { class: "pill red" }, relTime(p.deadline))) })),
    ...d.upcoming.tasks.map((t) => ({ when: t.due_at, el: h("li", null, h("div", null, h("button", { class: "link-btn", type: "button", onclick: () => openTask(t) }, t.title), h("div", { class: "sub" }, `${fmtDate(t.due_at)} · ${t.assignee_name || "Unassigned"}`)), statusPill(t.status)) })),
  ].sort((a, b) => a.when.localeCompare(b.when));

  const deadlinesSection = h("section", { class: "ed-section", "aria-labelledby": "up-h" },
    h("div", { class: "ed-head" },
      h("h2", { id: "up-h" }, "Upcoming Milestones (7d)"),
      h("a", { href: "#/tasks", class: "sub" }, "All tasks →")
    ),
    upcomingItems.length ? h("ul", { class: "list" }, upcomingItems.map((x) => x.el))
      : empty("Clear horizon", "No tasks or deadlines due within the next 7 days.")
  );

  const projectsSection = h("section", { class: "ed-section", "aria-labelledby": "pj-h" },
    h("div", { class: "ed-head" },
      h("h2", { id: "pj-h" }, "Active Workstreams"),
      h("a", { href: "#/projects", class: "sub" }, "Manage →")
    ),
    d.projects.length ? h("ul", { class: "list" }, d.projects.map((p) => h("li", { style: { flexDirection: "column", alignItems: "stretch", gap: "8px" } },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("a", { href: "#/tasks", class: "title", onclick: () => setCurrentProject(p.id) }, p.name),
        h("span", { class: "row" }, p.is_demo ? demoPill() : null, statusPill(p.status))
      ),
      progress(p.progress ?? 0, p.progress === 1),
      h("div", { class: "sub" }, `${p.tasks_done} of ${p.tasks_total} tasks completed${p.deadline ? ` · target ${fmtDate(p.deadline)}` : ""}`)
    ))) : empty("No workstreams", "Create your first project.", h("a", { class: "btn btn-primary", href: "#/projects" }, "New Workstream"))
  );

  const feedSection = h("section", { class: "ed-section", "aria-labelledby": "ac-h" },
    h("div", { class: "ed-head" },
      h("h2", { id: "ac-h" }, "Coordination Chronicle"),
      h("a", { href: "#/activity", class: "sub" }, "Full history →")
    ),
    activityFeed(d.activity)
  );

  // 5. Compose the Complete Editorial Workspace
  mount(root,
    h("header", { class: "page-head" },
      h("div", null,
        h("div", { class: "eyebrow" }, focus ? `Active Workstream · ${focus.status.replace(/_/g, " ")}` : "Workspace Command"),
        h("h1", null, focus ? focus.name : "MissionControl Workspace"),
        h("p", null, focus?.description || "A living command center where natural-language goals become reviewed plans, clear ownership, and coordinated team execution.")
      ),
      h("div", { class: "actions" },
        h("a", { class: "btn", href: "#/assistant" }, icon("sparkles", 16), "Open AI Coordinator"),
        h("button", { class: "btn btn-primary", type: "button", onclick: () => taskDialog({ onSaved: () => render(root, ctx) }) }, icon("plus", 16), "New Task")
      )
    ),
    commandStudio,
    vitalsRibbon,
    h("div", { class: "editorial-grid" },
      h("div", { class: "editorial-main" },
        timelineSection,
        h("div", { class: "grid cols-2" }, riskSection, workloadSection)
      ),
      h("aside", { class: "editorial-rail", "aria-label": "Priorities and activity" },
        overdueBlock,
        deadlinesSection,
        projectsSection,
        feedSection
      )
    )
  );
}