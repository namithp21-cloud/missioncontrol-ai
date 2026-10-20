import { h, icon, mount, richText } from "../dom.js";
import { api } from "../api.js";
import { state, emit, memberById } from "../state.js";
import { fmtDate, pill, statusPill, toast, relTime, label, asyncButton, errorBox, skeleton } from "../ui.js";
import { DEMO_PROMPT } from "./dashboard.js";

let convId = null; // module-level so the thread survives navigating between views
let startFresh = false; // set by "New chat" so the latest stored conversation is not reloaded

const SUGGESTIONS = [
  ["▶ Demo scenario: plan the hackathon", DEMO_PROMPT],
  ["What are our biggest risks?", "What are our biggest risks?"],
  ["Who is overloaded?", "Who is overloaded?"],
  ["Mark the Devpost registration as done", "Mark the Devpost registration as done."],
];

function sourceLabel(meta) {
  if (meta.source === "live_ai") return `Live AI · ${meta.provider || "provider"} · ${meta.model || "model"}`;
  if (meta.source === "demo_mode") return "Demo mode · scripted response, not an AI model";
  return "";
}

// ---------------------------------------------------------------- plan card
function stepMeta(step, plan) {
  const i = step.input || {};
  const bits = [];
  if (step.tool === "create_task") {
    const who = i.assignee_id ? memberById(i.assignee_id)?.name : null;
    bits.push(who ? `Owner: ${who}` : "Unassigned");
    if (i.priority) bits.push(`${label(i.priority)} priority`);
    if (i.due_at) bits.push(`due ${fmtDate(i.due_at)}`);
    if (i.estimate_hours != null) bits.push(`${i.estimate_hours}h`);
    if (i.depends_on?.length) {
      const names = i.depends_on.map((r) => plan.steps.find((s) => s.ref === r)?.input?.title || r);
      bits.push(`after: ${names.join(", ")}`);
    }
    if (i.is_milestone) bits.push("milestone");
  }
  return bits.join(" · ");
}

