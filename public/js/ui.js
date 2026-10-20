import { h, icon, mount } from "./dom.js";
import { state, memberById } from "./state.js";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dfDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dfTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export function fmtDate(iso) {
  if (!iso) return "No date";
  const d = new Date(iso);
  return `${dfDate.format(d)}, ${dfTime.format(d)}`;
}

export function fmtDay(iso) {
  return iso ? dfDate.format(new Date(iso)) : "No date";
}

export function relTime(iso, from = Date.now()) {
  if (!iso) return "";
  const diff = (new Date(iso).getTime() - from) / 3_600_000;
  const abs = Math.abs(diff);
  let txt;
  if (abs < 1) txt = `${Math.max(1, Math.round(abs * 60))}m`;
  else if (abs < 48) txt = `${Math.round(abs)}h`;
  else txt = `${Math.round(abs / 24)}d`;
  return diff < 0 ? `${txt} ago` : `in ${txt}`;
}

export const label = (s) => String(s || "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
export const tzName = () => TZ;

export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const pill = (text, cls = "") => h("span", { class: ["pill", cls] }, text);
export const statusPill = (s) => pill(label(s), s);
export const demoPill = () => h("span", { class: "pill demo", title: "Seeded workspace baseline item. Reset restores it." }, "Seeded");

export function avatar(member, mini = false) {
  if (!member) return h("span", { class: mini ? "mini-ava" : "member-ava", style: { background: "#ebe6de", color: "#575c66" }, title: "Unassigned" }, "?");
  const initials = member.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return h("span", { class: mini ? "mini-ava" : "member-ava", style: { background: member.color }, title: member.name }, initials);
}

export function progress(ratio, green = false) {
  const pct = Math.max(0, Math.min(1, ratio || 0)) * 100;
  return h("div", { class: ["progress", green && "green"], role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(pct) }, h("span", { style: { width: `${pct}%` } }));
}

export function empty(title, text, action) {
  return h("div", { class: "empty" }, h("h3", null, title), h("p", null, text), action || null);
}

export function skeleton(n = 3) {
  return h("div", { class: "stack", "aria-busy": "true", "aria-label": "Loading" }, Array.from({ length: n }, () => h("div", { class: "skeleton" })));
}

export function errorBox(err, retry) {
  return h("div", { class: "empty", role: "alert" },
    h("h3", null, "Unable to load view"),
    h("p", null, err?.message || "Unexpected error."),
    retry ? h("button", { class: "btn", type: "button", onclick: retry }, icon("refresh", 16), "Try again") : null);
}

export function memberOptions(selectedId, { none = "Unassigned" } = {}) {
  return [h("option", { value: "", selected: !selectedId }, none), ...state.members.map((m) => h("option", { value: m.id, selected: m.id === selectedId }, m.name))];
}

export function assigneeName(id) {
  return memberById(id)?.name ?? "Unassigned";
}

export function asyncButton(text, onClick, { cls = "btn", iconName } = {}) {
  const btn = h("button", { class: cls, type: "button" }, iconName ? icon(iconName, 16) : null, h("span", null, text));
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    const spin = h("span", { class: "spinner", "aria-hidden": "true" });
    btn.prepend(spin);
    try { await onClick(); } finally { spin.remove(); btn.disabled = false; }
  });
  return btn;
}

export function toast(message, type = "info", ms = 4500) {
  const host = document.getElementById("toasts");
  const el = h("div", { class: ["toast", type], role: type === "error" ? "alert" : "status" },
    h("span", null, message),
    h("button", { type: "button", "aria-label": "Dismiss", onclick: () => el.remove() }, icon("x", 14)));
  host.append(el);
  if (ms) setTimeout(() => el.remove(), type === "error" ? Math.max(ms, 7000) : ms);
}

export function openDialog(content) {
  const dlg = document.getElementById("dialog");
  mount(dlg, content);
  if (!dlg.open) dlg.showModal();
  return dlg;
}

export function closeDialog() {
  const dlg = document.getElementById("dialog");
  if (dlg.open) dlg.close();
}

export function confirmDialog({ title, text, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const dlg = openDialog(h("div", { class: "dlg" },
      h("div", { class: "dlg-head" }, h("h2", null, title)),
      h("div", { class: "dlg-body" }, h("p", { class: "full" }, text)),
      h("div", { class: "dlg-foot" },
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => closeDialog() }, "Cancel"),
        h("button", { class: ["btn", danger ? "btn-danger" : "btn-primary"], type: "button", onclick: () => { result = true; closeDialog(); } }, confirmLabel))));
    dlg.addEventListener("close", () => resolve(result), { once: true });
  });
}

export function field(labelText, control, { help, full = false, id } = {}) {
  const fid = id || `f_${Math.random().toString(36).slice(2, 8)}`;
  control.id = fid;
  const err = h("div", { class: "err", role: "alert", hidden: true });
  const wrap = h("div", { class: ["field", full && "full"] }, h("label", { for: fid }, labelText), control, help ? h("div", { class: "help" }, help) : null, err);
  wrap.showError = (msg) => { err.textContent = msg; err.hidden = !msg; control.setAttribute("aria-invalid", msg ? "true" : "false"); };
  return wrap;
}

export function showIssues(formErrorEl, err) {
  formErrorEl.hidden = false;
  const issues = (err.issues || []).map((i) => `${(i.path || []).join(".") || "input"}: ${i.message}`);
  formErrorEl.textContent = issues.length ? `${err.message} (${issues.join("; ")})` : err.message;
}