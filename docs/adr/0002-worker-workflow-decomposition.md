# Decompose monolithic Templates into independent Workers + Workflows

The original Bubble architecture bundled gateway config, worker definitions, and orchestration into monolithic JSON Templates. We decompose this into two independent entities: **Workers** (reusable, generic agent definitions stored in `~/.pi/agent/workers/`) and **Workflows** (declarative directed graphs that reference Workers by name, stored in `~/.pi/agent/workflows/`). The Workflow graph is compiled into the Gateway's system prompt at bubble creation time — there is no separate execution engine; the Gateway LLM follows the compiled prompt to call invoke tools. Old Templates are auto-migrated on first load.

## Status: accepted

## Considered Options

### 1. Separate Workers + Workflows with prompt-compiled execution (chosen)

Workers are standalone, generic agent definitions (systemPrompt, tools, timeout, model, env). Workflows are directed graphs (steps with onSuccess/onFailure edges) that reference workers by name. At bubble creation, a deterministic TypeScript function `compileWorkflowToPrompt()` converts the graph into a natural language Gateway system prompt. The Gateway LLM executes this prompt, calling `invoke_{worker}` tools in the specified order. Determinism comes from strong prompt constraints, not a code state machine.

**Why**: Workers become truly reusable across workflows. The graph provides a user-editable structural representation while the prompt compilation handles the LLM-native execution. No separate graph execution engine needed — reuses the existing LLM-driven orchestration with stronger constraints.

### 2. Separate Workers + Workflows with code execution engine

Same decomposition, but a TypeScript state machine engine walks the graph, decides which worker to call next, handles fan-out parallelism and fan-in convergence. The Gateway is only invoked for context synthesis, not routing.

**Why rejected**: Adds significant implementation complexity (parallel scheduler, convergence wait, cycle detection in code) for behavior that an LLM with a well-structured prompt handles naturally. The current LLM-driven orchestration already works; adding a code engine duplicates the routing logic in two places.

### 3. Keep monolithic Templates with editing support

Keep the current Template format but add CRUD UI for editing them. No decomposition.

**Why rejected**: Workers are definitionally coupled to templates — the same "code analyzer" prompt is copy-pasted across multiple templates. Editing a worker definition requires finding and updating every template that uses it. The monolith doesn't support the reuse and sharing requirements.

## Key Design Decisions

### Gateway prompt = user prefix + auto-generated flow description

`compileWorkflowToPrompt()` produces: `{user's gatewayPrompt}\n\n---\n\n## Execution Flow\n{auto-generated step-by-step instructions}`. The user controls high-level goals; the code controls flow details. Consistency is guaranteed by the deterministic compilation function.

### Prompt-constrained determinism, not code-enforced

The graph is not executed by a code engine. It's compiled into natural language that the Gateway LLM follows. This means:
- **Loop protection**: `maxIterations` is written into the prompt as an instruction, not enforced by code. The LLM is expected to self-enforce.
- **Fan-in merge**: The LLM naturally synthesizes multiple predecessor results at convergence points — no separate merge logic needed.
- **submit_result**: Kept as a safety valve tool. If the LLM detects an unrecoverable situation, it can call submit_result to force-end the bubble.

### Worker prompt composition

Each step's effective system prompt = `worker.systemPrompt + "\n\n" + step.prompt`. Workers are generic; steps add workflow-specific context as a suffix.

### Invoke tools registered per Worker name

One `invoke_{workerName}` tool per unique Worker, regardless of how many steps reference it. Multiple steps using the same Worker call the same tool with different context arguments.

### Export as self-contained bundle

Export bundles the Workflow + all referenced Workers into a single `*.pi-workflow.json`. Import extracts Workers to their directory, prompting the user for conflict resolution (skip/overwrite/rename) on each duplicate.

### Auto-migration of legacy Templates

On first load, old `~/.pi/agent/templates/*.json` files are converted: each role becomes a Worker, the template becomes a Workflow with a linear chain (roles in declaration order). Users can then edit the graph to add branching.

### Edge semantics

- Each step has optional `onSuccess` and `onFailure` edge arrays (step ID arrays for fan-out).
- Missing edge = implicit terminal with the corresponding status.
- Terminal steps declare explicit `terminalStatus: "success" | "failed"`.
- Graph topology supports: linear chain, fan-out (parallel), fan-in (AND convergence), and cycles (bounded by maxIterations).

### Bubble creation UI

Single dialog with navigation to secondary pages: main page (select Workflow + fill env + select hosts), Worker management sub-page, Workflow management sub-page. Graph editor starts as list+form, visual canvas editor deferred to a later iteration.

## Consequences

- **Prompt quality is still critical** — the compiled prompt must be clear enough for the LLM to follow deterministically. Poor compilation = LLM deviation from the graph.
- **Migration is one-way** — once templates are decomposed, the old format is no longer written. The migration function must be robust.
- **Worker naming becomes a coordination point** — Workers are shared by name. Two teams creating "code_analyzer" workers with different prompts will conflict on import. A namespace or tagging system may be needed later.
- **Graph complexity ceiling** — very complex graphs (20+ steps, deep nesting) may produce prompts that the LLM can't follow reliably. The practical limit depends on LLM capability and will need empirical tuning.
- **Export bundle size** — large workflows with many workers produce large JSON bundles. Acceptable for file-based sharing but could be an issue if shared via other channels.
