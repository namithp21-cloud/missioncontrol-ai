import { h, icon, mount } from "../dom.js";
import { api, qs } from "../api.js";
import { state, setCurrentProject, memberById, bus } from "../state.js";
import { fmtDate, relTime, pill, statusPill, demoPill, empty, skeleton, errorBox, avatar, memberOptions, toast, label } from "../ui.js";
import { taskDialog } from "../taskDialog.js";

const COLUMNS = [["todo", "To do"], ["in_progress", "In progress"], ["review", "Review"], ["done", "Done"]];
const filters = { q: "", status: "", priority: "", assignee_id: "", flag: "", view: "board" };
let refocusSearch = false;

async function setStatus(task, status, again) {
  if (task.status === status) return;
  try {
    await api.patch(`/api/tasks/${task.id}`, { status });
    toast(`“${task.title}” moved to ${label(status).toLowerCase()}.`, "success", 2500);
  } catch (e) { toast(e.message, "error"); }
  again();
}

export async function render(root, ctx) {
  const again = () => render(root, ctx);
  const pid = state.currentProjectId;
  const params = {
    project_id: pid, q: filters.q.trim(), status: filters.status, priority: filters.priority, assignee_id: filters.assignee_id,
    blocked: filters.flag === "blocked" ? "true" : "", overdue: filters.flag === "overdue" ? "true" : "",
  };
  let tasks;
  try { tasks = await api.get(`/api/tasks${qs(params)}`); }
  catch (e) { mount(root, errorBox(e, again)); return; }
  if (ctx.cancelled()) return;

  const search = h("input", { type: "search", class: "grow", value: filters.q, placeholder: "Search tasks…", "aria-label": "Search tasks", maxlength: 100 });
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { filters.q = search.value; refocusSearch = true; again(); }, 250); });
  const sel = (key, aria, options) => h("select", { "aria-label": aria, onchange: (e) => { filters[key] = e.target.value; again(); } },
    options.map(([v, t]) => h("option", { value: v, selected: filters[key] === v }, t)));
  const projectSel = h("select", { "aria-label": "Project", onchange: (e) => { setCurrentProject(e.target.value || null); again(); } },
    ...state.projects.map((p) => h("option", { value: p.id, selected: p.id === pid }, p.name)));
  const assigneeSel = h("select", { "aria-label": "Owner", onchange: (e) => { filters.assignee_id = e.target.value; again(); } },
    h("option", { value: "" }, "Any owner"), ...state.members.map((m) => h("option", { value: m.id, selected: filters.assignee_id === m.id }, m.name)));

  const filtered = !!(filters.q || filters.status || filters.priority || filters.assignee_id || filters.flag);
  const toolbar = h("div", { class: "toolbar", role: "search" },
    search, state.projects.length > 1 ? projectSel : null,
    sel("status", "Status", [["", "Any status"], ...COLUMNS.map(([v, t]) => [v, t])]),
    sel("priority", "Priority", [["", "Any priority"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]),
    assigneeSel,
    sel("flag", "Flags", [["", "All tasks"], ["blocked", "Blocked only"], ["overdue", "Overdue only"]]),
    filtered ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { Object.assign(filters, { q: "", status: "", priority: "", assignee_id: "", flag: "" }); again(); } }, "Clear filters") : null,
    h("div", { class: "seg", role: "group", "aria-label": "View" },
      ["board", "list"].map((v) => h("button", { type: "button", "aria-pressed": String(filters.view === v), onclick: () => { filters.view = v; again(); } }, label(v)))));

  const taskCard = (t) => {
    const owner = memberById(t.assignee_id);
    const sc = h("select", { "aria-label": `Status of ${t.title}`, onchange: (e) => setStatus(t, e.target.value, again) },
      COLUMNS.map(([v, tt]) => h("option", { value: v, selected: t.status === v }, tt)));
    const card = h("article", { class: "tcard", draggable: true, "data-id": t.id },
      h("button", { class: "ttl", type: "button", onclick: () => taskDialog({ task: t, onSaved: again }) }, t.title),
      h("div", { class: "row" }, pill(label(t.priority), t.priority), t.is_blocked ? pill("Blocked", "amber") : null, t.is_overdue ? pill("Overdue", "red") : null, t.is_milestone ? pill("Milestone", "violet") : null, t.is_demo ? demoPill() : null),
      h("div", { class: "row muted", style: { justifyContent: "space-between" } },
        h("span", { class: "row", style: { gap: "6px" } }, avatar(owner, true), owner ? owner.name.split(" ")[0] : "Unassigned"),
        t.due_at ? h("span", { class: ["due", t.is_overdue && "over"], title: fmtDate(t.due_at) }, relTime(t.due_at)) : h("span", { class: "faint" }, "No due date")),
      t.depends_on.length ? h("div", { class: "sub muted" }, `${t.depends_on.length} dependenc${t.depends_on.length === 1 ? "y" : "ies"}${t.open_dependencies.length ? `, ${t.open_dependencies.length} unfinished` : ", all done"}`) : null,
      sc);
    card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    return card;
  };

  const board = h("div", { class: "board" }, COLUMNS.map(([status, title]) => {
    const list = tasks.filter((t) => t.status === status);
    const col = h("section", { class: "col", "aria-label": `${title}, ${list.length} task(s)` },
      h("div", { class: "col-head" }, h("span", null, title), pill(String(list.length))),
      h("div", { class: "col-body" }, list.length ? list.map(taskCard) : h("div", { class: "faint", style: { padding: "10px", textAlign: "center" } }, filtered ? "No matches" : "Drop tasks here")));
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault(); col.classList.remove("over");
      const t = tasks.find((x) => x.id === e.dataTransfer.getData("text/plain"));
      if (t) setStatus(t, status, again);
    });
    return col;
  }));

  const table = h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, ["Task", "Status", "Priority", "Owner", "Due", "Flags"].map((c) => h("th", { scope: "col" }, c)))),
    h("tbody", null, tasks.map((t) => h("tr", null,
      h("td", null, h("button", { class: "link-btn", type: "button", onclick: () => taskDialog({ task: t, onSaved: again }) }, t.title), t.is_demo ? h("span", null, " ", demoPill()) : null),
      h("td", null, h("select", { "aria-label": `Status of ${t.title}`, onchange: (e) => setStatus(t, e.target.value, again) }, COLUMNS.map(([v, tt]) => h("option", { value: v, selected: t.status === v }, tt)))),
      h("td", null, pill(label(t.priority), t.priority)),
      h("td", null, h("select", { "aria-label": `Owner of ${t.title}`, onchange: async (e) => {
        try { await api.patch(`/api/tasks/${t.id}`, { assignee_id: e.target.value || null }); toast("Owner updated.", "success", 2000); } catch (er) { toast(er.message, "error"); }
        again();
      } }, memberOptions(t.assignee_id))),
      h("td", null, t.due_at ? h("span", { class: ["due", t.is_overdue && "over"], title: relTime(t.due_at) }, fmtDate(t.due_at)) : h("span", { class: "faint" }, "None")),
      h("td", null, h("span", { class: "row", style: { gap: "6px" } }, t.is_blocked ? pill("Blocked", "amber") : null, t.is_overdue ? pill("Overdue", "red") : null, !t.assignee_id && t.status !== "done" ? pill("No owner", "amber") : null)))))));

  const project = state.projects.find((p) => p.id === pid);
  let body;
  if (!state.projects.length) body = empty("No projects yet", "Create a project first, then add tasks to it.", h("a", { class: "btn btn-primary", href: "#/projects" }, "Go to Projects"));
  else if (!tasks.length) body = filtered ? empty("No tasks match these filters", "Try clearing a filter or searching for something else.")
    : empty("No tasks in this project", "Add a task yourself, or ask the AI assistant to break the project into tasks.",
      h("div", { class: "actions", style: { justifyContent: "center", marginTop: "12px" } }, h("button", { class: "btn btn-primary", type: "button", onclick: () => taskDialog({ onSaved: again }) }, "Add a task"), h("a", { class: "btn", href: "#/assistant" }, "Ask the assistant")));
  else body = filters.view === "board" ? board : table;

  mount(root,
    h("div", { class: "page-head" },
      h("div", null, h("h1", null, "Tasks"), h("p", null, project ? `${project.name}. Drag cards between columns, or use the status menu on each card.` : "")),
      h("div", { class: "actions" }, h("button", { class: "btn btn-primary", type: "button", disabled: !state.projects.length, onclick: () => taskDialog({ onSaved: again }) }, icon("plus", 16), "New task"))),
    toolbar, body);
  if (refocusSearch) { refocusSearch = false; search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
}
