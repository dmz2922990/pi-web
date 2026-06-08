import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startRpcSession, getRpcSession } from "./rpc-manager";
import type { AgentSessionWrapper } from "./rpc-manager";
import { listAllSessions, resolveSessionPath } from "./session-reader";
import { listBubbles, getBubble } from "./bubble-store";
import type { Bubble } from "./bubble-types";

// ============================================================================
// Shared types
// ============================================================================

export interface ResolvedTarget {
	type: "session" | "bubble";
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	bubbleId?: string;
	name: string;
}

export type ParsedCommand =
	| { type: "help" }
	| { type: "session_list" }
	| { type: "session_info"; target: string }
	| { type: "bubble_list" }
	| { type: "bubble_info"; target: string }
	| { type: "message"; target: string; text: string }
	| { type: "unknown"; text: string };

// ============================================================================
// Shared constants
// ============================================================================

export const HELP_TEXT = `pi-web Bot Commands:

/s list - List sessions (sorted by time)
/s info #1 - Session details
/b list - List bubbles
#1 hello - Send to #1 session/bubble
#abc1 hello - Send by ID prefix
/help - Show this help

Tip: #number is stable (sorted by creation time).`;

export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_REPLY_LENGTH = 30000;

// ============================================================================
// BaseBot abstract class
// ============================================================================

export abstract class BaseBot<TStatus> {
	protected listCache = new Map<
		string,
		{
			sessions?: { id: string; name: string | null; firstMessage: string; messageCount: number }[];
			bubbles?: Bubble[];
		}
	>();

	// ---- Abstract: lifecycle ----

	abstract start(): Promise<void>;
	abstract stop(): Promise<void>;
	abstract isRunning(): boolean;
	abstract getStatus(): TStatus;

	// ---- Abstract: sending ----

	abstract sendAck(chatId: string, targetName: string): Promise<void>;
	abstract sendText(chatId: string, text: string): Promise<void>;
	abstract sendReply(chatId: string, markdown: string): Promise<void>;
	abstract sendError(chatId: string, error: string): Promise<void>;

	// ---- Abstract: config access ----

	protected abstract get agentTimeoutMs(): number;

	// ---- Concrete: message dispatch ----

	protected async processMessage(chatId: string, text: string): Promise<void> {
		const command = this.parseCommand(text);

		switch (command.type) {
			case "help":
				await this.sendReply(chatId, HELP_TEXT);
				break;
			case "session_list":
				await this.executeSessionList(chatId);
				break;
			case "session_info":
				await this.executeSessionInfo(chatId, command.target);
				break;
			case "bubble_list":
				await this.executeBubbleList(chatId);
				break;
			case "bubble_info":
				await this.executeBubbleInfo(chatId, command.target);
				break;
			case "message":
				await this.executeTargetedMessage(chatId, command.target, command.text);
				break;
			case "unknown":
				await this.sendError(chatId, "Unknown command. Type /help for available commands.");
				break;
		}
	}

	// ---- Concrete: command parsing ----

