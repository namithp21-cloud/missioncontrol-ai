import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(import.meta.dirname, "migrations");

export function databasePath(): string {
  if (process.env.DATABASE_PATH === ":memory:") return ":memory:"; // SQLite's in-memory mode, not a file called ":memory:"
  return process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : path.join(ROOT, "data", "missioncontrol.db");
}

let instance: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (instance) return instance;
  const file = databasePath();
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");
  instance = conn;
  migrate(conn);
  return conn;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

/** Applies any pending SQL files in server/migrations in filename order. Safe to run repeatedly. */
export function migrate(conn: DatabaseSync): string[] {
  conn.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((conn.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    conn.exec("BEGIN");
    try {
      conn.exec(sql);
      conn.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
      conn.exec("COMMIT");
      ran.push(file);
    } catch (err) {
      conn.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return ran;
}

let txDepth = 0;

/**
 * Runs fn inside a transaction (nested calls use savepoints). Throwing rolls back.
 * Pass { rollback: true } to always roll back - used for dry-run validation of AI proposals.
 */
export function tx<T>(fn: () => T, opts: { rollback?: boolean } = {}): T {
  const conn = db();
  const name = `sp_${txDepth}`;
  if (txDepth === 0) conn.exec("BEGIN IMMEDIATE");
  else conn.exec(`SAVEPOINT ${name}`);
  txDepth++;
  try {
    const out = fn();
    txDepth--;
    if (opts.rollback) {
      if (txDepth === 0) conn.exec("ROLLBACK");
      else conn.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    } else if (txDepth === 0) conn.exec("COMMIT");
    else conn.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    txDepth--;
    if (txDepth === 0) conn.exec("ROLLBACK");
    else conn.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  }
}
