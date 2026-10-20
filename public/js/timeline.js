import { h, svg } from "./dom.js";
import { fmtDay } from "./ui.js";

/**
 * SVG Gantt-style timeline: one bar per task, milestones as diamonds, dependency arrows, a "now" line and the
 * project deadline. Everything is drawn from the supplied tasks/deps; nothing is decorative.
 */
export function timeline({ project, tasks, deps, onSelect }) {
  const dated = tasks.filter((t) => t.due_at);
  if (!dated.length) return h("div", { class: "empty" }, h("p", null, "No scheduled tasks yet. Give tasks a due date, or ask the assistant to plan the project, and they will appear here."));

  const ordered = [...dated].sort((a, b) => (a.start_at || a.due_at).localeCompare(b.start_at || b.due_at) || a.due_at.localeCompare(b.due_at));
  const t = (iso) => new Date(iso).getTime();
  const nowMs = Date.now();
  const starts = ordered.map((x) => t(x.start_at || x.due_at));
  const ends = ordered.map((x) => t(x.due_at));
  let min = Math.min(...starts, nowMs);
  let max = Math.max(...ends, project?.deadline ? t(project.deadline) : 0, nowMs);
  const pad = Math.max((max - min) * 0.03, 3_600_000);
  min -= pad; max += pad;

  const LABEL_W = 200, ROW_H = 30, TOP = 34, W = 720, CH_W = W - LABEL_W - 16;
  const x = (ms) => LABEL_W + ((ms - min) / (max - min)) * CH_W;
  const H = TOP + ordered.length * ROW_H + 12;
  const idx = new Map(ordered.map((tk, i) => [tk.id, i]));

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `Timeline of ${ordered.length} tasks${project?.deadline ? `, deadline ${fmtDay(project.deadline)}` : ""}` });
  root.append(svg("defs", null,
    svg("marker", { id: "arr", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, svg("path", { d: "M0 0L8 4L0 8z", class: "tl-arrow" })),
    svg("marker", { id: "arrbad", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, svg("path", { d: "M0 0L8 4L0 8z", class: "tl-arrow-bad" }))));

  // day gridlines
  const dayMs = 86_400_000;
  const span = max - min;
  const step = span > 14 * dayMs ? 7 * dayMs : span > 5 * dayMs ? dayMs : span > 2 * dayMs ? 12 * 3_600_000 : 6 * 3_600_000;
  const first = Math.ceil(min / step) * step;
  let lastLabelX = -Infinity;
  for (let g = first; g < max; g += step) {
    root.append(svg("line", { x1: x(g), x2: x(g), y1: TOP - 6, y2: H - 6, class: "tl-grid" }));
    if (x(g) - lastLabelX < 86) continue; // keep axis labels from overlapping on narrow charts
    lastLabelX = x(g);
    const d = new Date(g);
    root.append(svg("text", { x: x(g) + 3, y: 14, class: "tl-axis" }, step >= dayMs ? fmtDay(d.toISOString()) : `${fmtDay(d.toISOString()).split(",")[0]} ${String(d.getHours()).padStart(2, "0")}:00`));
  }

  ordered.forEach((tk, i) => {
    const y = TOP + i * ROW_H;
    root.append(svg("rect", { x: 0, y, width: W, height: ROW_H, class: i % 2 ? "tl-row alt" : "tl-row" }));
    const title = tk.title.length > 32 ? `${tk.title.slice(0, 31)}…` : tk.title;
    const lbl = svg("text", { x: 8, y: y + ROW_H / 2 + 4, class: "tl-label", tabindex: 0, role: "button", "aria-label": `Open task ${tk.title}` }, title);
    if (onSelect) {
      lbl.addEventListener("click", () => onSelect(tk));
      lbl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(tk); } });
      lbl.style.cursor = "pointer";
    }
    root.append(lbl);
    const x1 = x(t(tk.start_at || tk.due_at)), x2 = x(t(tk.due_at));
    const tip = svg("title", null, `${tk.title}\n${fmtDay(tk.start_at || tk.due_at)} → ${fmtDay(tk.due_at)}\nStatus: ${tk.status.replace("_", " ")}${tk.assignee_name ? `\nOwner: ${tk.assignee_name}` : "\nUnassigned"}${tk.is_blocked ? "\nBlocked by unfinished dependencies" : ""}`);
    if (tk.is_milestone) {
      const cx = x2, cy = y + ROW_H / 2;
      root.append(svg("path", { d: `M${cx} ${cy - 9}L${cx + 9} ${cy}L${cx} ${cy + 9}L${cx - 9} ${cy}z`, class: "tl-ms" }, tip));
    } else {
      const w = Math.max(x2 - x1, 6);
      root.append(svg("rect", { x: x1, y: y + 7, width: w, height: ROW_H - 14, class: ["tl-bar", tk.status, tk.is_overdue && "overdue"].filter(Boolean).join(" ") }, tip));
    }
  });

  // dependency arrows: from the end of the prerequisite to the start of the dependent
  for (const d of deps) {
    const a = idx.get(d.depends_on_id), b = idx.get(d.task_id);
    if (a === undefined || b === undefined) continue;
    const pre = ordered[a], post = ordered[b];
    const ax = x(t(pre.due_at)) + (pre.is_milestone ? 9 : 0), ay = TOP + a * ROW_H + ROW_H / 2;
    const bx = x(t(post.start_at || post.due_at)) - (post.is_milestone ? 9 : 0), by = TOP + b * ROW_H + ROW_H / 2;
    const bad = t(pre.due_at) > t(post.start_at || post.due_at) + 60_000; // prerequisite ends after the dependent starts
    const mid = Math.max(ax + 8, Math.min(bx - 8, (ax + bx) / 2));
    root.append(svg("path", { d: `M${ax} ${ay}H${mid}V${by}H${bx}`, class: bad ? "tl-dep bad" : "tl-dep", "marker-end": `url(#${bad ? "arrbad" : "arr"})` }));
  }

  if (nowMs > min && nowMs < max) {
    root.append(svg("line", { x1: x(nowMs), x2: x(nowMs), y1: TOP - 6, y2: H - 6, class: "tl-now" }));
    root.append(svg("text", { x: x(nowMs) + 4, y: H - 14, class: "tl-now-text" }, "Now"));
  }
  if (project?.deadline) {
    const dx = x(t(project.deadline));
    root.append(svg("line", { x1: dx, x2: dx, y1: TOP - 6, y2: H - 6, class: "tl-deadline" }));
    root.append(svg("text", { x: Math.min(dx + 4, W - 64), y: 26, class: "tl-dl-text" }, "Deadline"));
  }

  return h("div", null,
    h("div", { class: "tl-wrap" }, root),
    h("div", { class: "legend" },
      h("span", null, h("i", { class: "swatch", style: { background: "#3a4572" } }), "To do"),
      h("span", null, h("i", { class: "swatch", style: { background: "var(--violet)" } }), "In progress"),
      h("span", null, h("i", { class: "swatch", style: { background: "var(--blue)" } }), "Review"),
      h("span", null, h("i", { class: "swatch", style: { background: "var(--green)" } }), "Done"),
      h("span", null, h("i", { class: "swatch", style: { background: "var(--amber)" } }), "Milestone"),
      h("span", null, h("i", { class: "swatch", style: { background: "var(--red)" } }), "Deadline / conflicting dependency")));
}
