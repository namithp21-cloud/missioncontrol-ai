import { h, icon, mount } from "./dom.js";
import { api } from "./api.js";
import { state, bus, refreshCore, setCurrentProject } from "./state.js";
import { toast, confirmDialog, errorBox } from "./ui.js";

const ROUTES = [
  { id: "dashboard", label: "Command Center", icon: "dashboard", load: () => import("./views/dashboard.js") },
  { id: "assistant", label: "AI Coordinator", icon: "sparkles", load: () => import("./views/assistant.js") },
  { id: "projects", label: "Workstreams", icon: "folder", load: () => import("./views/projects.js") },
  { id: "tasks", label: "Task Ledger", icon: "tasks", load: () => import("./views/tasks.js") },
  { id: "team", label: "Team & Capacity", icon: "users", load: () => import("./views/team.js") },
  { id: "activity", label: "Chronicle", icon: "activity", load: () => import("./views/activity.js") },
];

const app = document.getElementById("app");
const view = document.getElementById("view");
let token = 0;
let currentRoute = null;

function routeFromHash() {
  const id = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "dashboard";
  return ROUTES.find((r) => r.id === id) || ROUTES[0];
}

async function show({ focus = false } = {}) {
  const route = routeFromHash();
  currentRoute = route;
  const mine = ++token;
  renderNav();
  document.title = `${route.label} · MissionControl AI`;
  closeNav();
  try {
    const mod = await route.load();
    if (mine !== token) return;
    await mod.render(view, { cancelled: () => mine !== token });
  } catch (e) {
    console.error("View load error:", e);
    if (mine === token) mount(view, errorBox(e, () => show()));
  }
  if (focus && mine === token) view.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- chrome
let counts = { overdue: 0, blocked: 0, unassigned: 0, tasks: 0 };

function renderNav() {
  const navEl = document.getElementById("nav");
  if (!navEl) return;
  mount(navEl, ROUTES.map((r) => h("a", { href: `#/${r.id}`, "aria-current": currentRoute?.id === r.id ? "page" : null, title: r.label },
    icon(r.icon, 18), h("span", { class: "label" }, r.label),
    r.id === "tasks" && counts.tasks ? h("span", { class: "count", "aria-label": `${counts.tasks} open tasks` }, String(counts.tasks)) : null)));
}

function renderChrome() {
  const a = state.agent;
  const chip = document.getElementById("mode-chip");
  if (chip) {
    chip.className = `mode-chip ${a?.mode === "live" ? "live" : "demo"}`;
    mount(chip,
      h("strong", null, a?.mode === "live" ? "Live Claude Agent" : "Guided Scenario Engine"),
      a?.mode === "live" ? `${a.provider} · ${a.model}` : "Deterministic planning active"
    );
  }

  const resetBtn = document.getElementById("reset-demo");
  if (resetBtn) {
    mount(resetBtn, icon("refresh", 15), h("span", { class: "btn-label" }, "Restore Baseline"));
  }

  const collapseBtn = document.getElementById("collapse");
  if (collapseBtn) {
    const collapsed = app?.dataset.collapsed === "true";
    mount(collapseBtn, icon(collapsed ? "right" : "left", 15), h("span", { class: "btn-label" }, "Compact Rail"));
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  }

  const wsEl = document.getElementById("workspace");
  if (wsEl) {
    mount(wsEl,
      h("div", { class: "workspace" },
        h("span", { class: "ws-name" }, "Product & Engineering"),
        h("span", { class: "ws-sub" }, "· Active Coordination Workspace")
      )
    );
  }

  const projEl = document.getElementById("topbar-project");
  if (projEl) {
    const sel = h("select", { "aria-label": "Current project", onchange: (e) => { setCurrentProject(e.target.value || null); show(); } },
      ...(state.projects.length ? state.projects.map((p) => h("option", { value: p.id, selected: p.id === state.currentProjectId }, p.name)) : [h("option", { value: "" }, "No projects")]));
    mount(projEl, sel);
  }

  const menuBtn = document.getElementById("menu-btn");
  if (menuBtn) mount(menuBtn, icon("menu", 18));

  const nb = document.getElementById("notif-btn");
  if (nb) {
    const total = counts.overdue + counts.blocked + counts.unassigned;
    mount(nb, icon("bell", 18), total ? h("span", { class: "badge-dot", "aria-hidden": "true" }, String(total)) : null);
    nb.setAttribute("aria-label", total ? `Notifications: ${total} item(s) need attention` : "Notifications: nothing needs attention");
  }
}

async function refreshCounts() {
  try {
    const d = await api.get("/api/dashboard");
    counts = { overdue: d.metrics.overdue, blocked: d.metrics.blocked, unassigned: d.metrics.unassigned_open, tasks: d.metrics.tasks_open, overdueList: d.overdue };
    renderNav();
    renderChrome();
  } catch (e) {
    console.warn("Counts refresh warning:", e);
  }
}

async function refreshNotifications() {
  const pop = document.getElementById("notif-pop");
  if (!pop) return;
  const items = [];
  if (counts.overdue) items.push(["Overdue tasks", `${counts.overdue} open task(s) are past their due time`, "#/tasks"]);
  if (counts.blocked) items.push(["Blocked tasks", `${counts.blocked} task(s) wait on unfinished dependencies`, "#/tasks"]);
  if (counts.unassigned) items.push(["Unassigned tasks", `${counts.unassigned} open task(s) have no owner`, "#/team"]);
  mount(pop, h("h3", null, "Attention Required"),
    items.length ? h("ul", null, items.map(([t, s, href]) => h("li", null, h("a", { href, onclick: () => togglePop(false) }, h("strong", null, t), h("span", { class: "sub" }, s)))))
      : h("p", { class: "muted" }, "All clear: no overdue, blocked, or unassigned tasks."));
}

function togglePop(open) {
  const pop = document.getElementById("notif-pop"), btn = document.getElementById("notif-btn");
  if (!pop || !btn) return;
  if (open === undefined) open = pop.hidden;
  if (open) refreshNotifications();
  pop.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
}

function closeNav() {
  if (!app) return;
  delete app.dataset.navOpen;
  const scrim = document.getElementById("scrim");
  const menuBtn = document.getElementById("menu-btn");
  if (scrim) scrim.hidden = true;
  if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
}

function wireChrome() {
  const collapse = document.getElementById("collapse");
  if (collapse) {
    collapse.addEventListener("click", () => {
      app.dataset.collapsed = String(app.dataset.collapsed !== "true");
      try { localStorage.setItem("mc.collapsed", app.dataset.collapsed); } catch { /* ignore */ }
      renderChrome();
    });
  }

  const menuBtn = document.getElementById("menu-btn");
  const scrim = document.getElementById("scrim");
  if (menuBtn && scrim) {
    menuBtn.addEventListener("click", () => {
      app.dataset.navOpen = "true";
      scrim.hidden = false;
      menuBtn.setAttribute("aria-expanded", "true");
    });
    scrim.addEventListener("click", closeNav);
  }

  const notifBtn = document.getElementById("notif-btn");
  if (notifBtn) {
    notifBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePop(); });
  }

  document.addEventListener("click", (e) => { if (!e.target.closest(".notif-wrap")) togglePop(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { togglePop(false); closeNav(); } });
  
  const dlg = document.getElementById("dialog");
  if (dlg) dlg.addEventListener("click", (e) => { if (e.target.id === "dialog") e.target.close(); });

  const resetBtn = document.getElementById("reset-demo");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Restore workspace baseline?",
        text: "This resets seeded demonstration tasks and conversations back to their initial state. Any custom projects or teammates you added manually are preserved.",
        confirmLabel: "Restore baseline", danger: true,
      });
      if (!ok) return;
      try {
        await api.post("/api/demo/reset");
        toast("Workspace restored to its baseline state.", "success");
        state.currentProjectId = null;
        await refreshCore();
        await refreshCounts();
        location.hash = "#/dashboard";
        show();
      } catch (e) { toast(e.message, "error"); }
    });
  }

  window.addEventListener("hashchange", () => show({ focus: true }));
  bus.addEventListener("data-changed", () => { refreshCounts(); });
  bus.addEventListener("core-refreshed", () => { renderChrome(); });
}

async function boot() {
  try { if (app) app.dataset.collapsed = localStorage.getItem("mc.collapsed") === "true" ? "true" : "false"; } catch { if (app) app.dataset.collapsed = "false"; }
  wireChrome();
  renderNav();
  try {
    await refreshCore();
  } catch (e) {
    console.error("Core refresh error:", e);
    mount(view, errorBox(e, () => location.reload()));
    return;
  }
  renderChrome();
  refreshCounts();
  await show();
}

boot();