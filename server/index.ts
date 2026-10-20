import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "./db.ts";
import { ensureSeeded, resetDemo } from "./seed.ts";
import { ValidationError, v } from "./validate.ts";
import { DomainError, HttpError } from "./util.ts";
import * as store from "./store.ts";
import { PRIORITIES, PROJECT_STATUSES, TASK_STATUSES } from "./store.ts";
import { buildDashboard, riskReportForProject } from "./insights.ts";
import { agentStatus, approvePlan, discardPlan, getConversation, handleUserMessage, latestConversationId } from "./agent/agent.ts";
import { getPlan } from "./agent/plans.ts";

const PUBLIC_DIR = path.resolve(import.meta.dirname, "..", "public");
const MAX_BODY = 64 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// ---------------------------------------------------------------- schemas for REST bodies
const nullableDate = () => v.nullable(v.datetime()).optional();
const S = {
  projectCreate: v.object({
    name: v.string({ min: 1, max: 120 }),
    description: v.string({ max: 1000 }).optional(),
    deadline: v.datetime().optional(),
    status: v.enum(PROJECT_STATUSES).optional(),
  }),
  projectPatch: v.object({
    name: v.string({ min: 1, max: 120 }).optional(),
    description: v.string({ max: 1000 }).optional(),
    deadline: nullableDate(),
    status: v.enum(PROJECT_STATUSES).optional(),
  }),
  taskCreate: v.object({
    project_id: v.string({ min: 1, max: 64 }),
    title: v.string({ min: 1, max: 160 }),
    description: v.string({ max: 2000 }).optional(),
    status: v.enum(TASK_STATUSES).optional(),
    priority: v.enum(PRIORITIES).optional(),
    assignee_id: v.nullable(v.string({ min: 1, max: 64 })).optional(),
    start_at: nullableDate(),
    due_at: nullableDate(),
    estimate_hours: v.nullable(v.number({ min: 0, max: 1000 })).optional(),
    is_milestone: v.boolean().optional(),
    depends_on: v.array(v.string({ min: 1, max: 64 }), { max: 20 }).optional(),
  }),
  taskPatch: v.object({
    title: v.string({ min: 1, max: 160 }).optional(),
    description: v.string({ max: 2000 }).optional(),
    status: v.enum(TASK_STATUSES).optional(),
    priority: v.enum(PRIORITIES).optional(),
    assignee_id: v.nullable(v.string({ min: 1, max: 64 })).optional(),
    start_at: nullableDate(),
    due_at: nullableDate(),
    estimate_hours: v.nullable(v.number({ min: 0, max: 1000 })).optional(),
    is_milestone: v.boolean().optional(),
  }),
  dep: v.object({ depends_on_id: v.string({ min: 1, max: 64 }) }),
  memberCreate: v.object({
    name: v.string({ min: 1, max: 80 }),
    role: v.string({ min: 1, max: 80 }),
    daily_hours: v.number({ min: 0.5, max: 16 }).optional(),
  }),
  memberPatch: v.object({
    name: v.string({ min: 1, max: 80 }).optional(),
    role: v.string({ min: 1, max: 80 }).optional(),
    daily_hours: v.number({ min: 0.5, max: 16 }).optional(),
  }),
  agentMessage: v.object({
    conversation_id: v.string({ min: 1, max: 64 }).optional(),
    project_id: v.nullable(v.string({ min: 1, max: 64 })).optional(),
    message: v.string({ min: 1, max: 2000 }),
  }),
  taskQuery: v.object({
    project_id: v.string({ max: 64 }).optional(),
    status: v.enum(TASK_STATUSES).optional(),
    priority: v.enum(PRIORITIES).optional(),
    assignee_id: v.string({ max: 64 }).optional(),
    q: v.string({ max: 100 }).optional(),
    blocked: v.enum(["true", "false"] as const).optional(),
    overdue: v.enum(["true", "false"] as const).optional(),
  }),
};

/** null means "clear this field" in a PATCH; the store treats null as a value and undefined as "unchanged". */
const clean = <T extends Record<string, any>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, val]) => val !== undefined)) as T;

