// Minimal DOM helpers. All content goes through textContent/createElement, never innerHTML, so
// user- or model-supplied text cannot inject markup.

const PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "required", "multiple", "open", "draggable", "readOnly"]);

function apply(el, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v); // CSSOM, allowed by our CSP
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k === "class" ? "class" : k, String(v));
  }
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

const ICONS = {
  dashboard: "M3 3h8v8H3z M13 3h8v5h-8z M13 10h8v11h-8z M3 13h8v8H3z",
  sparkles: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  tasks: "M9 11l3 3 8-8 M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  left: "M11 17l-5-5 5-5 M18 17l-5-5 5-5",
  right: "M13 17l5-5-5-5 M6 17l5-5-5-5",
  plus: "M12 5v14 M5 12h14",
  x: "M18 6L6 18 M6 6l12 12",
  trash: "M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6 M10 11v6 M14 11v6",
  alert: "M12 9v4 M12 17h.01 M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  send: "M22 2L11 13 M22 2l-7 20-4-9-9-4z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3",
  refresh: "M21 12a9 9 0 0 0-15-6.7L3 8 M3 3v5h5 M3 12a9 9 0 0 0 15 6.7L21 16 M21 21v-5h-5",
  check: "M20 6L9 17l-5-5",
  circle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  minus: "M5 12h14",
  edit: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  lock: "M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4",
  calendar: "M3 5h18v16H3z M3 10h18 M8 3v4 M16 3v4",
  flag: "M4 22V4 M4 4h13l-2 4 2 4H4",
};

export function icon(name, size = 18) {
  const s = svg("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" });
  for (const d of (ICONS[name] || ICONS.circle).split(" M")) s.append(svg("path", { d: d.startsWith("M") ? d : "M" + d }));
  return s;
}

/** Tiny, safe inline formatter for assistant text: **bold**, `code`, _italic_, and "•" lists. Returns a DocumentFragment. */
export function richText(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text).split("\n");
  lines.forEach((line, i) => {
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g);
    for (const p of parts) {
      if (!p) continue;
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4) frag.append(h("strong", null, p.slice(2, -2)));
      else if (p.startsWith("`") && p.endsWith("`") && p.length > 2) frag.append(h("code", { class: "mono" }, p.slice(1, -1)));
      else if (p.startsWith("_") && p.endsWith("_") && p.length > 2) frag.append(h("em", null, p.slice(1, -1)));
      else frag.append(document.createTextNode(p));
    }
    if (i < lines.length - 1) frag.append(document.createTextNode("\n"));
  });
  return frag;
}
