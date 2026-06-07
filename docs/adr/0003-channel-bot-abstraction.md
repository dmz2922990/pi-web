# Channel Bot Abstraction with BaseBot

We chose to extract a `BaseBot` abstract base class from the existing `FeishuBot` to share command parsing, target resolution, session/bubble interaction, and reply extraction logic across all IM channel integrations. Each concrete Bot (FeishuBot, WecomBot) extends BaseBot and implements only the transport-specific layer. This decision was driven by the need to add WeCom support while keeping the command set and interaction model identical across channels.

## Status: accepted

## Considered Options

### 1. BaseBot abstract base class with shared logic (chosen)

Extract command parsing (`/s`, `/b`, `#target`), target resolution, session/bubble forwarding, and reply extraction into `BaseBot`. Concrete subclasses implement: event receiving (file polling vs WebSocket), message sending (lark-cli subprocess vs WS command), config loading, and connection lifecycle. Each Bot is a global singleton (`globalThis.__piFeishuBot`, `globalThis.__piWecomBot`).

**Why**: The command set and session/bubble interaction logic are identical across all channels — only the transport differs. Without a shared base, adding a third channel (e.g., DingTalk) would require copying ~400 lines of identical logic. BaseBot ensures a command change is made once and applies everywhere.

### 2. Independent Bot implementations (copy-paste)

Each Bot (`feishu-bot.ts`, `wecom-bot.ts`) is fully self-contained with its own command parsing and session interaction logic. No shared base class.

**Why rejected**: Violates DRY. The command parsing, target resolution, and reply extraction are definitionally identical across channels — they operate on the same pi-web session/bubble APIs. Copying this logic means any bug fix or feature addition (e.g., adding a new command) must be applied to every Bot file independently.

### 3. Shared utility functions (no inheritance)

Instead of a base class, extract shared logic into standalone utility functions (e.g., `parseCommand()`, `resolveTarget()`, `extractReply()`). Each Bot imports and calls these functions.

**Why rejected**: The shared logic is not just utility functions — it involves shared state (the "processing..." ack, event subscription, timeout handling) and a shared workflow (receive → parse → resolve → forward → wait → reply). A base class naturally models this as a template method pattern, ensuring the workflow order is enforced. Utility functions leave the orchestration to each caller, reintroducing the consistency risk.

## Key Design Decisions

### Template method pattern for message handling

BaseBot defines the message handling workflow: `handleMessage()` → `parseCommand()` → `executeCommand()` → `resolveTarget()` → `forwardToSession()` → `waitForReply()`. Subclasses override only `sendAck()` and `sendReply()` (transport-specific sending) plus `start()` / `stop()` (lifecycle).

### Separate config files per channel

Each channel has its own config file (`~/.pi/agent/<channel>-config.json`) with channel-specific fields. Feishu needs `larkCliPath` and `pollIntervalMs`; WeCom needs `botId` and `secret`. A shared config would mix unrelated fields and make validation harder.

### Separate API routes per channel

Each channel has its own `/api/<channel>/` route for status and start/stop/restart control. Status responses differ (Feishu returns `larkCliPid`, WeCom returns `wsConnected`). A unified route would require constant conditional branching.

### Simultaneous multi-channel operation

Multiple Bots can run at the same time, sharing the global session (`__piSessions`) and bubble (`__piBubbleManagers`) registries. No channel exclusivity — a user can interact with the same session from both Feishu and WeCom.

### Non-streaming reply model

Both Feishu and WeCom Bots wait for `agent_end` before sending the complete reply. WeCom supports streaming via WebSocket, but we defer this to keep the interaction model consistent and the implementation simple. Streaming can be added later as a WeCom-specific enhancement without affecting BaseBot.

## Consequences

- **BaseBot is a coupling point** — any change to BaseBot affects all Bot implementations. The interface must be stable before extraction. If the abstraction is wrong, refactoring it is costly.
- **Transport differences may leak** — Feishu uses file polling (inherent latency from `pollIntervalMs`), WeCom uses WebSocket (near-instant). The UI should not assume a specific latency model.
- **WeCom WebSocket requires heartbeat** — the connection must send a ping every 30 seconds. Disconnection handling (auto-reconnect) is WeCom-specific and lives in WecomBot, not BaseBot.
- **Future channels are cheap to add** — DingTalk would be a new Bot subclass implementing the DingTalk transport, with zero changes to command parsing or session interaction.
- **Testing surface is concentrated** — BaseBot's command parsing and target resolution should be well-tested because all channels depend on them.
