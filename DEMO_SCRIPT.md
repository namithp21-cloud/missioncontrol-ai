# Demo video script (target 2:30, limit is under 3:00)

The rules require a public YouTube/Vimeo video under 3 minutes that clearly shows the simulated Alexa+ experience working. Say out loud that it is a simulation and that demo mode is scripted.

**Before recording:** `npm run demo:reset` (or sidebar → Reset demo workspace), open `http://localhost:3000`, window about 1440x900, browser zoom 100%.

| Time | Do | Say |
|---|---|---|
| 0:00 | Dashboard | "MissionControl AI is a simulated Alexa+ style team coordinator. It doesn't just chat: it plans, asks for approval, then changes real data." |
| 0:15 | Point at metrics, overdue card, DEMO pills | "Demo workspace: a four-person student team, three days to submit. Every number here is computed from the database. One task is already overdue." |
| 0:30 | Click **Run the demo scenario** | "I'll ask for the full plan in one sentence." |
| 0:40 | Assistant shows plan | "This banner says demo mode: the reply is scripted, not a language model. With an API key, a live model uses the same tools." |
| 0:55 | Scroll the proposed plan | "Thirteen proposed tasks, owners, priorities, due dates and dependencies. Notice the status: Proposed. Nothing is saved yet." |
| 1:10 | Open the risk preview | "Before I approve I can see the risks: an overloaded teammate and the overdue Devpost task, each with a mitigation. These are heuristics, not predictions." |
| 1:30 | Click **Approve and apply** | "Execution runs step by step and reports what really happened." |
| 1:40 | Show 13 completed pills | "13 of 13 succeeded. If a step failed it would say so and dependants would be skipped." |
| 1:50 | Dashboard | "The dashboard updated: 17 tasks, 11 blocked on dependencies, timeline with arrows, workload per person, and the activity feed logs the AI plan." |
| 2:10 | Tasks → drag a card; open a task and try a circular dependency | "Kanban changes persist. Circular dependencies are rejected with a clear message." |
| 2:30 | Sidebar → Reset demo workspace | "One click restores the seeded state, so the demo is repeatable." |
| 2:40 | Back to dashboard, end | "Simple stack, every action validated and approved. Thanks." |

**Fallback if the plan step errors on camera:** Reset the workspace and rerun. The scenario is deterministic.
