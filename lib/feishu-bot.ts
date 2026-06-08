import { spawn, type ChildProcess } from "child_process";
import {
	readFileSync,
	readdirSync,
	unlinkSync,
	statSync,
	mkdirSync,
	rmSync,
	existsSync,
	writeFileSync,
} from "fs";
import { join } from "path";
import { BaseBot, MAX_REPLY_LENGTH, DEFAULT_TIMEOUT_MS } from "./base-bot";

// Re-export shared types for backward compat
export type { ResolvedTarget, ParsedCommand } from "./base-bot";
export { HELP_TEXT, MAX_REPLY_LENGTH, DEFAULT_TIMEOUT_MS } from "./base-bot";

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
// Feishu-specific constants
// ============================================================================

const TRIM_THRESHOLD = 10000;
const TRIM_TO = 5000;
const DEFAULT_POLL_MS = 2000;
const RESTART_DELAY_MS = 5000;

// ============================================================================
// FeishuBot
// ============================================================================

class FeishuBot extends BaseBot<FeishuBotStatus> {
	private config: FeishuConfig;
	private larkCliPath: string;
	private childProcess: ChildProcess | null = null;
	private eventDir: string;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private processedEvents: Set<string> = new Set();
	private running = false;
	private eventsProcessed = 0;
	private lastFileTimestamp = 0;

	constructor(config: FeishuConfig, larkCliPath: string) {
		super();
		this.config = config;
		this.larkCliPath = larkCliPath;
		const home = process.env.HOME || process.env.USERPROFILE || "/";
		const baseDir = join(home, ".pi", "agent", "feishu-events");
		const dirName = `ev-${Date.now()}`;
		this.eventDir = join(baseDir, dirName);
	}

	// ---- BaseBot abstract implementations ----

	protected get agentTimeoutMs(): number {
		return this.config.agentTimeoutMs ?? DEFAULT_TIMEOUT_MS;
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

	async sendAck(chatId: string, targetName: string): Promise<void> {
		await this.sendRaw(chatId, "--text", `⏳ ${targetName}: processing...`);
	}

	async sendText(chatId: string, text: string): Promise<void> {
		await this.sendRaw(chatId, "--text", text);
	}

	async sendReply(chatId: string, markdown: string): Promise<void> {
		const truncated =
			markdown.length > MAX_REPLY_LENGTH
				? markdown.slice(0, MAX_REPLY_LENGTH) + "\n\n..._(truncated)_"
				: markdown;
		await this.sendRaw(chatId, "--markdown", truncated);
	}

	async sendError(chatId: string, error: string): Promise<void> {
		await this.sendRaw(chatId, "--text", `❌ ${error}`);
	}

	// ---- Feishu-specific: event consumer ----

	private startEventConsumer(): void {
		mkdirSync(this.eventDir, { recursive: true });

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

	// ---- Feishu-specific: polling ----

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

	// ---- Feishu-specific: message handling ----

	private async handleMessage(event: FeishuEvent): Promise<void> {
		if (event.message_type !== "text") return;

		const isAllowedChat = this.config.allowedChats.includes(event.chat_id);
		const isAllowedUser = this.config.allowedUsers.includes(event.sender_id);
		if (!isAllowedChat && !isAllowedUser) return;

		const text = this.extractText(event.content);
		writeFileSync(join(process.env.HOME || "/tmp", ".pi/agent/feishu-debug.log"), `[${new Date().toISOString()}] event_id=${event.event_id} chat=${event.chat_id} sender=${event.sender_id} msg=${event.message_id} type=${event.message_type}\nraw: ${JSON.stringify(event.content)}\nextracted: ${JSON.stringify(text)}\n\n`, { flag: "a" });
		if (!text) return;

		await this.processMessage(event.chat_id, text);
	}

	private extractText(content: string): string {
		let text = content.trim();
		text = text.replace(/^@_user_\S+\s*/, "").trim();
		text = text.replace(/^@_all\s*/, "").trim();
		return text;
	}

	// ---- Feishu-specific: sending ----

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
}
