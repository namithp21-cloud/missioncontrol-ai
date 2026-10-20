import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

/**
 * Exercises LIVE mode end to end without a real API key: a mock server speaks the Anthropic Messages API, so the
 * real provider code, tool validation, plan creation and approval gate all run. It proves the wiring; it does not
 * prove how well any particular model plans (that needs a real key).
 */
process.env.DATABASE_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "test-key-not-real";

let mock: Server, app: Server, base = "";
let mode: "tools" | "unauthorized" = "tools";
const seen: any[] = [];

before(async () => {
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ headers: req.headers, body });
      if (mode === "unauthorized") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "invalid x-api-key" } })); return; }
      const hasToolResults = body.messages.some((m: any) => m.content.some?.((b: any) => b.type === "tool_result"));
      res.writeHead(200, { "content-type": "application/json" });
      if (!hasToolResults) {
        res.end(JSON.stringify({ content: [
          { type: "text", text: "Let me look at the team first." },
          { type: "tool_use", id: "tu_1", name: "list_team", input: {} },
          { type: "tool_use", id: "tu_2", name: "create_task", input: { ref: "ship", project_id: "p_demo_hack", title: "Live-AI proposed task", assignee_id: "m_demo_priya", priority: "high", due_at: new Date(Date.now() + 2 * 86400000).toISOString(), estimate_hours: 3 } },
          { type: "tool_use", id: "tu_3", name: "create_task", input: { project_id: "p_demo_hack", title: "Hallucinated owner", assignee_id: "m_ghost" } },
          { type: "tool_use", id: "tu_4", name: "run_sql", input: { sql: "DROP TABLE tasks" } },
        ] }));
      } else {
        res.end(JSON.stringify({ content: [{ type: "text", text: "I propose one task for Priya. One step was rejected because that owner does not exist." }] }));
      }
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(mock.address() as any).port}`;
  const { createApp } = await import("../server/index.ts");
  app = createApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as any).port}`;
});
after(() => { app.close(); mock.close(); });

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test("status reports live mode and never leaks the key", async () => {
  const s = await call("GET", "/api/agent/status");
  assert.equal(s.body.mode, "live");
  assert.equal(s.body.provider, "anthropic");
  assert.ok(!JSON.stringify(s.body).includes("test-key-not-real"));
});

test("live agent: model tool calls are validated, only valid writes become a PROPOSED plan, nothing is applied until approval", async () => {
  const before = (await call("GET", "/api/tasks")).body.length;
  const r = await call("POST", "/api/agent/message", { message: "Add one task for Priya to ship the thing" });
  const a = r.body.messages.find((m: any) => m.role === "assistant");
  assert.equal(a.meta.source, "live_ai");

  // the request carried our key and only whitelisted tools: no code/SQL execution tool exists
  const first = seen[0];
  assert.equal(first.headers["x-api-key"], "test-key-not-real");
  const toolNames = first.body.tools.map((t: any) => t.name);
  assert.ok(toolNames.includes("create_task") && toolNames.includes("get_risk_report"));
  assert.ok(!toolNames.some((n: string) => /sql|exec|eval|shell|code/i.test(n)));

  // the plan holds exactly the one valid write; the invalid and unknown calls were refused and logged as failed
  assert.equal(a.plan.status, "proposed");
  assert.equal(a.plan.steps.length, 1);
  assert.equal(a.plan.steps[0].input.title, "Live-AI proposed task");
  const log = a.meta.tool_calls as any[];
  assert.equal(log.find((t) => t.tool === "list_team").status, "completed");
  assert.equal(log.find((t) => t.tool === "run_sql").status, "failed");
  assert.equal(log.filter((t) => t.tool === "create_task" && t.status === "failed").length, 1);
  assert.equal((await call("GET", "/api/tasks")).body.length, before, "nothing written before approval");

  // the model was told its bad step failed (so it can correct itself) rather than being told it succeeded
  const toolResults = seen[1].body.messages.flatMap((m: any) => m.content).filter((b: any) => b.type === "tool_result").map((b: any) => b.content);
  assert.ok(toolResults.some((c: string) => /^Rejected/.test(c)));
  assert.ok(toolResults.some((c: string) => /not an available tool/.test(c)));

  const ok = await call("POST", `/api/agent/plans/${a.plan.id}/approve`);
  assert.equal(ok.body.plan.status, "completed");
  const tasks = (await call("GET", "/api/tasks")).body;
  assert.equal(tasks.length, before + 1);
  assert.ok(tasks.some((t: any) => t.title === "Live-AI proposed task" && t.assignee_id === "m_demo_priya"));
});

test("live agent: provider auth failure is reported honestly, with no plan and no changes", async () => {
  mode = "unauthorized";
  const before = (await call("GET", "/api/tasks")).body.length;
  const r = await call("POST", "/api/agent/message", { message: "Plan the project" });
  const a = r.body.messages.find((m: any) => m.role === "assistant");
  assert.equal(a.meta.kind, "error");
  assert.match(a.content, /rejected the API key/);
  assert.ok(!a.plan);
  assert.equal((await call("GET", "/api/tasks")).body.length, before);
  mode = "tools";
});
