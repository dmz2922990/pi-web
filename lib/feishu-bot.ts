import { spawn, type ChildProcess } from "child_process";
import {
	readFileSync,
	readdirSync,
	unlinkSync,
	statSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	existsSync,
	writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startRpcSession, getRpcSession } from "./rpc-manager";
import type { AgentSessionWrapper } from "./rpc-manager";
import { listAllSessions, resolveSessionPath } from "./session-reader";
import { listBubbles, getBubble } from "./bubble-store";
import type { Bubble } from "./bubble-types";

// ============================================================================
// Config
// ============================================================================

export interface FeishuConfig {
	enabled: boolean;
	allowedChats: string[];
	allowedUsers: string[];
	larkCliPath?: string;
	pollIntervalMs?: number;
	agentTimeoutMs?: number;
}

interface FeishuEvent {
	chat_id: string;
	content: string;
	chat_type: "p2p" | "group";
	message_type: string;
	sender_id: string;
	message_id: string;
	event_id: string;
	create_time: string;
}

interface ResolvedTarget {
	type: "session" | "bubble";
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	bubbleId?: string;
	name: string;
}

type ParsedCommand =
	| { type: "help" }
	| { type: "session_list" }
	| { type: "session_info"; target: string }
	| { type: "bubble_list" }
	| { type: "bubble_info"; target: string }
	| { type: "message"; target: string; text: string }
	| { type: "unknown"; text: string };

export interface FeishuBotStatus {
	running: boolean;
	connected: boolean;
	eventsProcessed: number;
	larkCliPid: number | null;
	config: FeishuConfig;
}

// ============================================================================
// Config loading
// ============================================================================

function getConfigPath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "/";
	return join(home, ".pi", "agent", "feishu-config.json");
}

export function loadFeishuConfig(): FeishuConfig | null {
	const path = getConfigPath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as FeishuConfig;
	} catch {
		return null;
	}
}

// ============================================================================
// Lark-cli path resolution
// ============================================================================

function resolveLarkCliPath(hint?: string): string | null {
	if (hint && existsSync(hint)) return hint;
	const home = process.env.HOME || "";
	const nvmPath = join(home, ".nvm/versions/node/v22.13.1/bin/lark-cli");
	if (existsSync(nvmPath)) return nvmPath;
	// Fallback: rely on PATH
	return "lark-cli";
}

// ============================================================================
// Singleton
// ============================================================================

declare global {
	var __piFeishuBot: FeishuBot | undefined;
}

export function getFeishuBot(): FeishuBot | undefined {
	return globalThis.__piFeishuBot;
}

export async function startFeishuBot(): Promise<FeishuBot | null> {
	const existing = getFeishuBot();
	if (existing?.isRunning()) return existing;
	if (existing) await existing.stop();

	const config = loadFeishuConfig();
	if (!config || !config.enabled) return null;

	const larkCliPath = resolveLarkCliPath(config.larkCliPath);
	if (!larkCliPath) {
		console.error("[feishu-bot] lark-cli not found");
		return null;
	}

	const bot = new FeishuBot(config, larkCliPath);
	await bot.start();
	globalThis.__piFeishuBot = bot;
	return bot;
}

export async function stopFeishuBot(): Promise<void> {
	const bot = getFeishuBot();
	if (!bot) return;
	await bot.stop();
	globalThis.__piFeishuBot = undefined;
}

// ============================================================================
// FeishuBot
// ============================================================================

const HELP_TEXT = `pi-web Feishu Bot Commands:

/s list - List sessions (sorted by time)
/s info #1 - Session details
/b list - List bubbles
#1 hello - Send to #1 session/bubble
#abc1 hello - Send by ID prefix
/help - Show this help

Tip: #number is stable (sorted by creation time).`;

const MAX_EVENTS = 10000;
const TRIM_THRESHOLD = 10000;
const TRIM_TO = 5000;
const MAX_REPLY_LENGTH = 30000;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 600_000;
const RESTART_DELAY_MS = 5000;

class FeishuBot {
	private config: FeishuConfig;
	private larkCliPath: string;
	private childProcess: ChildProcess | null = null;
	private eventDir: string;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
		private listCache = new Map<
			string,
			{ sessions?: { id: string; name: string | null; firstMessage: string; messageCount: number }[]; bubbles?: Bubble[] }
		>();
	private processedEvents: Set<string> = new Set();
	private running = false;
	private eventsProcessed = 0;
	private lastFileTimestamp = 0;
	