	protected parseCommand(text: string): ParsedCommand {
		const t = text.trim();

		if (t === "/help" || t === "/h") return { type: "help" };
		if (/^\/(?:session|s)\s+list$/i.test(t)) return { type: "session_list" };

		const sessionInfoMatch = t.match(/^\/(?:session|s)\s+info\s+(.+)$/i);
		if (sessionInfoMatch) return { type: "session_info", target: sessionInfoMatch[1].trim() };

		if (/^\/(?:bubble|b)\s+list$/i.test(t)) return { type: "bubble_list" };

		const bubbleInfoMatch = t.match(/^\/(?:bubble|b)\s+info\s+(.+)$/i);
		if (bubbleInfoMatch) return { type: "bubble_info", target: bubbleInfoMatch[1].trim() };

		// #target message - target can be #1, name, or ID prefix
		const targetMatch = t.match(/^#(\S+)(?:\s+([\s\S]+))?$/);
		if (targetMatch) {
			const targetNum = parseInt(targetMatch[1], 10);
			const target = isNaN(targetNum) ? targetMatch[1] : `#${targetNum}`;
			const msg = targetMatch[2]?.trim();
			if (!msg) return { type: "unknown", text: "Usage: #target <message>" };
			return { type: "message", target, text: msg };
		}

		return { type: "unknown", text: t };
	}

	// ---- Concrete: target resolution ----

	protected async resolveTarget(target: string, chatId: string): Promise<ResolvedTarget | null> {
		// 1. Try #number index from cached list
		if (target.startsWith("#")) {
			const index = parseInt(target.slice(1), 10) - 1;
			if (index >= 0) {
				let cached = this.listCache.get(chatId);
				if (!cached?.sessions?.length && !cached?.bubbles?.length) {
					await this.executeSessionList(chatId);
					cached = this.listCache.get(chatId);
				}
				if (cached?.sessions && index < cached.sessions.length) {
					const s = cached.sessions[index];
					const sessionFile = await resolveSessionPath(s.id);
					return {
						type: "session",
						sessionId: s.id,
						sessionFile: sessionFile ?? undefined,
						cwd: this.extractCwdFromPath(sessionFile),
						name: s.name ?? s.id.slice(0, 8),
					};
				}
				if (cached?.bubbles && index < cached.bubbles.length) {
					const b = cached.bubbles[index];
					return {
						type: "bubble",
						sessionId: b.gatewaySessionId,
						sessionFile: b.gatewaySessionFile,
						cwd: b.cwd,
						bubbleId: b.id,
						name: b.name,
					};
				}
			}
		}

		// 2. Search sessions by ID prefix or name
		const sessions = await listAllSessions();
		const lowerTarget = target.toLowerCase();
		const sessionMatch = sessions.find(
			(s) =>
				s.id.startsWith(target) ||
				(s.name && s.name.toLowerCase() === lowerTarget),
		) ?? sessions.find(
			(s) => s.name && s.name.toLowerCase().includes(lowerTarget),
		);
		if (sessionMatch) {
			const sessionFile = await resolveSessionPath(sessionMatch.id);
			return {
				type: "session",
				sessionId: sessionMatch.id,
				sessionFile: sessionFile ?? undefined,
				cwd: this.extractCwdFromPath(sessionFile) ?? sessionMatch.cwd,
				name: sessionMatch.name ?? sessionMatch.id.slice(0, 8),
			};
		}

		// 3. Search bubbles
		const bubbles = listBubbles().filter((b) => b.status === "running");
		const bubbleMatch = bubbles.find(
			(b) =>
				b.id.startsWith(target) ||
				b.gatewaySessionId.startsWith(target) ||
				b.name.toLowerCase() === lowerTarget,
		) ?? bubbles.find(
			(b) => b.name.toLowerCase().includes(lowerTarget),
		);
		if (bubbleMatch) {
			return {
				type: "bubble",
				sessionId: bubbleMatch.gatewaySessionId,
				sessionFile: bubbleMatch.gatewaySessionFile,
				cwd: bubbleMatch.cwd,
				bubbleId: bubbleMatch.id,
				name: bubbleMatch.name,
			};
		}

		return null;
	}

	protected extractCwdFromPath(sessionFile: string | null): string {
		if (!sessionFile) return process.cwd();
		try {
			const sm = SessionManager.open(sessionFile);
			const header = sm.getHeader();
			return header?.cwd ?? process.cwd();
		} catch {
			return process.cwd();
		}
	}

	// ---- Concrete: command execution ----

	protected getbubbleSessionIds(): Set<string> {
		const ids = new Set<string>();
		for (const b of listBubbles()) {
			if (b.gatewaySessionId) ids.add(b.gatewaySessionId);
			for (const w of b.workers) {
				if (w.sessionId) ids.add(w.sessionId);
			}
		}
		return ids;
	}

	protected async executeSessionList(chatId: string): Promise<void> {
		const sessions = await listAllSessions();
		const bubbleSessionIds = this.getbubbleSessionIds();
		const filtered = sessions
			.filter((s) => !bubbleSessionIds.has(s.id))
			.sort((a, b) => {
				// Sort by creation time descending for stable numbering
				const ta = a.created ?? "";
				const tb = b.created ?? "";
				return tb.localeCompare(ta);
			});
		const simplified = filtered.map((s) => ({
			id: s.id,
			name: s.name ?? null,
			firstMessage: s.firstMessage,
			messageCount: s.messageCount,
		}));

		this.listCache.set(chatId, { sessions: simplified });

		if (simplified.length === 0) {
			await this.sendText(chatId, "No sessions found.");
			return;
		}

		const lines = simplified.slice(0, 20).map((s, i) => {
			const label = s.name || s.firstMessage.slice(0, 30);
			const id8 = s.id.slice(0, 8);
			return `${i + 1}. ${label} [#${id8}] (${s.messageCount} msgs)`;
		});
		await this.sendText(chatId, "Sessions:\n" + lines.join("\n"));
		if (simplified.length > 20) {
			await this.sendText(chatId, `...and ${simplified.length - 20} more`);
		}
	}

	protected async executeSessionInfo(chatId: string, target: string): Promise<void> {
		const resolved = await this.resolveTarget(target, chatId);
		if (!resolved || resolved.type !== "session") {
			await this.sendError(chatId, `Session not found: ${target}`);
			return;
		}

		const sessions = await listAllSessions();
		const info = sessions.find((s) => s.id === resolved.sessionId);
		if (!info) {
			await this.sendError(chatId, `Session not found: ${target}`);
			return;
		}

		const lines = [
			`**Session:** ${info.name ?? info.id.slice(0, 8)}`,
			`**ID:** ${info.id}`,
			`**CWD:** ${info.cwd}`,
			`**Messages:** ${info.messageCount}`,
			`**Created:** ${info.created}`,
			`**First message:** ${this.escapeMarkdown(info.firstMessage.slice(0, 100))}`,
		];
		await this.sendReply(chatId, lines.join("\n"));
	}

	protected async executeBubbleList(chatId: string): Promise<void> {
		const bubbles = listBubbles();

		this.listCache.set(chatId, { bubbles });

		if (bubbles.length === 0) {
			await this.sendText(chatId, "No running bubbles.");
			return;
		}

		const lines = bubbles.slice(0, 20).map((b, i) =>
			`${i + 1}. ${b.name} [#${b.id.slice(0, 8)}] (${b.workers.length} workers)`
		);
		await this.sendText(chatId, "Running Bubbles:\n" + lines.join("\n"));
	}

	protected async executeBubbleInfo(chatId: string, target: string): Promise<void> {
		const resolved = await this.resolveTarget(target, chatId);
		if (!resolved || resolved.type !== "bubble") {
			await this.sendError(chatId, `Bubble not found: ${target}`);
			return;
		}

		const bubble = getBubble(resolved.bubbleId!);
		if (!bubble) {
			await this.sendError(chatId, `Bubble not found: ${target}`);
			return;
		}

		const lines = [
			`**Bubble:** ${bubble.name}`,
			`**ID:** ${bubble.id}`,
			`**Status:** ${bubble.status}`,
			`**CWD:** ${bubble.cwd}`,
			`**Workers:** ${bubble.workers.map((w) => w.roleName).join(", ")}`,
			`**Created:** ${bubble.createdAt}`,
		];
		await this.sendReply(chatId, lines.join("\n"));
	}

	// ---- Concrete: send message to session/bubble and wait for reply ----

	protected async executeTargetedMessage(chatId: string, target: string, message: string): Promise<void> {
		const resolved = await this.resolveTarget(target, chatId);
		if (!resolved) {
			await this.sendError(chatId, `Target not found: ${target}`);
			return;
		}

		// Get or create session wrapper
		let wrapper: AgentSessionWrapper;
		try {
			wrapper = await this.getOrCreateWrapper(resolved);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await this.sendError(chatId, `Failed to start session: ${msg}`);
			return;
		}

		if (!wrapper.isAlive()) {
			await this.sendError(chatId, `Session not alive: ${resolved.name}`);
			return;
		}

		// Send ack
		await this.sendAck(chatId, resolved.name);

		// Wait for agent_end with timeout
		// Snapshot current entry count so we only extract new replies
		const entryCountBefore = this.getEntryCount(wrapper);

		const timeoutMs = this.agentTimeoutMs;

		await new Promise<void>((resolve) => {
			let settled = false;

			const timer = setTimeout(async () => {
				if (!settled) {
					settled = true;
					unsubscribe();
					await this.sendError(
						chatId,
						`Agent timed out after ${timeoutMs / 1000}s for ${resolved.name}`,
					);
					resolve();
				}
			}, timeoutMs);

			const unsubscribe = wrapper.onEvent(async (event: Record<string, unknown>) => {
				if (event.type === "agent_end" && !settled) {
					settled = true;
					clearTimeout(timer);
					unsubscribe();

					const reply = this.extractLastAssistantReply(wrapper, entryCountBefore);
					const header = `**[${resolved.name}]**\n`;
					if (reply) {
						await this.sendReply(chatId, header + reply);
					} else {
						await this.sendReply(chatId, header + "_(Agent completed with no text output)_");
					}
					resolve();
				}

				if (event.type === "error" && !settled) {
					settled = true;
					clearTimeout(timer);
					unsubscribe();
					const errMsg = (event.error as string) || (event.message as string) || "Unknown error";
					await this.sendError(chatId, `Agent error: ${errMsg}`);
					resolve();
				}
			});

			wrapper.send({ type: "prompt", message }).catch((err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					unsubscribe();
					const msg = err instanceof Error ? err.message : String(err);
					this.sendError(chatId, `Failed to send prompt: ${msg}`).then(resolve);
				}
			});
		});
	}

