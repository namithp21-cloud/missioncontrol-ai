# MissionControl AI

An AI team coordinator that turns a natural-language request into a **reviewed plan**, then executes the approved steps through **real, validated tools** and reports exactly what succeeded.

Built for the Amazon *Build, Ship, Shape* Developer Hackathon, **Alexa+ track, "simulated Alexa+ experience" path**. This is **not** an official Amazon or Alexa+ product, and it uses no Amazon services.

- Zero runtime dependencies: Node.js 22 (>= 22.18) with the built-in `node:sqlite`. No `npm install` needed.
- Frontend is plain ES modules (no build step). All DOM is built with `textContent`/`createElement`, and a strict CSP (`script-src 'self'`) is enforced.

## Run locally

```bash
node -v            # must be >= 22.18
cp .env.example .env   # optional; with no key the app runs in labelled DEMO MODE
npm start          # http://localhost:3000
```

Other commands: `npm run dev` (watch mode), `npm test`, `npm run db:migrate`, `npm run demo:reset`.

## AI modes

| Mode | When | Behaviour |
|---|---|---|
| **Demo mode** | No key set (default) | Deterministic, rule-based scenarios. Always labelled "scripted, not an AI model" in the banner, on every message and in the sidebar. Tools, approvals and database writes are real. |
| **Live AI** | `ANTHROPIC_API_KEY` set, or `LLM_PROVIDER=openai` + `OPENAI_API_KEY` + `LLM_MODEL` | A real model calls the same validated tools. Read tools run immediately; write tools only **propose** steps. |

The provider layer (`server/agent/providers.ts`) is an interface with two implementations (Anthropic Messages API and any OpenAI-compatible chat-completions API), so another provider means one new class. Keys are read on the server only.

**How safety works:** the model can only call whitelisted tools (no code, SQL or network tools exist). Every tool input is schema-validated. Every proposed write is dry-run inside a rolled-back transaction, so bad references, circular dependencies and invalid dates are rejected before the user sees the plan. Nothing is saved until the user clicks **Approve**. Execution commits step by step, and the report is read from stored step results, so the model's prose cannot claim success for something that failed.

## Features

- Dashboard: active projects, done/total, overdue, blocked, unassigned, due in 7 days, risk snapshot, team workload, SVG timeline (milestones, dependency arrows, "now" and deadline markers), activity feed. All computed from stored data.
- AI Assistant: conversation, clarifying questions, tool-use log, proposed plan with risk preview, approve/discard, per-step execution report.
- Projects (create, edit, deadline, status, progress, risk report, delete), Tasks (Kanban with drag-and-drop and a keyboard-accessible status menu, list view, search, filters, dependencies, circular-dependency rejection), Team (members, roles, capacity, workload, unassigned flags), Activity log.
- Risk analysis: overdue tasks, blocked tasks, deadline vs due dates, overlapping commitments against each person's daily hours, longest dependency chain, unassigned work. Findings are heuristics, always worded as "may/could", with mitigations and a disclaimer.
- Persistence in SQLite (`data/missioncontrol.db`) with SQL migrations (`server/migrations`). Demo data is flagged `is_demo` and labelled **DEMO** in the UI.
- Responsive layout, collapsible sidebar, mobile drawer, toasts, loading/empty/error states, skip link, focus styles, reduced-motion support.

## Demo workspace and reset

First start seeds a fictional four-person student team (StudyPilot, due in 72 hours, 4 sample tasks). Reset any time:

- UI: sidebar → **Reset demo workspace**, or
- CLI: `npm run demo:reset` (re-seeds in place), or `POST /api/demo/reset`.

Reset deletes only demo rows (and demo conversations/activity). Projects and teammates you created yourself are kept. Set `MC_NOW=2026-10-20T09:00:00Z` for identical dates on every run.

## Deploy to a public HTTPS URL

The app is one Node process plus one SQLite file, so it needs a host with Node >= 22.18 **and a persistent disk**. A `Dockerfile` is included (`VOLUME /data`).

Generic recipe (Render, Fly.io, Railway or any container host):

1. Push this repo to GitHub.
2. Create a web service from the repo using the Dockerfile.
3. Attach a persistent volume mounted at `/data`.
4. Set env vars: `DATABASE_PATH=/data/missioncontrol.db`, `TRUST_PROXY=1`, and optionally `ANTHROPIC_API_KEY` (plus `AGENT_DAILY_LIMIT` to cap spend).
5. The platform provides HTTPS. Health check path: `/api/health`.

Judges must be able to test for free: leaving the key unset keeps the public site in free demo mode. If you do add a key, `AGENT_DAILY_LIMIT` and `AGENT_RATE_PER_MINUTE` protect it. **Not deployed by the author of this build**; no live URL exists yet.

## Architecture

```
public/            static frontend (index.html, styles.css, js/main.js router, js/views/*)
server/index.ts    HTTP server, validated REST routes, rate limits, security headers
server/store.ts    all database reads/writes + activity log, dependency/cycle checks
server/risk.ts     pure risk & workload analysis
server/insights.ts dashboard aggregation
server/agent/      tools.ts (whitelisted, schema-validated), plans.ts (dry-run + execute),
                   agent.ts (orchestrator), providers.ts, demoAgent.ts (scripted mode)
```

`server/agent/tools.ts` holds the tool definitions as plain typed functions with JSON-schema parameters, so the same set can be exposed through an MCP server (e.g. `@modelcontextprotocol/sdk` over Streamable HTTP) without rewriting the logic. **That MCP adapter is not implemented.**

## Known limitations

- Single local workspace: no sign-in or multi-user accounts (the avatar is a placeholder and says so).
- Demo mode understands only a handful of phrasings (plan, risks, workload, assign, mark status, add task).
- Live mode is tested only against a mock Anthropic-style server, not a real model.
- Times display in the browser's timezone; risk text is written in UTC.
- Plan steps run sequentially without rollback of earlier successful steps (by design, so partial results are reported honestly).
- No real Alexa+ / voice integration, no MCP server, no Alexa skill.

## Tests

`npm test` runs 13 automated tests (REST validation, dependency/cycle rules, plan propose/approve/discard, reset, security headers, and the live-mode pipeline against a mock provider). Browser flows were verified with Playwright (see `VERIFICATION.md`).

## License

MIT (`LICENSE`). Change the copyright holder to your team's name before submitting.