function planCard(plan, { onChange }) {
  const box = h("div", { class: "plan", "data-plan": plan.id });
  const proposed = plan.status === "proposed";
  const done = !proposed && plan.status !== "executing";

  const head = h("div", { class: "plan-head" },
    h("div", null,
      h("div", { class: "row" }, h("strong", null, proposed ? "Proposed plan: review before anything changes" : plan.status === "rejected" ? "Plan discarded" : "Execution report"), statusPill(plan.status)),
      h("div", { class: "sub muted" }, sourceLabel({ source: plan.source, provider: plan.provider, model: plan.model }), " · ", `${plan.steps.length} step(s)`)),
    done && plan.status !== "rejected" ? h("div", { class: "row" },
      pill(`${plan.counts.completed} completed`, "completed"),
      plan.counts.failed ? pill(`${plan.counts.failed} failed`, "failed") : null,
      plan.counts.skipped ? pill(`${plan.counts.skipped} skipped`, "skipped") : null) : null);

  const stepList = h("ol", { class: "plan-steps", "aria-label": "Steps" }, plan.steps.map((s) => h("li", null,
    h("span", { class: "n" }, `${s.position}.`),
    h("div", null,
      h("div", null, s.description),
      stepMeta(s, plan) ? h("div", { class: "sub muted" }, stepMeta(s, plan)) : null,
      s.error ? h("div", { class: "err" }, s.error) : null,
      s.status === "completed" && s.result?.id ? h("div", { class: "sub muted mono" }, `saved as ${s.result.id}`) : null),
    statusPill(s.status))));

  const parts = [head, stepList];

  const pv = plan.preview;
  if (pv && proposed) {
    parts.push(h("div", { class: "plan-section" },
      h("details", { open: true },
        h("summary", null, `Risk preview if approved: ${pv.risks.length} flag(s)`),
        h("p", { class: "muted", style: { margin: "8px 0" } }, pv.summary),
        pv.risks.slice(0, 5).map((r) => h("div", { class: ["risk", r.severity] },
          h("div", { class: "t" }, r.title, pill(r.severity, r.severity)),
          h("p", null, r.explanation),
          h("p", null, h("b", null, "Mitigation: "), r.mitigation))),
        pv.workload?.length ? h("div", { style: { marginTop: "12px" } },
          h("div", { class: "muted", style: { marginBottom: "6px", fontSize: "12px" } }, "Planned open hours per person"),
          pv.workload.map((w) => h("div", { class: "row", style: { gap: "8px", fontSize: "13px" } }, h("i", { class: "swatch", style: { background: w.color } }), `${w.name}: ${w.open_tasks} task(s), ${w.open_hours}h`))) : null,
        h("p", { class: "disclaimer" }, pv.disclaimer))));
  }

  if (proposed) {
    const approve = asyncButton("Approve and apply", async () => {
      try {
        const res = await api.post(`/api/agent/plans/${plan.id}/approve`);
        onChange(res.plan, res.message);
        const c = res.plan.counts;
        toast(`${c.completed} of ${res.plan.steps.length} step(s) applied${c.failed ? `, ${c.failed} failed` : ""}.`, c.failed ? "warn" : "success");
        emit("data-changed");
      } catch (e) { toast(e.message, "error"); }
    }, { cls: "btn btn-primary", iconName: "check" });
    const reject = asyncButton("Discard", async () => {
      try { const res = await api.post(`/api/agent/plans/${plan.id}/reject`); onChange(res.plan, res.message); toast("Plan discarded. Nothing was changed.", "info"); }
      catch (e) { toast(e.message, "error"); }
    }, { cls: "btn btn-ghost" });
    parts.push(h("div", { class: "plan-actions" }, approve, reject, h("span", { class: "muted" }, "Nothing is saved until you approve.")));
  } else if (plan.status === "completed" || plan.status === "partial") {
    parts.push(h("div", { class: "plan-actions" },
      h("a", { class: "btn btn-sm", href: "#/tasks" }, "View tasks"),
      h("a", { class: "btn btn-sm", href: "#/dashboard" }, "See the dashboard update"),
      h("span", { class: "muted" }, plan.resolved_at ? `Finished ${relTime(plan.resolved_at)}` : "")));
  }
  box.append(...parts);
  return box;
}

// ---------------------------------------------------------------- messages
function messageEl(msg, ctx) {
  const meta = msg.meta || {};
  const cls = ["msg", msg.role, meta.kind === "error" && "error"];
  const el = h("article", { class: cls, "data-msg": msg.id });
  const who = msg.role === "user" ? "You" : msg.role === "system" ? "System" : "MissionControl";
  el.append(h("div", { class: "meta" }, h("strong", null, who), msg.role === "assistant" && sourceLabel(meta) ? pill(sourceLabel(meta), meta.source === "live_ai" ? "green" : "demo") : null, h("time", { datetime: msg.created_at }, relTime(msg.created_at))));
  el.append(h("div", { class: "bubble" }, msg.role === "user" ? msg.content : richText(msg.content)));
  if (Array.isArray(meta.tool_calls) && meta.tool_calls.length) {
    el.append(h("details", { class: "tool-log" }, h("summary", null, `Tools used (${meta.tool_calls.length})`),
      h("ul", null, meta.tool_calls.map((t) => h("li", null, h("span", { class: "mono" }, t.tool), " · ", statusPill(t.status), " ", h("span", { class: "muted" }, t.summary))))));
  }
  // The report message only carries a one-line summary; the full plan card lives on the assistant message that proposed it
  // and updates in place, so drawing it here too would show the same plan twice.
  if (msg.plan && meta.kind !== "report") {
    const slot = h("div", { class: "plan-slot" });
    const draw = (plan, report) => {
      mount(slot, planCard(plan, { onChange: (p, m) => { draw(p); if (m) ctx.append(m); } }));
    };
    draw(msg.plan);
    el.append(slot);
  }
  return el;
}