	protected async getOrCreateWrapper(resolved: ResolvedTarget): Promise<AgentSessionWrapper> {
		// Check if already in memory
		const existing = getRpcSession(resolved.sessionId);
		if (existing?.isAlive()) return existing;

		if (resolved.type === "bubble") {
			// For bubbles, the BubbleManager should have already created the gateway wrapper.
			// Import getBubbleManager dynamically to avoid circular deps at module level.
			const { getBubbleManager } = await import("./bubble-manager");
			const manager = getBubbleManager(resolved.bubbleId!);
			const gw = manager?.getGatewayWrapper();
			if (gw?.isAlive()) return gw;
			throw new Error(`Bubble gateway not running: ${resolved.name}`);
		}

		// Start a regular session
		const sessionFile = resolved.sessionFile ?? (await resolveSessionPath(resolved.sessionId));
		if (!sessionFile) throw new Error(`Session file not found: ${resolved.name}`);
		const result = await startRpcSession(resolved.sessionId, sessionFile, resolved.cwd);
		return result.session;
	}

	// ---- Concrete: reply extraction ----

	protected getEntryCount(wrapper: AgentSessionWrapper): number {
		const sessionFile = wrapper.sessionFile;
		if (!sessionFile) return 0;
		try {
			const sm = SessionManager.open(sessionFile);
			return sm.getEntries()?.length ?? 0;
		} catch {
			return 0;
		}
	}

