# Submission checklist (Devpost, Alexa+ track)

Source: official rules at https://amazonappdev2026.devpost.com/rules (read 2026-10-18). **Re-read them yourself before submitting**; this is my summary, not legal advice.

**Deadline: Friday 23 Oct 2026, 12:00 pm Pacific (= Sat 24 Oct, 00:30 am IST).**

## Why this qualifies (as I read the rules)
The Alexa+ track accepts a working Agent Skill, a self-hosted MCP server, **or "a simulated Alexa+ experience"** built with any tool. The simulation path is exempt from the runtime-technology requirement, but the repo must include its source and the video must "clearly show the simulated experience." This project takes that path. If you later want the MCP route, the tools in `server/agent/tools.ts` are the part to expose.

## Required items
- [ ] Project built or significantly updated after 31 Aug 2026
- [ ] **Public GitHub repo with an open-source license** (MIT included; set your team name in `LICENSE`) containing source, assets and setup/run instructions (README)
- [ ] Text description of features and functionality (draft below)
- [ ] **Demo video under 3 minutes**, public on YouTube or Vimeo, clearly showing the simulation (see `DEMO_SCRIPT.md`)
- [ ] **Product feedback** for each tool/API/SDK you used (template below)
- [ ] Primary track selected: Alexa+; any mini-challenges chosen
- [ ] Judges can test it for free until judging ends (demo mode needs no key; if you deploy with a key keep `AGENT_DAILY_LIMIT` low)
- [ ] Team eligibility checked (age of majority, no sponsor/administrator affiliation)

## Description draft
MissionControl AI is a simulated Alexa+ style team coordinator for student and hackathon teams. Ask for something in plain language ("plan our hackathon, assign owners, show the risks") and an agent proposes an ordered plan with task owners, due dates and dependencies, previews the scheduling risks, and waits for your approval. Approved steps run through validated tools against a persistent SQLite database, and an execution report shows exactly which steps succeeded or failed. A dashboard (progress, overdue and blocked work, workload, timeline, activity feed) is computed from the real data. Without an API key it runs in a clearly labelled scripted demo mode; with a key, a live model (Anthropic or any OpenAI-compatible API) uses the same whitelisted tools. It is a simulation, not an official Amazon product.

## Product feedback template (fill in from your own experience)
For each tool you used (e.g. Claude Code / the model API, Node.js `node:sqlite`, Playwright, Devpost): what worked, what didn't, and what you'd change. Optional friction-log entries can earn bonus points.
