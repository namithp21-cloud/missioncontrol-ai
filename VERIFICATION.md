# Verification checklist

Environment: Node 22.22, Chromium via Playwright, Linux container. Tested **2026-10-18**.

## Tested (automated, passing)

`npm test` → 13/13 (run twice, on a true in-memory database).

- Seeded demo workspace (4 members, 1 project, 4 tasks, labelled DEMO); dashboard metrics equal values derived from tasks
- Input validation (empty title, bad date, unknown assignee, start after due) rejected and not stored
- Non-JSON content type → 415; malformed JSON → 400; unknown route → 404
- Dependencies: self, unknown and circular references refused (409 `circular_dependency`); blocked flag derived
- Demo agent: plan proposed, **nothing persisted**, approve creates 13 tasks with dependencies, double-approve refused (409)
- Discarding a plan changes nothing; unrecognised requests get an honest answer
- Reset restores seeded state and keeps user-created projects
- CSP header present; path traversal not served
- **Live mode (against a mock Anthropic-style server):** request carries the key, tool list has no code/SQL tool, invalid and unknown tool calls are rejected and reported to the model as failures, only valid writes become a proposed plan, approval applies them, provider 401 is reported honestly with no changes, key never appears in `/api/agent/status`

## Tested (browser, Playwright, 33/33 passing)

Dashboard render and metrics; demo prompt → proposed plan with demo labelling and risk preview; nothing saved before approval; approve → 13/13 completed, tasks persisted; dashboard totals, timeline bars, dependency arrows and workload update; risk answer with mitigations; Kanban status change and drag-and-drop persist; search filters and keeps focus; circular-dependency error shown in the dialog; task created via UI; changes survive reload; Team and Projects views, risk dialog; Activity log; notification popover; Reset demo restores state; mobile (390px) has no horizontal overflow and the nav drawer opens; zero console/page errors (CSP violations would show here; the single expected 409 from the deliberate cycle test is excluded).

Also verified: `db:migrate` is idempotent, `demo:reset` works, `.env` loading works.

Screenshots from the run were reviewed by eye for layout.

## Implemented but NOT tested

- **Live mode with a real model** (no API key was available). Only the wiring is verified, not plan quality.
- **Dockerfile** (no Docker daemon in the build environment).
- **Any deployment**: no public URL exists yet.
- OpenAI-compatible provider (code exists; not exercised).
- Keyboard-only and screen-reader walkthrough (focus styles, labels, skip link, `aria-live` are implemented; no assistive-technology testing).
- Browsers other than Chromium; the in-page `<dialog>` and drag-and-drop behave differently in Safari/Firefox in places.

## Not implemented

Authentication / multiple users, MCP server or Alexa Agent Skill, voice, real Alexa+ integration, email/calendar integrations.