	protected extractLastAssistantReply(wrapper: AgentSessionWrapper, afterIndex: number = 0): string | null {
		const sessionFile = wrapper.sessionFile;
		if (!sessionFile) return null;

		try {
			const sm = SessionManager.open(sessionFile);
			const entries = sm.getEntries();
			if (!entries || entries.length === 0) return null;

			// Only look at entries added after the prompt was sent
			for (let i = entries.length - 1; i >= afterIndex; i--) {
				const entry = entries[i] as unknown as Record<string, unknown>;
				if (entry.type === "message") {
					const message = entry.message as Record<string, unknown>;
					if (message?.role === "assistant") {
						const content = message.content as Array<Record<string, unknown>>;
						// 1. Look for text content
						const textParts = content
							?.filter((c) => c.type === "text")
							.map((c) => c.text as string)
							.filter(Boolean);
						if (textParts?.length) return textParts.join("\n");
						// 2. Look for submit_result tool call (bubble gateway completion)
						const toolCalls = content?.filter(
							(c) => c.type === "toolCall" && (c.name === "submit_result" || c.toolName === "submit_result"),
						);
						if (toolCalls?.length) {
							const tc = toolCalls[0];
							const args = tc.arguments || tc.input;
							if (typeof args === "string") {
								try {
									const parsed = JSON.parse(args as string);
									if (parsed.summary) return parsed.summary;
								} catch { /* ignore */ }
							} else if (args && typeof args === "object") {
								const a = args as Record<string, unknown>;
								if (a.summary) return a.summary as string;
							}
						}
						// 3. Look for any invoke_ tool call result text
						const invokeCalls = content?.filter(
							(c) => c.type === "toolCall" && ((c.name as string)?.startsWith("invoke_") || (c.toolName as string)?.startsWith("invoke_")),
						);
						if (invokeCalls?.length) {
							const tc = invokeCalls[invokeCalls.length - 1];
							const args = tc.arguments || tc.input;
							if (typeof args === "string") {
								try {
									const parsed = JSON.parse(args as string);
									if (parsed.task) return `Invoking worker: ${parsed.task}`;
								} catch { /* ignore */ }
							}
						}
					}
				}
			}
		} catch {
			/* fall through */
		}
		return null;
	}

	// ---- Concrete: utilities ----

	protected escapeMarkdown(text: string): string {
		return text.replace(/([*_`\[\]#])/g, "\\$1");
	}
}
