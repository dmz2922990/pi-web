# Crontab Scheduled Prompts for Sessions and Bubbles

We chose to add a built-in cron scheduler to pi-web that allows users to attach recurring, scheduled prompts to any session or bubble Gateway. CronTasks are persisted to disk, survive server restarts, and execute automatically using the same prompt code path as interactive messages (`#target msg`). Replies are recorded only in the session — no IM push.

## Status: accepted

## Considered Options

### 1. In-process CronScheduler with per-session serial queues (chosen)

A `CronScheduler` singleton (globalThis) loads all tasks from `~/.pi/agent/pi-web-crontab/` at startup, maintains in-memory cron timers, and triggers execution. Each task is a JSON file linking a target session/bubble ID, a cron expression, and a prompt string. Execution uses `getOrCreateWrapper` + `send({ type: "prompt" })` — the same code path as Bot messages. Per-session serial queues prevent concurrent prompts to the same session. Managed via IM commands (`#target /c add/list/del`) and a Crontab UI tab on the session conversation page.

**Why**: Reuses existing session interaction infrastructure. No external dependencies (system crontab, separate process). Per-session serialization avoids Agent concurrency issues. Disk persistence makes tasks survive restarts.

### 2. System crontab + HTTP API triggers

Generate system crontab entries that call `POST /api/agent/[id]` at scheduled times.

**Why rejected**: Cross-platform issues (Windows has no crontab). Requires managing external state outside pi-web's control. HTTP calls add latency and lack serial queue guarantees. Harder to manage (create/delete) from IM commands.

### 3. External scheduler service (e.g., Bull/BullMQ with Redis)

A separate job queue that schedules and executes prompts. More robust for distributed deployments.

**Why rejected**: pi-web is a single-process app with no Redis dependency. Adding a job queue is disproportionate to the use case. The in-process approach is simpler and sufficient.

## Key Design Decisions

### Replies are session-only, no IM push

CronTask replies are written to the session file only. Users discover results by checking the session in pi-web or querying via IM (`#target /c list`). This avoids: spamming IM channels with automated results, needing per-task notification channel configuration, and the complexity of tracking which IM chats should receive which notifications.

### Target locked via `#target` prefix

IM commands use `#target /c <action>` format, consistent with `#target msg`. The target is resolved using the same `resolveTarget` logic from BaseBot. Users don't need to learn a new addressing scheme.

### Per-session serial execution queue

Each session has an execution queue. If a CronTask triggers while a previous task (or user message) is still running on the same session, the new task waits. This prevents: concurrent prompt conflicts in the session file, Agent confusion from interleaved responses, and race conditions in reply extraction.

### Auto-cleanup on session/bubble deletion

When a session or bubble is deleted, all associated CronTasks are automatically removed from disk and the scheduler. This prevents orphan tasks that would fail on every trigger.

### Cold-start on trigger

If a target session is not in memory (server was restarted), the scheduler calls `startRpcSession` to cold-start it before sending the prompt. This matches the Bot behavior and ensures tasks work without manual session restoration.

### Task persistence format

Each CronTask is a single JSON file in `~/.pi/agent/pi-web-crontab/`:
```json
{
  "id": "uuid",
  "targetId": "session-or-bubble-id",
  "targetType": "session" | "bubble",
  "cron": "0 9 * * *",
  "prompt": "Check for new PRs and summarize",
  "createdAt": "ISO timestamp",
  "lastRunAt": "ISO timestamp | null",
  "lastStatus": "success" | "error" | "timeout" | null
}
```

## Consequences

- **CronTasks survive server restarts** — loaded from disk at startup by CronScheduler
- **Hot-reload safety** — CronScheduler stored in globalThis, survives Next.js HMR
- **Clock drift tolerance** — tasks use in-process timers; server sleep/wake may miss triggers
- **No distributed guarantees** — single-process only; multiple pi-web instances would need external coordination
- **Task count scaling** — large numbers of tasks (100+) may need timer consolidation or lazy scheduling
