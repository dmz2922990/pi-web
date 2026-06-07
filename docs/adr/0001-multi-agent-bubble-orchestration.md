# Multi-Agent Bubble Orchestration

We chose to implement multi-agent coordination as a "Work Bubble" — a container where a Gateway LLM agent orchestrates specialized Worker LLM agents, each registered as a custom tool on the gateway. Workers are independent `AgentSession` instances with constrained tool sets, pooled and reusable within the bubble lifecycle. Communication flows through the gateway (which relays context between workers) and a shared working directory.

## Status: accepted

## Considered Options

### 1. Gateway as LLM agent with workflow prompt (chosen)

The gateway is a real `AgentSession` whose system prompt encodes the orchestration workflow. Workers are registered as `defineTool()` custom tools. The gateway's LLM decides execution order, handles loops (e.g. review → re-modify), and calls `submit_result` to signal completion.

**Why**: The pi-coding-agent SDK natively supports `customTools` on `createAgentSession()`, making this a natural extension of existing infrastructure. LLM-driven orchestration handles the unpredictable loops and conditional branching that rule-based systems struggle with.

### 2. Gateway as deterministic code

Pure TypeScript orchestration logic — no LLM in the gateway role. Rules determine which worker to call next based on previous results.

**Why rejected**: Cannot handle the open-ended looping the user described (review fails → re-modify → re-review). Each workflow would need hardcoded state machines that are brittle when steps produce unexpected results. The whole point is that the gateway adapts.

### 3. External orchestration service

A separate process (not in the Next.js server) that manages agent sessions remotely.

**Why rejected**: Adds operational complexity for no benefit in this context. The pi-coding-agent SDK runs in-process; adding a separate orchestration layer creates unnecessary network hops and state synchronization problems.

## Key Design Decisions

### Workers as custom tools on Gateway

Each worker role becomes an `invoke_{role_name}` tool registered via `defineTool()`. The tool's `execute` function calls `workerSession.prompt(task)`, blocks until the worker completes, then returns a structured result. This leverages the SDK's native custom tool support and means the gateway behaves like a normal agent that happens to have specialized tools.

### Synchronous blocking execution

When the gateway calls a worker tool, `execute` blocks until the worker finishes. This matches the standard tool call semantics — the LLM calls a tool, waits, gets the result, then reasons about what to do next. Worker streaming events still flow to the frontend via SSE independently.

### Hybrid workflow model

Templates define available roles and their constraints, but the gateway LLM decides runtime execution order, loops, and skips. This gives structure (you can't invoke a role that isn't in the template) while preserving flexibility (the gateway can retry, reorder, or skip steps based on results).

### Gateway relays + shared cwd for context passing

Workers don't communicate directly. The gateway extracts key information from one worker's output and injects it into the next worker's task description. All workers operate on the same working directory, so file-level changes are naturally visible across workers.

### Tool execute post-processing for structured output

Workers produce natural language. The tool's `execute` function post-processes the worker's final message into `{ status, summary, files? }`. This avoids the unreliability of forcing LLMs to output structured JSON while still giving the gateway machine-readable results.

### Bubble as aggregation layer

A bubble is not itself a session — it's a container (`bubble.json`) that tracks which sessions belong to it. Gateway and workers each have their own `.jsonl` files. This keeps the bubble metadata independent from session compaction and doesn't require changes to `session-reader`.

### N independent SSE connections

Each agent (gateway + workers) has its own SSE endpoint (`/api/agent/[id]/events`). The frontend maintains one EventSource per visible agent. This completely reuses the existing SSE infrastructure with zero modification.

### Coexistence with normal sessions

Bubbles appear alongside normal sessions in the sidebar. Normal sessions are unaffected — bubble creation is an additional entry point, not a replacement.

### Per-role timeout with auto-run

Each worker role can define a `timeoutMinutes` in the template (default 10 min). All workers run in auto-run mode (no human confirmation for tool calls). On timeout, the tool execute returns `{ status: "failed" }` and the gateway decides how to proceed.

### Environment config: template declares, user fills

Templates declaratively list required environment variables (source path, build command, etc.) with types and defaults. Users fill concrete values at bubble creation time. Values are injected into worker system prompts at session creation.

## Template Data Model

```typescript
interface BubbleTemplate {
  name: string;
  description: string;
  gateway: {
    systemPrompt: string;
    model?: { provider: string; modelId: string };
  };
  roles: Array<{
    name: string;              // kebab-case, used in tool name: invoke_{name}
    label: string;             // display name
    systemPrompt: string;
    tools: string[];           // subset of ["read","bash","edit","write","grep","find","ls"]
    model?: { provider: string; modelId: string };
    timeoutMinutes?: number;   // default 10
  }>;
  environment?: Array<{
    key: string;
    label: string;
    type: "path" | "string";
    default?: string;
  }>;
}
```

## Bubble Data Model

```typescript
interface Bubble {
  id: string;
  templateName: string;
  cwd: string;
  status: "running" | "completed" | "failed";
  gatewaySessionId: string;
  workers: Array<{
    roleName: string;
    sessionId: string;
  }>;
  environment: Record<string, string>;
  createdAt: string;
  completedAt?: string;
  result?: {
    status: "success" | "failed";
    summary: string;
  };
}
```

## Consequences

- **Template quality is critical** — poorly written gateway system prompts will produce bad orchestration. The system is only as good as the prompt engineering.
- **Custom tool support is required** — this design depends on `createAgentSession({ customTools })` working correctly in the pi-coding-agent SDK. It does today, but it's a coupling point.
- **Token cost scales with workers** — each worker is a full LLM session. A 4-worker bubble uses ~5x the tokens of a single session (gateway + 4 workers).
- **No cross-bubble sharing** — workers are scoped to a single bubble. If two bubbles need the same "code analyzer", they each get their own instance.
