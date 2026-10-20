/**
 * Demo workspace: a fictional four-person student hackathon team. Everything here is flagged is_demo = 1,
 * uses fixed ids, and is removed and re-created by resetDemo(). Dates are relative to "now" so the demo is
 * always three days out when seeded; set MC_NOW to pin the clock for fully identical runs.
 */
import { db, tx } from "./db.ts";
import { addHours, now, nowIso } from "./util.ts";
import { logActivity } from "./store.ts";

export const DEMO_PROJECT_ID = "p_demo_hack";

export const DEMO_MEMBERS = [
  { id: "m_demo_priya", name: "Priya Nair", role: "Full-stack lead", daily_hours: 10, color: "#7c83ff" },
  { id: "m_demo_marcus", name: "Marcus Chen", role: "AI & agent engineer", daily_hours: 10, color: "#38bdf8" },
  { id: "m_demo_aisha", name: "Aisha Rahman", role: "UI/UX designer", daily_hours: 9, color: "#a78bfa" },
  { id: "m_demo_diego", name: "Diego Alvarez", role: "Product & demo lead", daily_hours: 8, color: "#34d399" },
] as const;

function base(): Date {
  const n = now();
  return new Date(Math.floor(n.getTime() / 3_600_000) * 3_600_000);
}

function insertSeed(): void {
  const conn = db();
  const t0 = base();
  const at = (h: number) => addHours(t0, h).toISOString();
  const ts = nowIso();

  for (const m of DEMO_MEMBERS) {
    conn.prepare("INSERT INTO members (id, name, role, daily_hours, color, is_demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(m.id, m.name, m.role, m.daily_hours, m.color, ts);
  }
  conn.prepare(
    "INSERT INTO projects (id, name, description, status, deadline, is_demo, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 1, ?, ?)",
  ).run(
    DEMO_PROJECT_ID,
    "StudyPilot — Hackathon Submission (DEMO)",
    "DEMO DATA: a fictional four-person student team racing to submit StudyPilot, an AI study-planning app, in three days. Resetting the demo workspace restores exactly this starting state.",
    at(72), ts, ts,
  );

  const tasks = [
    { id: "t_demo_idea", title: "Pick the project idea and name", status: "done", priority: "high", who: "m_demo_diego", s: -30, d: -24, est: 3 },
    { id: "t_demo_repo", title: "Set up repository and CI", status: "done", priority: "medium", who: "m_demo_priya", s: -26, d: -20, est: 2 },
    { id: "t_demo_devpost", title: "Register the team on Devpost", status: "todo", priority: "high", who: "m_demo_diego", s: -10, d: -4, est: 1 },
    { id: "t_demo_brand", title: "Choose brand colours and logo", status: "in_progress", priority: "medium", who: "m_demo_aisha", s: -6, d: 10, est: 3 },
  ] as const;
  for (const t of tasks) {
    conn.prepare(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, assignee_id, start_at, due_at, estimate_hours, is_milestone, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(t.id, DEMO_PROJECT_ID, t.title, t.status, t.priority, t.who, at(t.s), at(t.d), t.est, ts, ts, t.status === "done" ? at(t.d) : null);
  }
  logActivity("system", "demo.seeded", "project", DEMO_PROJECT_ID, DEMO_PROJECT_ID, "Demo workspace loaded: 4 team members, 1 project, 4 sample tasks (all labelled DEMO)");
}

/** Seeds the demo workspace once, on a brand-new database. Never overwrites existing data. */
export function ensureSeeded(): boolean {
  const flag = db().prepare("SELECT value FROM app_meta WHERE key = 'demo_seeded'").get();
  if (flag) return false;
  tx(() => {
    insertSeed();
    db().prepare("INSERT INTO app_meta (key, value) VALUES ('demo_seeded', ?)").run(nowIso());
  });
  return true;
}

/**
 * Removes every demo row (members, project, tasks, activity, AI conversations and plans for the demo) and
 * re-creates the original seed. Data the user created outside the demo project is left alone.
 */
export function resetDemo(): { removed_projects: number } {
  return tx(() => {
    const conn = db();
    const removed = Number((conn.prepare("DELETE FROM projects WHERE is_demo = 1").run()).changes);
    conn.prepare("DELETE FROM conversations WHERE is_demo = 1").run();
    conn.prepare("DELETE FROM activity WHERE is_demo = 1").run();
    conn.prepare("DELETE FROM members WHERE is_demo = 1").run();
    insertSeed();
    conn.prepare("INSERT INTO app_meta (key, value) VALUES ('demo_seeded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(nowIso());
    logActivity("system", "demo.reset", "project", DEMO_PROJECT_ID, DEMO_PROJECT_ID, "Demo workspace was reset to its original state");
    return { removed_projects: removed };
  });
}