// ---------------------------------------------------------------- view
export async function render(root, ctx) {
  mount(root, skeleton(3));
  let conv = null;
  try {
    if (convId) conv = await api.get(`/api/agent/conversations/${convId}`).catch(() => null);
    if (!conv && !startFresh) conv = await api.get("/api/agent/conversation");
  } catch (e) { mount(root, errorBox(e, () => render(root, ctx))); return; }
  if (ctx.cancelled()) return;
  convId = conv?.id ?? null;

  const live = state.agent?.mode === "live";
  const thread = h("div", { class: "thread", role: "log", "aria-live": "polite", "aria-label": "Conversation" });
  const scroll = () => { thread.scrollTop = thread.scrollHeight; };
  const helper = { append: (m) => { thread.append(messageEl(m, helper)); scroll(); } };

  const banner = h("div", { class: ["banner", live ? "live" : "demo"] },
    h("div", null, live
      ? h("span", null, h("strong", null, "Live AI"), ` · ${state.agent.provider} · ${state.agent.model}. The model calls validated tools; every change still needs your approval.`)
      : h("span", null, h("strong", null, "Demo mode"), ": no AI key is configured, so replies come from deterministic scripted scenarios, not a language model. Tools, approvals and database changes are real.")),
    h("div", { class: "row" }, h("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: () => { convId = null; startFresh = true; render(root, ctx); } }, icon("plus", 14), "New chat")));

  const empties = h("div", { class: "empty" },
    h("h3", null, "Ask for something to be done"),
    h("p", null, "I can plan work, assign owners, check dependencies and deadlines, and explain risks. Changes are proposed first and only applied after you approve."),
    h("div", { class: "chips", style: { justifyContent: "center" } }, SUGGESTIONS.map(([t, p]) => h("button", { class: "chip", type: "button", onclick: () => send(p) }, t))));

  const input = h("textarea", { rows: 1, maxlength: 2000, placeholder: "Describe what you need done… (Enter to send, Shift+Enter for a new line)", "aria-label": "Message to the assistant" });
  const sendBtn = h("button", { class: "btn btn-primary", type: "submit" }, icon("send", 16), h("span", null, "Send"));
  let busy = false;

  async function send(text) {
    text = String(text || "").trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true; input.disabled = true;
    empties.remove();
    const optimistic = messageEl({ id: "tmp", role: "user", content: text, meta: {}, created_at: new Date().toISOString(), plan: null }, helper);
    thread.append(optimistic);
    const typing = h("div", { class: "msg" }, h("div", { class: "bubble" }, h("span", { class: "typing", role: "status", "aria-label": "Assistant is working" }, h("i"), h("i"), h("i"))));
    thread.append(typing); scroll();
    try {
      const res = await api.post("/api/agent/message", { message: text, ...(convId ? { conversation_id: convId } : {}), project_id: state.currentProjectId });
      convId = res.conversation_id; startFresh = false;
      optimistic.remove(); typing.remove();
      for (const m of res.messages) helper.append(m);
      input.value = "";
    } catch (e) {
      typing.remove();
      toast(e.message, "error");
      helper.append({ id: "err" + Date.now(), role: "assistant", content: e.message, meta: { kind: "error" }, created_at: new Date().toISOString(), plan: null });
    } finally { busy = false; sendBtn.disabled = false; input.disabled = false; input.focus(); }
  }

  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });

  const project = state.projects.find((p) => p.id === state.currentProjectId);
  mount(root, h("div", { class: "assistant" },
    h("div", { class: "page-head", style: { marginBottom: 0 } }, h("div", null, h("h1", null, "AI Assistant"), h("p", null, project ? `Working on: ${project.name}` : "No project selected. Pick one in the top bar or ask me to help create one."))),
    banner, thread,
    h("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); send(input.value); } }, input, sendBtn)));

  if (conv?.messages?.length) { for (const m of conv.messages) helper.append(m); }
  else thread.append(empties);
  scroll();

  if (state.pendingPrompt) { const p = state.pendingPrompt; state.pendingPrompt = null; send(p); } else input.focus();
}