// ---------------------------------------------------------------- routing
interface Ctx {
  req: IncomingMessage;
  params: string[];
  query: URLSearchParams;
  body: () => Promise<unknown>;
  ip: string;
}
type Handler = (c: Ctx) => unknown | Promise<unknown>;
const routes: { method: string; re: RegExp; handler: Handler; limit?: "agent" }[] = [];
const route = (method: string, pattern: string, handler: Handler, limit?: "agent") =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:[a-z]+/g, "([A-Za-z0-9_-]+)")}$`), handler, limit });

route("GET", "/api/health", () => ({ ok: true, db: db().prepare("SELECT 1 AS ok").get() !== undefined, mode: agentStatus().mode, time: new Date().toISOString() }));
route("GET", "/api/dashboard", (c) => buildDashboard(c.query.get("project") ?? undefined));

route("GET", "/api/projects", () => store.listProjects());
route("POST", "/api/projects", async (c) => store.createProject(clean(S.projectCreate.parse(await c.body())), "user"));
route("GET", "/api/projects/:id", (c) => store.requireProject(c.params[0]));
route("PATCH", "/api/projects/:id", async (c) => store.updateProject(c.params[0], clean(S.projectPatch.parse(await c.body())), "user"));
route("DELETE", "/api/projects/:id", (c) => (store.deleteProject(c.params[0], "user"), { deleted: true }));
route("GET", "/api/projects/:id/risks", (c) => riskReportForProject(c.params[0]));

route("GET", "/api/tasks", (c) => {
  const q = S.taskQuery.parse(Object.fromEntries(c.query));
  return store.listTasks({ ...q, blocked: q.blocked === undefined ? undefined : q.blocked === "true", overdue: q.overdue === undefined ? undefined : q.overdue === "true" });
});
route("POST", "/api/tasks", async (c) => store.createTask(clean(S.taskCreate.parse(await c.body())) as any, "user"));
route("GET", "/api/tasks/:id", (c) => store.requireTask(c.params[0]));
route("PATCH", "/api/tasks/:id", async (c) => store.updateTask(c.params[0], clean(S.taskPatch.parse(await c.body())) as any, "user"));
route("DELETE", "/api/tasks/:id", (c) => (store.deleteTask(c.params[0], "user"), { deleted: true }));
route("POST", "/api/tasks/:id/dependencies", async (c) => store.addDependency(c.params[0], S.dep.parse(await c.body()).depends_on_id, "user"));
route("DELETE", "/api/tasks/:id/dependencies/:dep", (c) => store.removeDependency(c.params[0], c.params[1], "user"));

route("GET", "/api/team", () => store.listMembers());
route("POST", "/api/team", async (c) => store.createMember(clean(S.memberCreate.parse(await c.body())) as any, "user"));
route("PATCH", "/api/team/:id", async (c) => store.updateMember(c.params[0], clean(S.memberPatch.parse(await c.body())), "user"));
route("DELETE", "/api/team/:id", (c) => store.deleteMember(c.params[0], "user"));

route("GET", "/api/activity", (c) => {
  const limit = Number(c.query.get("limit") ?? 50);
  return store.listActivity({ limit: Number.isFinite(limit) ? limit : 50, projectId: c.query.get("project") ?? undefined });
});

route("GET", "/api/agent/status", () => agentStatus());
route("GET", "/api/agent/conversation", () => {
  const id = latestConversationId();
  return id ? getConversation(id) : null;
});
route("GET", "/api/agent/conversations/:id", (c) => {
  const conv = getConversation(c.params[0]);
  if (!conv) throw new DomainError("not_found", "Conversation not found.");
  return conv;
});
route("POST", "/api/agent/message", async (c) => {
  const b = S.agentMessage.parse(await c.body());
  return handleUserMessage({ conversationId: b.conversation_id, projectId: b.project_id ?? null, text: b.message });
}, "agent");
route("GET", "/api/agent/plans/:id", (c) => {
  const p = getPlan(c.params[0]);
  if (!p) throw new DomainError("not_found", "Plan not found.");
  return p;
});
route("POST", "/api/agent/plans/:id/approve", (c) => approvePlan(c.params[0]));
route("POST", "/api/agent/plans/:id/reject", (c) => discardPlan(c.params[0]));

route("POST", "/api/demo/reset", () => ({ ok: true, ...resetDemo() }));

// ---------------------------------------------------------------- plumbing
const hits = new Map<string, { n: number; start: number }>();
function limited(ip: string, bucket: string, max: number): boolean {
  const key = `${bucket}:${ip}`;
  const t = Date.now();
  const h = hits.get(key);
  if (!h || t - h.start > 60_000) { hits.set(key, { n: 1, start: t }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (t - h.start > 60_000) hits.delete(k); }, 60_000).unref();

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...securityHeaders(), ...headers });
  res.end(payload);
}

function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] ?? "";
    if (!type.toLowerCase().startsWith("application/json")) return reject(new HttpError(415, "unsupported_media_type", "Send JSON with Content-Type: application/json."));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (ch: Buffer) => {
      size += ch.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "payload_too_large", "Request body is too large.")); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, "invalid_json", "Request body is not valid JSON.")); }
    });
    req.on("error", reject);
  });
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ValidationError) return new HttpError(400, "validation_error", `Invalid input: ${err.message}`, err.issues);
  if (err instanceof DomainError) {
    const status = err.code === "not_found" ? 404 : err.code === "conflict" || err.code === "circular_dependency" ? 409 : err.code === "daily_limit" ? 429 : 422;
    return new HttpError(status, err.code, err.message);
  }
  console.error("[server] unexpected error:", err);
  return new HttpError(500, "internal_error", "Something went wrong on the server.");
}

function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === "1") {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.resolve(PUBLIC_DIR, "." + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403, securityHeaders()); res.end("Forbidden"); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", ...securityHeaders() });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...securityHeaders() });
    res.end("Not found");
  }
}

export function createApp(): Server {
  db(); // open + migrate
  ensureSeeded();
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, securityHeaders()); res.end("Method not allowed"); return; }
        await serveStatic(req, res, url.pathname);
        return;
      }
      const ip = clientIp(req);
      if (limited(ip, "api", 600)) throw new HttpError(429, "rate_limited", "Too many requests. Slow down a little.");
      let matchedPath = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        matchedPath = true;
        if (r.method !== req.method) continue;
        if (r.limit === "agent" && limited(ip, "agent", Number(process.env.AGENT_RATE_PER_MINUTE ?? 20))) {
          throw new HttpError(429, "rate_limited", "You're sending requests to the assistant too quickly. Wait a moment and try again.");
        }
        const result = await r.handler({ req, params: m.slice(1), query: url.searchParams, body: () => readBody(req), ip });
        send(res, 200, result ?? null);
        return;
      }
      throw new HttpError(matchedPath ? 405 : 404, matchedPath ? "method_not_allowed" : "not_found", matchedPath ? "Method not allowed." : "No such endpoint.");
    } catch (err) {
      const e = toHttpError(err);
      send(res, e.status, { error: { code: e.code, message: e.message, ...(e.details ? { issues: e.details } : {}) } });
    }
  });
}

if (import.meta.filename === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createApp();
  server.listen(port, host, () => {
    const s = agentStatus();
    console.log(`MissionControl AI listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    console.log(`AI mode: ${s.label}${s.mode === "demo" ? ` (${s.reason})` : ""}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
