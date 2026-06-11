# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

pi-web is a browser-based UI for the [pi coding agent](https://github.com/badlogic/pi-mono). It renders agent sessions, supports real-time chat via SSE, and allows forking conversations and navigating in-session branches. Published as `@agegr/pi-web` on npm.

**Tech stack**: Next.js 16 (App Router) + React 19 + TypeScript (strict) + Tailwind CSS 4. The agent SDK (`@earendil-works/pi-coding-agent`) runs **in-process** inside the Next.js server — there is no separate backend.

## Commands

```bash
npm run dev       # next dev -p 30141
npm run build     # next build --webpack
npm start         # next start -p 30141
npm run lint      # eslint .
npm run release   # bump patch version, build, publish to npm

# Typecheck (no test framework is configured)
node_modules/.bin/tsc --noEmit
```

**Never run `next build` during dev** — it pollutes `.next/` and breaks `npm run dev`.

There are no tests. No test framework, no test files, no test configuration.

## Architecture

### Single-page with URL params

The app is one page (`app/page.tsx` → `<AppShell />`). Navigation uses URL search params (`?session=<id>`), not file-system routing. `AppShell` is the top-level client component that orchestrates all UI via prop drilling — no context providers, no external state management library.

### Real-time data flow

```
Browser                  Next.js Server              AgentSession (in-process)
  |                          |                               |
  |-- GET /api/sessions --->| reads ~/.pi/agent/sessions/   |
  |-- send message -------->| POST /api/agent/[id]          |
  |                          |   startRpcSession() -------->| createAgentSession()
  |                          |   session.send(cmd) -------->| session.prompt()
  |-- SSE connect ---------->| GET /api/agent/[id]/events   |
  |                          |   session.onEvent() <--------| session.subscribe()
  |<-- data: {...} ----------|                               |
```

- **Session browsing** (read-only): reads `.jsonl` files directly via `lib/session-reader.ts` — no AgentSession created.
- **Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

### AgentSession lifecycle (`lib/rpc-manager.ts`)

- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions` (survives hot-reload; plain module-level Map does not).
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise via `globalThis.__piStartLocks`.

### Core state hook

`hooks/useAgentSession.ts` (~650 lines) manages all agent session state: streaming, SSE connection, message history, model selection, tool presets, and compaction. This is the brain of the frontend.

### Styling

- Tailwind CSS 4 with CSS custom properties for theming (light/dark mode) defined in `app/globals.css`
- Heavy use of inline `style={{}}` objects throughout components
- Dark mode toggled by `html.dark` class with View Transitions API animated wipe

## Key Design Decisions & Traps

### Two kinds of branching — don't confuse them
- **Fork** (Fork button): creates a new independent `.jsonl` file. Child in sidebar via `parentSession` header.
- **In-session branch** (Continue button / BranchNavigator): `navigate_tree` within the same file. Switching calls `/api/sessions/[id]/context?leafId=`.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` mutates the wrapper's inner state in-place — after fork, `inner.sessionId` is the new session's id. `send("fork")` captures `newSessionId` then calls `this.destroy()` before returning. Otherwise the registry maps the old id to already-forked state, corrupting subsequent forks.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` checks `state.isStreaming === true` and reconnects SSE automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction event names
Newer pi emits `compaction_start`/`compaction_end`; older versions used `auto_compaction_start`/`auto_compaction_end`. `handleAgentEvent` accepts both sets.

### Session files can be fully rewritten
`parentSession` in the header is display metadata only — safe to `writeFileSync` the entire file. Used when cascade-reparenting children on delete.

## Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

Each line is a JSON object. Key types: `session` (header), `model_change`, `message` (user/assistant/toolResult), `compaction`, `session_info`. Messages form a tree via `parentId` fields. `entryIds[]` in `SessionContext` maps displayed messages back to their `.jsonl` entry id for fork/navigate_tree.

## Path Alias

`@/*` maps to project root (configured in `tsconfig.json`).

## Language

Code comments and commit messages in English. User-facing docs (README) in Chinese.