	constructor(config: FeishuConfig, larkCliPath: string) {
		this.config = config;
		this.larkCliPath = larkCliPath;
		// Create a unique subdir inside ~/.pi/agent/ for events
		// lark-cli --output-dir only accepts relative paths
		const home = process.env.HOME || process.env.USERPROFILE || "/";
		const baseDir = join(home, ".pi", "agent", "feishu-events");
		const dirName = `ev-${Date.now()}`;
		this.eventDir = join(baseDir, dirName);
	}

	isRunning(): boolean {
		return this.running;
	}

	getStatus(): FeishuBotStatus {
		return {
			running: this.running,
			connected: this.childProcess !== null && this.childProcess.exitCode === null,
			eventsProcessed: this.eventsProcessed,
			larkCliPid: this.childProcess?.pid ?? null,
			config: this.config,
		};
	}

	async start(): Promise<void> {
		this.running = true;
		this.startEventConsumer();
		const interval = this.config.pollIntervalMs ?? DEFAULT_POLL_MS;
		this.pollTimer = setInterval(() => this.pollEvents(), interval);
		console.log("[feishu-bot] Started, polling every", interval, "ms");
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.childProcess) {
			this.childProcess.kill("SIGTERM");
			this.childProcess = null;
		}
		try {
			rmSync(this.eventDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		console.log("[feishu-bot] Stopped");
	}

	// --- Event consumer ---

	private startEventConsumer(): void {
		// Ensure event dir exists
		mkdirSync(this.eventDir, { recursive: true });

		// Compute relative path from the dir we'll set as cwd
		const home = process.env.HOME || process.env.USERPROFILE || "/";
		const cwd = join(home, ".pi", "agent");
		const relativeDir = "feishu-events/" + this.eventDir.split("/").pop();

		const args = [
			"event",
			"consume",
			"im.message.receive_v1",
			"--as",
			"bot",
			"--output-dir",
			relativeDir,
			"--quiet",
		];

		this.childProcess = spawn(this.larkCliPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd,
			env: { ...process.env, HOME: process.env.HOME },
		});

		this.childProcess.on("exit", () => {
			if (this.running) {
				console.error("[feishu-bot] lark-cli exited, restarting in", RESTART_DELAY_MS / 1000, "s");
				setTimeout(() => {
					if (this.running) this.startEventConsumer();
				}, RESTART_DELAY_MS);
			}
		});

		this.childProcess.stderr?.on("data", (data) => {
			const msg = data.toString().trim();
			if (msg) console.error("[feishu-bot] lark-cli:", msg);
		});
	}

	// --- Polling ---

