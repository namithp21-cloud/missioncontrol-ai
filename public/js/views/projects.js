import { h, icon, mount } from "../dom.js";
import { api } from "../api.js";
import { state, setCurrentProject, emit, refreshCore } from "../state.js";
import { fmtDate, relTime, pill, statusPill, demoPill, progress, empty, skeleton, errorBox, openDialog, closeDialog, field, toast, confirmDialog, toLocalInput, fromLocalInput, showIssues, label } from "../ui.js";

const STATUSES = ["active", "on_hold", "completed"];

function projectDialog(project, onDone) {
  const name = h("input", { type: "text", maxlength: 120, required: true, value: project?.name || "" });
  const desc = h("textarea", { maxlength: 1000 }, project?.description || "");
  const deadline = h("input", { type: "datetime-local", value: toLocalInput(project?.deadline) });
  const status = h("select", null, STATUSES.map((s) => h("option", { value: s, selected: (project?.status || "active") === s }, label(s))));
  const err = h("div", { class: "form-error", role: "alert", hidden: true });
  const save = h("button", { class: "btn btn-primary", type: "submit" }, project ? "Save changes" : "Create project");
  const form = h("form", { class: "dlg", novalidate: true },
    h("div", { class: "dlg-head" }, h("h2", null, project ? "Edit project" : "New project"), h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closeDialog }, icon("x", 16))),
    h("div", { class: "dlg-body" }, err,
      field("Name", name, { full: true }),
      field("Description", desc, { full: true }),
      field("Deadline", deadline, { help: "Your local time. The risk analysis compares task due dates with this." }),
      field("Status", status)),
    h("div", { class: "dlg-foot" }, h("button", { class: "btn btn-ghost", type: "button", onclick: closeDialog }, "Cancel"), save));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.hidden = true;
    if (!name.value.trim()) { err.hidden = false; err.textContent = "Give the project a name."; name.focus(); return; }
    save.disabled = true;
    try {
      const dl = fromLocalInput(deadline.value);
      if (project) await api.patch(`/api/projects/${project.id}`, { name: name.value.trim(), description: desc.value, deadline: dl, status: status.value });
      else {
        const body = { name: name.value.trim(), description: desc.value, status: status.value };
        if (dl) body.deadline = dl;
        const created = await api.post("/api/projects", body);
        setCurrentProject(created.id);
      }
      closeDialog(); toast(project ? "Project updated." : "Project created.", "success");
      await refreshCore(); emit("data-changed"); onDone?.();
    } catch (ex) { showIssues(err, ex); } finally { save.disabled = false; }
  });
  openDialog(form); name.focus();
}

async function riskDialog(project) {
  const body = h("div", { class: "dlg-body" }, h("div", { class: "full" }, skeleton(2)));
  openDialog(h("div", { class: "dlg" }, h("div", { class: "dlg-head" }, h("h2", null, `Risks: ${project.name}`), h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closeDialog }, icon("x", 16))), body,
    h("div", { class: "dlg-foot" }, h("button", { class: "btn", type: "button", onclick: closeDialog }, "Close"))));
  try {
    const r = await api.get(`/api/projects/${project.id}/risks`);
    mount(body, h("div", { class: "full" },
      h("p", { class: "muted", style: { marginBottom: "10px" } }, r.summary),
      r.risks.length ? r.risks.map((k) => h("div", { class: ["risk", k.severity] }, h("div", { class: "t" }, k.title, pill(k.severity, k.severity)), h("p", null, k.explanation), h("p", null, h("b", null, "Mitigation: "), k.mitigation))) : null,
      h("p", { class: "disclaimer" }, r.disclaimer)));
  } catch (e) { mount(body, h("div", { class: "full" }, errorBox(e))); }
}

export async function render(root, ctx) {
  mount(root, skeleton(3));
  try { await refreshCore(); } catch (e) { mount(root, errorBox(e, () => render(root, ctx))); return; }
  if (ctx.cancelled()) return;
  const again = () => render(root, ctx);

  const card = (p) => h("article", { class: ["card", "pcard"], "aria-label": p.name },
    h("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start" } },
      h("h3", null, p.name), h("div", { class: "row" }, p.is_demo ? demoPill() : null, statusPill(p.status))),
    p.description ? h("p", { class: "muted" }, p.description) : null,
    progress(p.progress ?? 0, p.progress === 1),
    h("dl", { class: "kv" },
      h("dt", null, "Progress"), h("dd", null, p.tasks_total ? `${p.tasks_done} of ${p.tasks_total} tasks done (${Math.round((p.progress ?? 0) * 100)}%)` : "No tasks yet"),
      h("dt", null, "Open"), h("dd", null, `${p.tasks_open}${p.tasks_overdue ? `, ${p.tasks_overdue} overdue` : ""}`),
      h("dt", null, "Deadline"), h("dd", null, p.deadline ? `${fmtDate(p.deadline)} (${relTime(p.deadline)})` : "Not set")),
    h("div", { class: "actions" },
      h("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => { setCurrentProject(p.id); location.hash = "#/tasks"; } }, "Open tasks"),
      h("button", { class: "btn btn-sm", type: "button", onclick: () => riskDialog(p) }, icon("alert", 14), "Risks"),
      h("button", { class: "btn btn-sm", type: "button", onclick: () => projectDialog(p, again) }, icon("edit", 14), "Edit"),
      h("button", { class: "btn btn-sm btn-danger", type: "button", "aria-label": `Delete ${p.name}`, onclick: async () => {
        if (!(await confirmDialog({ title: "Delete project?", text: `“${p.name}” and all of its ${p.tasks_total} task(s) will be permanently deleted.`, confirmLabel: "Delete project", danger: true }))) return;
        try { await api.del(`/api/projects/${p.id}`); toast("Project deleted.", "success"); await refreshCore(); emit("data-changed"); again(); } catch (e) { toast(e.message, "error"); }
      } }, icon("trash", 14))));

  mount(root,
    h("div", { class: "page-head" },
      h("div", null, h("h1", null, "Projects"), h("p", null, "Set deadlines and track progress. Progress is the share of tasks marked done.")),
      h("div", { class: "actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => projectDialog(null, again) }, icon("plus", 16), "New project"))),
    state.projects.length ? h("div", { class: "cards" }, state.projects.map(card))
      : empty("No projects yet", "Create a project, or reset the demo workspace to explore a pre-filled one.", h("button", { class: "btn btn-primary", type: "button", onclick: () => projectDialog(null, again) }, "New project")));
}
