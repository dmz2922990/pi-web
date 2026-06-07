# pi-web: Work Bubble Orchestration

pi-web is a browser UI for the pi coding agent. The Work Bubble feature adds multi-agent orchestration — a user describes a problem, and multiple specialized agents collaborate under a coordinator to solve it.

## Language

**Work Bubble**:
A container for a multi-agent collaboration session. Contains one **Gateway** and one or more **Worker** agents. Created from a **Template**. Stored as `bubble.json` + individual agent session files.
_Avoid_: bubble, pipeline, workflow instance

**Gateway**:
A persistent `AgentSession` that serves as the execution engine of a **Work Bubble**. Its system prompt is **auto-generated from the Workflow graph** — the prompt encodes the step order, branching rules, loop limits, and context passing instructions. The Gateway LLM follows this prompt to call `invoke_{worker}` tools and `submit_result`. Determinism comes from strong prompt constraints, not from a separate code state machine. The Gateway session persists throughout the bubble lifecycle, accumulating context across all invocations.
_Avoid_: orchestrator, coordinator, master agent, planner

**Worker**:
A reusable, generic LLM agent definition. Each worker has a name, label, system prompt (universal — no workflow-specific context), constrained tool set, optional timeout, and optional environment config. Workers are stored independently and can be referenced by any **Workflow**. At bubble creation time, one `AgentSession` is created per worker referenced in the workflow.
_Avoid_: sub-agent, slave agent, task agent, role

**Workflow**:
A composition of **Workers** with orchestration logic. Defines which workers participate, their execution order, success/failure branching, the **Gateway**'s system prompt, and environment variables. A Workflow replaces the old monolithic **Template** concept. Stored as JSON in `~/.pi/agent/workflows/`. Workers are referenced by name — the same worker can appear in multiple workflows.
_Avoid_: template, pipeline, flow

**Template** (legacy):
The original monolithic JSON format that bundled gateway config, worker definitions, and orchestration into one file. Being replaced by separate **Worker** definitions + **Workflow** definitions.
_Avoid_: (kept for backward compat reference only)

**Step**:
A single invocation of a **Worker** within a **Workflow**. A step binds a worker reference to an optional free-text `prompt` field. At runtime, the effective system prompt is: `worker.systemPrompt + "\n\n" + step.prompt`. This lets the same worker serve different purposes in different steps. Steps are the nodes in the workflow's execution graph, connected by **Edges**.
_Avoid_: task, node, stage

**Edge**:
A directed connection between **Steps** in a **Workflow**. Each edge has a type (`onSuccess` or `onFailure`) and points to a target step. Steps without outgoing edges are terminal — reaching them ends the bubble. Steps can have multiple outgoing edges (one per type) and multiple incoming edges (fan-in / loop-back).
_Avoid_: transition, arrow, link

**Iteration**:
One traversal of an edge in the workflow graph. Counted globally per bubble to prevent infinite loops. When `maxIterations` (default 10, configurable per workflow) is reached, the bubble fails with a "max iterations exceeded" error. Displayed in the UI as "round 3/10".
_Avoid_: round, cycle, loop count

**invoke\_{role}**:
A custom tool registered on the **Gateway** for each **Role** in the template. When the gateway's LLM calls this tool, the corresponding **Worker** agent receives the task description via `session.prompt()`. The tool blocks synchronously until the worker completes, then returns a structured result.
_Avoid_: agent call, dispatch

**submit_result**:
A special tool registered on the **Gateway** that signals bubble completion. The gateway calls this with a final status and summary when all tasks are done or an unrecoverable error occurs.
_Avoid_: finish, complete

**Environment Config**:
Per-bubble runtime parameters defined declaratively in the **Worker** and **Workflow** (e.g. source path, build command, output directory). Three layers: Worker declares dependencies, Workflow supplements globals, user fills concrete values at bubble creation time. All values are injected into the worker's effective system prompt.
_Avoid_: env vars, settings, configuration

**Bubble Creation Dialog**:
The entry point for creating a new **Work Bubble**. Contains navigation to secondary pages: Workflow selection + env filling (main page), **Worker** management, and **Workflow** management (secondary pages). Workers and Workflows are managed within this dialog's sub-pages rather than separate sidebar panels.
_Avoid_: new bubble wizard, bubble setup

**Auto-run**:
All worker sessions run in auto-run mode — no human confirmation needed for tool calls. Workers execute autonomously within their constrained tool set.

## Relationships

- A **Worker** is a standalone, reusable definition stored in `~/.pi/agent/workers/`
- A **Workflow** is a standalone definition stored in `~/.pi/agent/workflows/`, referencing Workers by name
- A **Workflow** contains an ordered list of **Steps**, connected by **Edges** (onSuccess/onFailure arrays)
- A **Workflow** has exactly one `entryStep`; **Steps** with no outgoing edges are terminal (with explicit `terminalStatus`)
- Graph topology supports: linear chain, fan-out (parallel), fan-in (AND convergence), and cycles (bounded by `maxIterations`)
- The **Gateway** is an implicit engine component invoked at entry and every fan-in point; not a visible graph node
- A **Work Bubble** is created from 1 **Workflow**, spawns 1 implicit Gateway + N **AgentSessions** (1 per unique Worker referenced)
- At runtime, each **Step**'s effective prompt = `worker.systemPrompt + "\n\n" + step.prompt`
- Environment config has three layers: Worker declares dependencies, Workflow supplements globals, user fills values at bubble creation
- **Export** bundles a Workflow + all referenced Workers into a single `*.pi-workflow.json` file
- **Import** extracts Workers to `~/.pi/agent/workers/` (user resolves name conflicts) and Workflow to `~/.pi/agent/workflows/`
- Old **Templates** are auto-migrated to Worker + Workflow format on first load (linear chain default)

## Example Dialogue

> **User**: I need to fix a memory leak in `/src/auth/session.ts`
>
> **Gateway**: [decomposes task] I'll start by having the code analyzer investigate the file.
> → calls `invoke_code_analyzer({ task: "Analyze /src/auth/session.ts for memory leaks..." })`
>
> **Worker "code_analyzer"**: [uses read, grep tools] Found a missing cleanup in the event listener...
> → returns `{ status: "success", summary: "..." }`
>
> **Gateway**: Analysis complete. Sending fix to the modifier.
> → calls `invoke_code_modifier({ task: "Fix the memory leak...", context: "Analyzer found..." })`
>
> **Worker "code_modifier"**: [uses read, edit tools] Applied fix...
> → returns `{ status: "success", summary: "...", files: ["session.ts"] }`
>
> **Gateway**: Fix applied. Sending to review.
> → calls `invoke_code_reviewer({ task: "Review the changes...", context: "..." })`
>
> **Worker "code_reviewer"**: Found an issue — the cleanup isn't called on error path.
> → returns `{ status: "failed", summary: "..." }`
>
> **Gateway**: Review failed. Sending feedback back to modifier.
> → calls `invoke_code_modifier({ task: "Also handle error path...", context: "Reviewer found..." })`
>
> **Worker "code_modifier"**: [uses edit tool] Added error path cleanup...
> → returns `{ status: "success" }`
>
> *(cycle continues until review passes and build succeeds)*
>
> **Gateway**: → calls `submit_result({ status: "success", summary: "Memory leak fixed and verified" })`
