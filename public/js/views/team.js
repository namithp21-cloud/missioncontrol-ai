import { h, icon, mount } from "../dom.js";
import { api } from "../api.js";
import { state, emit, refreshCore } from "../state.js";
import { pill, statusPill, demoPill, empty, skeleton, errorBox, avatar, openDialog, closeDialog, field, toast, confirmDialog, showIssues, relTime } from "../ui.js";
import { taskDialog } from "../taskDialog.js";

function memberDialog(member, onDone) {
  const name = h("input", { type: "text", maxlength: 80, required: true, value: member?.name || "" });
  const role = h("input", { type: "text", maxlength: 80, required: true, value: member?.role || "", placeholder: "e.g. Backend engineer" });
  const hours = h("input", { type: "number", min: 0.5, max: 16, step: 0.5, value: member?.daily_hours ?? 8 });
  const err = h("div", { class: "form-error", role: "alert", hidden: true });
  const save = h("button", { class: "btn btn-primary", type: "submit" }, member ? "Save changes" : "Add member");
  const form = h("form", { class: "dlg", novalidate: true },
    h("div", { class: "dlg-head" }, h("h2", null, member ? "Edit team member" : "Add team member"), h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closeDialog }, icon("x", 16))),
    h("div", { class: "dlg-body" }, err, field("Name", name), field("Role", role), field("Hours available per day", hours, { help: "Used for workload and overlap checks." })),
    h("div", { class: "dlg-foot" }, h("button", { class: "btn btn-ghost", type: "button", onclick: closeDialog }, "Cancel"), save));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.hidden = true;
    if (!name.value.trim() || !role.value.trim()) { err.hidden = false; err.textContent = "Name and role are required."; return; }
    save.disabled = true;
    const body = { name: name.value.trim(), role: role.value.trim(), daily_hours: Number(hours.value) };
    try {
      if (member) await api.patch(`/api/team/${member.id}`, body); else await api.post("/api/team", body);
      closeDialog(); toast(member ? "Member updated." : "Member added.", "success");
      await refreshCore(); emit("data-changed"); onDone?.();
    } catch (ex) { showIssues(err, ex); } finally { save.disabled = false; }
  });
  openDialog(form); name.focus();
}

export async function render(root, ctx) {
  mount(root, skeleton(3));
  let tasks;
  try { await refreshCore(); tasks = await api.get("/api/tasks"); }
  catch (e) { mount(root, errorBox(e, () => render(root, ctx))); return; }
  if (ctx.cancelled()) return;
  const again = () => render(root, ctx);
  const open = (t) => t.status !== "done";

  const card = (m) => {
    const mine = tasks.filter((t) => t.assignee_id === m.id);
    const openT = mine.filter(open);
    const hrs = openT.reduce((s, t) => s + (t.estimate_hours ?? 0), 0);
    const overdue = openT.filter((t) => t.is_overdue).length;
    return h("article", { class: ["card", "pcard"], "aria-label": m.name },
      h("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start" } },
        h("div", { class: "row" }, avatar(m), h("div", null, h("h3", null, m.name), h("div", { class: "muted" }, m.role))),
        m.is_demo ? demoPill() : null),
      h("dl", { class: "kv" },
        h("dt", null, "Open tasks"), h("dd", null, `${openT.length}${overdue ? ` (${overdue} overdue)` : ""}`),
        h("dt", null, "Open hours"), h("dd", null, `${Math.round(hrs * 10) / 10}h estimated`),
        h("dt", null, "Completed"), h("dd", null, String(mine.length - openT.length)),
        h("dt", null, "Capacity"), h("dd", null, `${m.daily_hours}h per day`)),
      openT.length ? h("ul", { class: "list" }, openT.slice(0, 5).map((t) => h("li", null, h("button", { class: "link-btn", type: "button", onclick: () => taskDialog({ task: t, onSaved: again }) }, t.title), statusPill(t.status)))) : h("p", { class: "muted" }, "No open tasks."),
      openT.length > 5 ? h("p", { class: "faint" }, `+ ${openT.length - 5} more in Tasks`) : null,
      h("div", { class: "actions" },
        h("button", { class: "btn btn-sm", type: "button", onclick: () => memberDialog(m, again) }, icon("edit", 14), "Edit"),
        h("button", { class: "btn btn-sm btn-danger", type: "button", "aria-label": `Remove ${m.name}`, onclick: async () => {
          if (!(await confirmDialog({ title: "Remove team member?", text: `${m.name} will be removed. Their ${openT.length} open task(s) become unassigned.`, confirmLabel: "Remove", danger: true }))) return;
          try { await api.del(`/api/team/${m.id}`); toast(`${m.name} removed.`, "success"); await refreshCore(); emit("data-changed"); again(); } catch (e) { toast(e.message, "error"); }
        } }, icon("trash", 14))));
  };

  const unassigned = tasks.filter((t) => !t.assignee_id && open(t));
  mount(root,
    h("div", { class: "page-head" },
      h("div", null, h("h1", null, "Team"), h("p", null, "Names, roles and workload. Workload is the sum of estimated hours on each person's open tasks.")),
      h("div", { class: "actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => memberDialog(null, again) }, icon("plus", 16), "Add member"))),
    h("div", { class: "stack" },
      unassigned.length ? h("section", { class: "card", "aria-labelledby": "un-h" },
        h("div", { class: "card-head" }, h("h2", { id: "un-h" }, "Unassigned tasks"), pill(String(unassigned.length), "amber")),
        h("ul", { class: "list" }, unassigned.map((t) => h("li", null,
          h("div", null, h("button", { class: "link-btn", type: "button", onclick: () => taskDialog({ task: t, onSaved: again }) }, t.title), h("div", { class: "sub" }, t.due_at ? `Due ${relTime(t.due_at)}` : "No due date")),
          h("div", { class: "row" }, pill(t.priority, t.priority), h("button", { class: "btn btn-sm", type: "button", onclick: () => taskDialog({ task: t, onSaved: again }) }, "Assign")))))) : null,
      state.members.length ? h("div", { class: "cards" }, state.members.map(card))
        : empty("No team members yet", "Add the people working on your projects so tasks can be assigned.", h("button", { class: "btn btn-primary", type: "button", onclick: () => memberDialog(null, again) }, "Add member"))));
}