	private pollEvents(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventDir).filter((f) => f.endsWith(".json")).sort();
		} catch {
			return;
		}

		for (const file of files) {
			const filePath = join(this.eventDir, file);
			try {
				const stat = statSync(filePath);
				if (stat.mtimeMs <= this.lastFileTimestamp) {
					try { unlinkSync(filePath); } catch { /* ignore */ }
					continue;
				}

				const raw = readFileSync(filePath, "utf8");
				const event = JSON.parse(raw) as FeishuEvent;

				if (this.processedEvents.has(event.event_id)) {
					try { unlinkSync(filePath); } catch { /* ignore */ }
					continue;
				}
				this.processedEvents.add(event.event_id);
				this.trimEvents();

				this.lastFileTimestamp = stat.mtimeMs;
				this.eventsProcessed++;

				this.handleMessage(event).catch((err) => {
					console.error("[feishu-bot] Error handling event:", err);
				});

				try { unlinkSync(filePath); } catch { /* ignore */ }
			} catch {
				try { unlinkSync(filePath); } catch { /* ignore */ }
			}
		}
	}

	private trimEvents(): void {
		if (this.processedEvents.size > TRIM_THRESHOLD) {
			const arr = Array.from(this.processedEvents);
			this.processedEvents = new Set(arr.slice(-TRIM_TO));
		}
	}

	// --- Message handling ---

	private async handleMessage(event: FeishuEvent): Promise<void> {
		if (event.message_type !== "text") return;

		const isAllowedChat = this.config.allowedChats.includes(event.chat_id);
		const isAllowedUser = this.config.allowedUsers.includes(event.sender_id);
		if (!isAllowedChat && !isAllowedUser) return;

		const text = this.extractText(event.content);
		writeFileSync(join(process.env.HOME || "/tmp", ".pi/agent/feishu-debug.log"), `[${new Date().toISOString()}] raw: ${JSON.stringify(event.content)}\nextracted: ${JSON.stringify(text)}\n\n`, { flag: "a" });
		if (!text) return;

		await this.processMessage(event.chat_id, text);
	}

	private extractText(content: string): string {
		let text = content.trim();
		// Strip @bot mentions (format: @_user_Xxxx or @_all) but keep @1, @name for commands
		text = text.replace(/^@_user_\S+\s*/, "").trim();
		text = text.replace(/^@_all\s*/, "").trim();
		return text;
	}

	private async processMessage(chatId: string, text: string): Promise<void> {
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

	// --- Command parsing ---

	private parseCommand(text: string): ParsedCommand {
		const t = text.trim();

		if (t === "/help" || t === "/h") return { type: "help" };
		if (/^\/(?:session|s)\s+list$/i.test(t)) return { type: "session_list" };

		const sessionInfoMatch = t.match(/^\/(?:session|s)\s+info\s+(.+)$/i);
		if (sessionInfoMatch) return { type: "session_info", target: sessionInfoMatch[1].trim() };

		if (/^\/(?:bubble|b)\s+list$/i.test(t)) return { type: "bubble_list" };

		const bubbleInfoMatch = t.match(/^\/(?:bubble|b)\s+info\s+(.+)$/i);
		if (bubbleInfoMatch) return { type: "bubble_info", target: bubbleInfoMatch[1].trim() };

		// @target message - target can be #1, 1, name, or ID prefix
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

	// --- Target resolution ---

	private async resolveTarget(target: string, chatId: string): Promise<ResolvedTarget | null> {
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

	private extractCwdFromPath(sessionFile: string | null): string {
		if (!sessionFile) return process.cwd();
		try {
			const sm = SessionManager.open(sessionFile);
			const header = sm.getHeader();
			return header?.cwd ?? process.cwd();
		} catch {
			return process.cwd();
		}
	}

	// --- Command execution ---

	private async executeSessionList(chatId: string): Promise<void> {
		const sessions = await listAllSessions();
		const simplified = sessions.map((s) => ({
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

	private async executeSessionInfo(chatId: string, target: string): Promise<void> {
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

	private async executeBubbleList(chatId: string): Promise<void> {
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

	private async executeBubbleInfo(chatId: string, target: string): Promise<void> {
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

	// --- Core: send message to session/bubble and wait for reply ---

	private async executeTargetedMessage(chatId: string, target: string, message: string): Promise<void> {
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

		const timeoutMs = this.config.agentTimeoutMs ?? DEFAULT_TIMEOUT_MS;

		await new Promise<void>((resolve) => {
			let settled = false;

			const cleanup = () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			};

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

	private async getOrCreateWrapper(resolved: ResolvedTarget): Promise<AgentSessionWrapper> {
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

	// --- Extract last assistant reply ---

	private getEntryCount(wrapper: AgentSessionWrapper): number {
		const sessionFile = wrapper.sessionFile;
		if (!sessionFile) return 0;
		try {
			const sm = SessionManager.open(sessionFile);
			return sm.getEntries()?.length ?? 0;
		} catch {
			return 0;
		}
	}

	private extractLastAssistantReply(wrapper: AgentSessionWrapper, afterIndex: number = 0): string | null {
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

	// --- Sending messages ---

	private async sendAck(chatId: string, targetName: string): Promise<void> {
		await this.sendRaw(chatId, "--text", `⏳ ${targetName}: processing...`);
	}

	private async sendText(chatId: string, text: string): Promise<void> {
		await this.sendRaw(chatId, "--text", text);
	}

	private async sendReply(chatId: string, markdown: string): Promise<void> {
		const truncated =
			markdown.length > MAX_REPLY_LENGTH
				? markdown.slice(0, MAX_REPLY_LENGTH) + "\n\n..._(truncated)_"
				: markdown;
		await this.sendRaw(chatId, "--markdown", truncated);
	}

	private async sendError(chatId: string, error: string): Promise<void> {
		await this.sendRaw(chatId, "--text", `❌ ${error}`);
	}

	private async sendRaw(chatId: string, flag: string, content: string): Promise<void> {
		const args = [
			"im",
			"+messages-send",
			"--chat-id",
			chatId,
			flag,
			content,
			"--as",
			"bot",
		];
		try {
			await this.execLarkCli(args);
		} catch (err) {
			console.error("[feishu-bot] Failed to send message:", err);
		}
	}

	private execLarkCli(args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.larkCliPath, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, HOME: process.env.HOME },
			});
			let stderr = "";
			child.stderr?.on("data", (d) => {
				stderr += d.toString();
			});
			child.on("exit", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`lark-cli exited ${code}: ${stderr}`));
			});
			child.on("error", reject);
		});
	}

	private escapeMarkdown(text: string): string {
		return text.replace(/([*_`\[\]#])/g, "\\$1");
	}
}
