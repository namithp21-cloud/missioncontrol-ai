import { h, icon } from "./dom.js";
import { api, qs } from "./api.js";
import { state, emit } from "./state.js";
import { openDialog, closeDialog, field, memberOptions, toast, fromLocalInput, toLocalInput, showIssues, confirmDialog, label } from "./ui.js";

const STATUSES = ["todo", "in_progress", "review", "done"];
const PRIORITIES = ["low", "medium", "high", "critical"];

/** Create (task omitted) or edit a task. Resolves after a successful save/delete so callers can refresh. */
export async function taskDialog({ task = null, projectId = null, onSaved } = {}) {
  const pid = task?.project_id || projectId || state.currentProjectId;
  if (!pid) { toast("Create a project first, then add tasks to it.", "warn"); return; }
  let siblings = [];
  try { siblings = (await api.get(`/api/tasks${qs({ project_id: pid })}`)).filter((t) => !task || t.id !== task.id); }
  catch (e) { toast(e.message, "error"); return; }

  const projectSel = h("select", { disabled: !!task }, ...state.projects.map((p) => h("option", { value: p.id, selected: p.id === pid }, p.name)));
  const title = h("input", { type: "text", maxlength: 160, required: true, value: task?.title || "" });
  const desc = h("textarea", { maxlength: 2000 }, task?.description || "");
  const status = h("select", null, ...STATUSES.map((s) => h("option", { value: s, selected: (task?.status || "todo") === s }, label(s))));
  const priority = h("select", null, ...PRIORITIES.map((s) => h("option", { value: s, selected: (task?.priority || "medium") === s }, label(s))));
  const assignee = h("select", null, ...memberOptions(task?.assignee_id));
  const start = h("input", { type: "datetime-local", value: toLocalInput(task?.start_at) });
  const due = h("input", { type: "datetime-local", value: toLocalInput(task?.due_at) });
  const est = h("input", { type: "number", min: 0, max: 1000, step: 0.5, value: task?.estimate_hours ?? "" });
  const milestone = h("input", { type: "checkbox", checked: !!task?.is_milestone });
  const chosen = new Set(task?.depends_on || []);
  const depBox = h("div", { class: "stack", style: { gap: "6px", maxHeight: "170px", overflow: "auto", padding: "8px", border: "1px solid var(--border)", borderRadius: "9px" } },
    siblings.length
      ? siblings.map((s) => h("label", { class: "check", style: { marginBottom: 0 } },
          h("input", { type: "checkbox", checked: chosen.has(s.id), onchange: (e) => (e.target.checked ? chosen.add(s.id) : chosen.delete(s.id)) }),
          h("span", null, s.title, s.status === "done" ? " (done)" : "")))
      : h("span", { class: "muted" }, "No other tasks in this project yet."));
  const errBox = h("div", { class: "form-error", role: "alert", hidden: true });
  const saveBtn = h("button", { class: "btn btn-primary", type: "submit" }, task ? "Save changes" : "Create task");

  const form = h("form", { class: "dlg", novalidate: true },
    h("div", { class: "dlg-head" }, h("h2", null, task ? "Edit task" : "New task"), h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closeDialog }, icon("x", 16))),
    h("div", { class: "dlg-body" },
      errBox,
      field("Title", title, { full: true }),
      field("Description", desc, { full: true }),
      field("Project", projectSel),
      field("Owner", assignee),
      field("Status", status),
      field("Priority", priority),
      field("Start", start),
      field("Due", due, { help: "Shown in your local time." }),
      field("Estimate (hours)", est),
      h("div", { class: "field", style: { justifyContent: "flex-end" } }, h("label", { class: "check" }, milestone, "Milestone")),
      h("div", { class: "field full" }, h("label", null, "Depends on (must finish first)"), depBox)),
    h("div", { class: "dlg-foot" },
      task ? h("button", { class: "btn btn-danger left", type: "button", onclick: async () => {
        if (!(await confirmDialog({ title: "Delete task?", text: `“${task.title}” will be permanently deleted along with its dependency links.`, confirmLabel: "Delete", danger: true }))) return;
        try { await api.del(`/api/tasks/${task.id}`); toast("Task deleted.", "success"); emit("data-changed"); onSaved?.(); } catch (e) { toast(e.message, "error"); }
      } }, icon("trash", 16), "Delete") : null,
      h("button", { class: "btn btn-ghost", type: "button", onclick: closeDialog }, "Cancel"),
      saveBtn));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errBox.hidden = true;
    if (!title.value.trim()) { errBox.hidden = false; errBox.textContent = "Give the task a title."; title.focus(); return; }
    const s = fromLocalInput(start.value), d = fromLocalInput(due.value);
    if (s && d && s > d) { errBox.hidden = false; errBox.textContent = "The start time must not be after the due time."; return; }
    const body = {
      title: title.value.trim(), description: desc.value, status: status.value, priority: priority.value,
      assignee_id: assignee.value || null, start_at: s, due_at: d,
      estimate_hours: est.value === "" ? null : Number(est.value), is_milestone: milestone.checked,
    };
    saveBtn.disabled = true;
    try {
      if (!task) {
        const payload = { ...body, project_id: projectSel.value, depends_on: [...chosen] };
        for (const k of ["start_at", "due_at", "estimate_hours", "assignee_id"]) if (payload[k] === null) delete payload[k];
        await api.post("/api/tasks", payload);
      } else {
        await api.patch(`/api/tasks/${task.id}`, body);
        const before = new Set(task.depends_on || []);
        for (const id of chosen) if (!before.has(id)) await api.post(`/api/tasks/${task.id}/dependencies`, { depends_on_id: id });
        for (const id of before) if (!chosen.has(id)) await api.del(`/api/tasks/${task.id}/dependencies/${id}`);
      }
      closeDialog();
      toast(task ? "Task updated." : "Task created.", "success");
      emit("data-changed");
      onSaved?.();
    } catch (e) {
      showIssues(errBox, e);
      if (task) emit("data-changed"); // part of a multi-step save may have applied; keep the UI truthful
    } finally { saveBtn.disabled = false; }
  });

  openDialog(form);
  title.focus();
}
