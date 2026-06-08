import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import type { WsFrame, TextMessage } from "@wecom/aibot-node-sdk";
import { BaseBot, DEFAULT_TIMEOUT_MS, MAX_REPLY_LENGTH } from "./base-bot";

// ============================================================================
// Config
// ============================================================================

export interface WecomConfig {
	enabled: boolean;
	botId: string;
	secret: string;
	allowedChats?: string[];
	allowedUsers?: string[];
	agentTimeoutMs?: number;
}

export interface WecomBotStatus {
	running: boolean;
	wsConnected: boolean;
	eventsProcessed: number;
	config: WecomConfig;
}

// ============================================================================
// Config loading
// ============================================================================

function getConfigPath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "/";
	return join(home, ".pi", "agent", "wecom-config.json");
}

export function loadWecomConfig(): WecomConfig | null {
	const path = getConfigPath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as WecomConfig;
	} catch {
		return null;
	}
}

// ============================================================================
// Singleton
// ============================================================================

declare global {
	var __piWecomBot: WecomBot | undefined;
}

export function getWecomBot(): WecomBot | undefined {
	return globalThis.__piWecomBot;
}

export async function startWecomBot(): Promise<WecomBot | null> {
	const existing = getWecomBot();
	if (existing?.isRunning()) return existing;
	if (existing) await existing.stop();

	const config = loadWecomConfig();
	if (!config || !config.enabled) return null;
	if (!config.botId || !config.secret) {
		console.error("[wecom-bot] botId and secret are required in config");
		return null;
	}

	const bot = new WecomBot(config);
	await bot.start();
	globalThis.__piWecomBot = bot;
	return bot;
}

export async function stopWecomBot(): Promise<void> {
	const bot = getWecomBot();
	if (!bot) return;
	await bot.stop();
	globalThis.__piWecomBot = undefined;
}

// ============================================================================
// WecomBot
// ============================================================================

class WecomBot extends BaseBot<WecomBotStatus> {
	private config: WecomConfig;
	private wsClient: WSClient | null = null;
	private running = false;
	private wsConnected = false;
	private eventsProcessed = 0;

	// Cache the last frame per chatId for delayed replies (agent_end callback)
	private frameCache = new Map<string, WsFrame<TextMessage>>();

	constructor(config: WecomConfig) {
		super();
		this.config = config;
	}

	// ---- BaseBot abstract implementations ----

	protected get agentTimeoutMs(): number {
		return this.config.agentTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	isRunning(): boolean {
		return this.running;
	}

	getStatus(): WecomBotStatus {
		return {
			running: this.running,
			wsConnected: this.wsConnected,
			eventsProcessed: this.eventsProcessed,
			config: this.config,
		};
	}

	async start(): Promise<void> {
		this.running = true;
		this.wsClient = new WSClient({
			botId: this.config.botId,
			secret: this.config.secret,
		});

		this.wsClient.on("authenticated", () => {
			this.wsConnected = true;
			console.log("[wecom-bot] WebSocket authenticated");
		});

		this.wsClient.on("disconnected", (reason: string) => {
			this.wsConnected = false;
			console.log("[wecom-bot] Disconnected:", reason);
		});

		this.wsClient.on("reconnecting", (attempt: number) => {
			console.log("[wecom-bot] Reconnecting, attempt", attempt);
		});

		this.wsClient.on("error", (err: Error) => {
			console.error("[wecom-bot] Error:", err.message);
		});

		this.wsClient.on("message.text", (frame: WsFrame<TextMessage>) => {
			this.handleMessage(frame).catch((err) => {
				console.error("[wecom-bot] Error handling message:", err);
			});
		});

		this.wsClient.connect();
		console.log("[wecom-bot] Started, connecting WebSocket...");
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.wsClient) {
			this.wsClient.disconnect();
			this.wsClient = null;
		}
		this.wsConnected = false;
		console.log("[wecom-bot] Stopped");
	}

	async sendAck(chatId: string, targetName: string): Promise<void> {
		await this.sendStreamReply(chatId, `⏳ ${targetName}: processing...`);
	}

	async sendText(chatId: string, text: string): Promise<void> {
		await this.sendStreamReply(chatId, text);
	}

	async sendReply(chatId: string, markdown: string): Promise<void> {
		const truncated =
			markdown.length > MAX_REPLY_LENGTH
				? markdown.slice(0, MAX_REPLY_LENGTH) + "\n\n..._(truncated)_"
				: markdown;
		await this.sendStreamReply(chatId, truncated);
	}

	async sendError(chatId: string, error: string): Promise<void> {
		await this.sendStreamReply(chatId, `❌ ${error}`);
	}

	// ---- WeCom-specific: message handling ----

	private async handleMessage(frame: WsFrame<TextMessage>): Promise<void> {
		const body = frame.body;
		if (!body) return;

		// Derive chatId: group chats use chatid, single chats use userid
		const chatId = body.chatid || body.from?.userid;
		if (!chatId) return;

		// Allowlist check (empty allowlist = allow all)
		const allowedChats = this.config.allowedChats ?? [];
		const allowedUsers = this.config.allowedUsers ?? [];
		const isAllowedChat = allowedChats.length === 0 || (body.chatid && allowedChats.includes(body.chatid));
		const isAllowedUser = allowedUsers.length === 0 || (body.from?.userid && allowedUsers.includes(body.from.userid));
		if (!isAllowedChat && !isAllowedUser) return;

		const text = body.text?.content?.trim();
		if (!text) return;

		// Cache frame for delayed replies
		this.frameCache.set(chatId, frame);
		this.eventsProcessed++;

		await this.processMessage(chatId, text);
	}

	// ---- WeCom-specific: sending via SDK ----

	private async sendStreamReply(chatId: string, content: string): Promise<void> {
		const frame = this.frameCache.get(chatId);
		if (!frame || !this.wsClient) return;

		try {
			const streamId = generateReqId("reply");
			await this.wsClient.replyStream(frame, streamId, content, true);
		} catch (err) {
			console.error("[wecom-bot] Failed to send reply:", err);
		}
	}
}
