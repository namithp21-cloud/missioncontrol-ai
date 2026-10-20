import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

// An isolated in-memory database and demo mode, regardless of the developer's environment.
process.env.DATABASE_PATH = ":memory:";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

let server: Server;
let base = "";

before(async () => {
  const { createApp } = await import("../server/index.ts");
  server = createApp();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const PLAN_PROMPT = "We have three days until our hackathon submission. Create a project plan for four team members, break the work into tasks, assign owners, identify dependencies, check for scheduling conflicts, and show us the biggest risks.";

test("seeds a labelled demo workspace: 4 members, 1 project, 4 tasks", async () => {
  const team = (await call("GET", "/api/team")).body;
  const projects = (await call("GET", "/api/projects")).body;
  const tasks = (await call("GET", "/api/tasks")).body;
  assert.equal(team.length, 4);
  assert.equal(projects.length, 1);
  assert.equal(tasks.length, 4);
  assert.ok(projects[0].is_demo && projects[0].name.includes("DEMO"));
});

test("dashboard metrics are derived from the data", async () => {
  const d = (await call("GET", "/api/dashboard")).body;
  const tasks = (await call("GET", "/api/tasks")).body;
  assert.equal(d.metrics.tasks_total, tasks.length);
  assert.equal(d.metrics.tasks_done, tasks.filter((t: any) => t.status === "done").length);
  assert.equal(d.metrics.overdue, tasks.filter((t: any) => t.is_overdue).length);
});

test("validation: bad input is rejected with 400, not stored", async () => {
  const r = await call("POST", "/api/tasks", { project_id: "p_demo_hack", title: "", due_at: "not a date" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "validation_error");
  const r2 = await call("POST", "/api/tasks", { project_id: "p_demo_hack", title: "x", assignee_id: "m_nobody" });
  assert.ok(r2.status >= 400 && r2.status < 500);
  const r3 = await call("POST", "/api/tasks", { project_id: "p_demo_hack", title: "x", start_at: "2026-10-20T10:00:00Z", due_at: "2026-10-19T10:00:00Z" });
  assert.equal(r3.status, 422);
  assert.equal((await call("GET", "/api/tasks")).body.length, 4);
});

test("transport hardening: non-JSON content type and malformed JSON", async () => {
  const a = await fetch(base + "/api/projects", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
  assert.equal(a.status, 415);
  const b = await fetch(base + "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(b.status, 400);
  assert.equal((await call("GET", "/api/nope")).status, 404);
});

test("dependencies: self, unknown and circular references are refused", async () => {
  const a = (await call("POST", "/api/tasks", { project_id: "p_demo_hack", title: "A" })).body;
  const b = (await call("POST", "/api/tasks", { project_id: "p_demo_hack", title: "B", depends_on: [a.id] })).body;
  assert.deepEqual(b.depends_on, [a.id]);
  assert.equal((await call("POST", `/api/tasks/${a.id}/dependencies`, { depends_on_id: a.id })).status, 422);
  assert.equal((await call("POST", `/api/tasks/${a.id}/dependencies`, { depends_on_id: "t_missing" })).status, 422);
  const cyc = await call("POST", `/api/tasks/${a.id}/dependencies`, { depends_on_id: b.id });
  assert.equal(cyc.status, 409);
  assert.equal(cyc.body.error.code, "circular_dependency");
  assert.ok((await call("GET", `/api/tasks/${b.id}`)).body.is_blocked, "B waits on unfinished A");
  await call("DELETE", `/api/tasks/${b.id}`);
  await call("DELETE", `/api/tasks/${a.id}`);
});

test("demo agent: proposing a plan changes nothing; approving creates real tasks; double-approve is refused", async () => {
  const before = (await call("GET", "/api/tasks")).body.length;
  const msg = (await call("POST", "/api/agent/message", { message: PLAN_PROMPT })).body;
  const assistant = msg.messages.find((m: any) => m.role === "assistant");
  assert.equal(assistant.meta.source, "demo_mode", "scripted output is labelled as demo, never as a live model");
  assert.ok(assistant.plan && assistant.plan.status === "proposed");
  const n = assistant.plan.steps.length;
  assert.ok(n >= 8);
  assert.equal((await call("GET", "/api/tasks")).body.length, before, "nothing persisted before approval");

  const ok = await call("POST", `/api/agent/plans/${assistant.plan.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.plan.status, "completed");
  assert.equal(ok.body.plan.counts.completed, n);
  const after = (await call("GET", "/api/tasks")).body;
  assert.equal(after.length, before + n);
  assert.ok(after.filter((t: any) => t.depends_on.length).length >= 8, "dependencies were created");
  assert.ok(after.some((t: any) => !t.assignee_id && t.status !== "done"), "an unassigned task is left for the user to decide");

  assert.equal((await call("POST", `/api/agent/plans/${assistant.plan.id}/approve`)).status, 409);
  const risks = (await call("GET", "/api/projects/p_demo_hack/risks")).body;
  assert.ok(risks.risks.length > 0);
  assert.match(risks.disclaimer, /does not predict/i);
});

test("discarding a plan makes no changes", async () => {
  const before = (await call("GET", "/api/tasks")).body.length;
  const msg = (await call("POST", "/api/agent/message", { message: "Add task: Record a backup video, high priority, for Diego, due in 2 days" })).body;
  const plan = msg.messages.find((m: any) => m.plan).plan;
  assert.equal(plan.steps.length, 1);
  const rej = await call("POST", `/api/agent/plans/${plan.id}/reject`);
  assert.equal(rej.body.plan.status, "rejected");
  assert.equal((await call("GET", "/api/tasks")).body.length, before);
});

test("unrecognised requests get an honest demo-mode answer, not a fake success", async () => {
  const msg = (await call("POST", "/api/agent/message", { message: "Please order me a pizza" })).body;
  const a = msg.messages.find((m: any) => m.role === "assistant");
  assert.ok(!a.plan);
  assert.match(a.content, /didn't recognise/i);
});

test("reset restores the original seeded state and keeps user-created projects", async () => {
  const mine = (await call("POST", "/api/projects", { name: "My own project" })).body;
  assert.equal((await call("POST", "/api/demo/reset", {})).status, 200);
  const tasks = (await call("GET", "/api/tasks")).body;
  assert.equal(tasks.length, 4);
  assert.equal((await call("GET", "/api/tasks/t_demo_devpost")).body.status, "todo");
  assert.equal((await call("GET", `/api/projects/${mine.id}`)).status, 200, "non-demo data survives a reset");
  await call("DELETE", `/api/projects/${mine.id}`);
});

test("static files are served with a strict CSP and no path traversal", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  const trav = await fetch(base + "/..%2f..%2fpackage.json");
  assert.notEqual(trav.status, 200);
});
