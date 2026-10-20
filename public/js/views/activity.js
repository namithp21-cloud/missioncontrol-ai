import { h, mount } from "../dom.js";
import { api, qs } from "../api.js";
import { state } from "../state.js";
import { skeleton, errorBox } from "../ui.js";
import { activityFeed } from "./dashboard.js";

let actor = "";
let scope = "all";

export async function render(root, ctx) {
  mount(root, skeleton(3));
  const again = () => render(root, ctx);
  let items;
  try { items = await api.get(`/api/activity${qs({ limit: 200, project: scope === "project" ? state.currentProjectId : "" })}`); }
  catch (e) { mount(root, errorBox(e, again)); return; }
  if (ctx.cancelled()) return;
  const shown = actor ? items.filter((a) => a.actor === actor) : items;
  const seg = (value, options, set, aria) => h("div", { class: "seg", role: "group", "aria-label": aria },
    options.map(([v, t]) => h("button", { type: "button", "aria-pressed": String(value === v), onclick: () => { set(v); again(); } }, t)));
  mount(root,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "Activity"), h("p", null, "Every significant change made by you or the assistant, newest first. Failed or discarded plans are recorded too."))),
    h("div", { class: "toolbar" },
      seg(actor, [["", "Everyone"], ["ai", "AI"], ["user", "You"], ["system", "System"]], (v) => (actor = v), "Filter by actor"),
      state.currentProjectId ? seg(scope, [["all", "All projects"], ["project", "Current project"]], (v) => (scope = v), "Filter by project") : null),
    h("section", { class: "card" }, h("div", { "aria-live": "polite" }, activityFeed(shown)), h("p", { class: "faint", style: { marginTop: "10px" } }, `Showing ${shown.length} of the latest ${items.length} entries.`)));
}
