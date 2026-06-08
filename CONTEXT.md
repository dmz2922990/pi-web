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

**Channel**:
An IM platform integration that allows users to interact with pi-web sessions and bubbles through a messaging app. Each Channel is backed by one **Bot** implementation. Multiple Channels can run simultaneously. Configured via separate config files in `~/.pi/agent/`.
_Avoid_: connector, integration, messenger

**Bot**:
A runtime component that manages the connection to a specific IM platform, receives messages, parses commands, and forwards them to pi-web sessions/bubbles. Each Bot extends `BaseBot` which provides shared command parsing, target resolution, and session/bubble interaction logic. Concrete Bots implement the transport layer (e.g., file polling for Feishu, WebSocket for WeCom). Managed as global singletons in `globalThis`.
_Avoid_: agent, client, adapter, service

**BaseBot**:
An abstract base class providing the shared behavior for all **Bot** implementations: command parsing (`/s`, `/b`, `#target`), target resolution, session/bubble message forwarding, and reply extraction. Concrete subclasses implement transport-specific logic (event receiving, message sending, connection lifecycle).
_Avoid_: bot base, abstract bot, bot interface

**CronTask**:
A scheduled, recurring prompt bound to a specific session or bubble Gateway. Defined by a cron expression and a prompt string. When triggered, the prompt is sent to the target session/bubble via the same code path as `#target msg`, but the Agent's reply is only recorded in the session — no IM notification. Managed via IM commands (`#target /c add/list/del`) and the session UI Crontab tab. Persisted as individual JSON files in `~/.pi/agent/pi-web-crontab/`. Automatically deleted when the associated session or bubble is deleted.
_Avoid_: cron job, scheduled task, timer, alarm

**CronScheduler**:
A process-level singleton that loads all **CronTasks** from disk at startup, maintains in-memory cron timers, and triggers execution at the scheduled time. Uses `getOrCreateWrapper` + `send({ type: "prompt" })` to execute, with per-session serial queues to prevent concurrent prompts. Survives hot-reload via `globalThis`.
_Avoid_: cron engine, task runner, scheduler service

**Passkey**:
A secret string used to authenticate LAN clients accessing pi-web. Two sources: configured via `PI_WEB_PASSWORD` environment variable, or auto-generated as 32-character hex on each startup. Persisted as plain text in `~/.pi/pi-web/passkey` (file permission `600`). Used as the HMAC key for **Session Token** signing. localhost access is exempt from Passkey verification.
_Avoid_: password, access token, auth token, secret key

**Session Token**:
A cryptographically signed value stored in an HttpOnly cookie after successful **Passkey** verification. Signed with HMAC using the current Passkey as the key. Automatically invalidates when the Passkey changes (e.g. server restart in random mode). Verified by Next.js middleware on every non-localhost request.
_Avoid_: auth cookie, JWT, access token

**Login Page**:
An independent `/login` route that displays a password input form and the Passkey file path hint (`~/.pi/pi-web/passkey`). Shown to LAN clients that lack a valid **Session Token** cookie. API requests without a valid token receive `401` instead of redirect.
_Avoid_: auth screen, sign-in page

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
- A **Channel** is a per-platform IM integration; each Channel has one **Bot** singleton
- **BaseBot** provides shared command parsing and session/bubble interaction; concrete Bots implement the transport layer
- Multiple **Channels** can run simultaneously, sharing the same global session/bubble registries
- Each **Channel** has its own config file (`~/.pi/agent/<channel>-config.json`) and API route (`/api/<channel>/`)
- A **Bot** receives messages, parses commands (`/s`, `/b`, `#target`), resolves targets, and forwards to sessions/bubbles
- Bot reply flow: send "processing..." ack → subscribe to agent events → wait for `agent_end` → extract and send final reply
- A **CronTask** is bound to one session or bubble Gateway; its prompt is sent as if a user typed `#target msg`
- **CronTask** replies are only recorded in the session file; no IM push notification
- Multiple **CronTasks** can be attached to the same session/bubble; execution is serial (queued per session)
- **CronTasks** are persisted in `~/.pi/agent/pi-web-crontab/`; one JSON file per task
- **CronScheduler** is a global singleton that loads tasks at startup and triggers them via cron timers
- Deleting a session or bubble automatically deletes all associated **CronTasks**
- **CronTask** management via IM: `#target /c add "cron-expr" prompt`, `#target /c list`, `#target /c del #N`
- **CronTask** management via UI: Crontab tab on the session conversation page (next to System tab)
- A **Passkey** is either user-configured (`PI_WEB_PASSWORD`) or auto-generated (32-char hex) on startup; stored in `~/.pi/pi-web/passkey`
- **Session Token** is an HMAC-signed HttpOnly cookie; Passkey change or server restart invalidates all tokens
- Localhost requests bypass authentication; LAN clients without a valid **Session Token** are redirected to the **Login Page**
- The **Login Page** displays a password form and the Passkey file path hint for LAN users

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
