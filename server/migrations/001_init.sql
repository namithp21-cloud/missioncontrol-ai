-- MissionControl AI: initial schema.
-- Demo rows carry is_demo = 1 so they stay distinguishable from user-created data.

CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  role        TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 80),
  daily_hours REAL NOT NULL DEFAULT 6 CHECK (daily_hours > 0 AND daily_hours <= 16),
  color       TEXT NOT NULL DEFAULT '#7c83ff',
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at  TEXT NOT NULL
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'completed')),
  deadline    TEXT,
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
  priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  assignee_id    TEXT REFERENCES members(id) ON DELETE SET NULL,
  start_at       TEXT,
  due_at         TEXT,
  estimate_hours REAL CHECK (estimate_hours IS NULL OR (estimate_hours >= 0 AND estimate_hours <= 1000)),
  is_milestone   INTEGER NOT NULL DEFAULT 0 CHECK (is_milestone IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  completed_at   TEXT
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);

CREATE TABLE task_deps (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('user', 'ai', 'system')),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  project_id  TEXT,
  summary     TEXT NOT NULL,
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))
);
CREATE INDEX idx_activity_ts ON activity(ts DESC);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  is_demo    INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  meta            TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE plans (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id      TEXT,
  summary         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('proposed', 'executing', 'completed', 'partial', 'failed', 'rejected')),
  source          TEXT NOT NULL CHECK (source IN ('live_ai', 'demo_mode')),
  provider        TEXT,
  model           TEXT,
  preview         TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE TABLE plan_steps (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  input       TEXT NOT NULL,
  ref         TEXT,
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'completed', 'failed', 'skipped', 'rejected')),
  result      TEXT,
  error       TEXT,
  executed_at TEXT
);
CREATE INDEX idx_steps_plan ON plan_steps(plan_id, position);

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
