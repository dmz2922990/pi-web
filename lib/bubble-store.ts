import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Bubble, BubbleTemplate, BubbleStatus, BubbleResult } from "./bubble-types";

// --- Template Loading ---

function getTemplatesDir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "/";
	return join(homeDir, ".pi", "agent", "templates");
}

export function loadTemplates(): BubbleTemplate[] {
	const dir = getTemplatesDir();
	if (!existsSync(dir)) return [];

	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	const templates: BubbleTemplate[] = [];

	for (const file of files) {
		try {
			const raw = readFileSync(join(dir, file), "utf-8");
			const parsed = JSON.parse(raw) as BubbleTemplate;
			if (parsed.name && parsed.gateway?.systemPrompt && Array.isArray(parsed.roles)) {
				templates.push(parsed);
			}
		} catch {
			// Skip invalid templates
		}
	}

	return templates;
}

export function loadTemplate(name: string): BubbleTemplate | null {
	const dir = getTemplatesDir();
	const file = join(dir, `${name}.json`);
	if (!existsSync(file)) return null;

	try {
		const raw = readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw) as BubbleTemplate;
		return parsed.name && parsed.gateway?.systemPrompt ? parsed : null;
	} catch {
		return null;
	}
}

// --- Bubble Persistence ---

function getBubblesDir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "/";
	return join(homeDir, ".pi", "agent", "bubbles");
}

interface BubbleCache {
	[id: string]: Bubble;
}

function getCache(): BubbleCache {
	if (!(globalThis as Record<string, unknown>).__piBubbleCache) {
		(globalThis as Record<string, unknown>).__piBubbleCache = {};
	}
	return (globalThis as Record<string, unknown>).__piBubbleCache as BubbleCache;
}

function bubbleDir(bubbleId: string): string {
	return join(getBubblesDir(), bubbleId);
}

function bubbleFilePath(bubbleId: string): string {
	return join(bubbleDir(bubbleId), "bubble.json");
}

export function createBubble(
	templateName: string,
	cwd: string,
	environment: Record<string, string>,
	name?: string,
	workflowName?: string,
): Bubble {
	const id = `bubble_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const now = new Date().toISOString();

	const bubble: Bubble = {
		id,
		name: name ?? workflowName ?? templateName,
		templateName,
		...(workflowName ? { workflowName } : {}),
		cwd,
		status: "running",
		gatewaySessionId: "",
		workers: [],
		environment,
		createdAt: now,
	};

	const dir = bubbleDir(id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(bubbleFilePath(id), JSON.stringify(bubble, null, 2), "utf-8");

	getCache()[id] = bubble;
	return bubble;
}

export function getBubble(id: string): Bubble | null {
	const cached = getCache()[id];
	if (cached) return cached;

	const filePath = bubbleFilePath(id);
	if (!existsSync(filePath)) return null;

	try {
		const raw = readFileSync(filePath, "utf-8");
		const bubble = JSON.parse(raw) as Bubble;
		getCache()[id] = bubble;
		return bubble;
	} catch {
		return null;
	}
}

export function listBubbles(): Bubble[] {
	const dir = getBubblesDir();
	if (!existsSync(dir)) return [];

	const entries = readdirSync(dir).filter((e) => e.startsWith("bubble_"));
	const bubbles: Bubble[] = [];

	for (const entry of entries) {
		const bubble = getBubble(entry);
		if (bubble) bubbles.push(bubble);
	}

	return bubbles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateBubble(
	id: string,
	patch: Partial<{
		status: BubbleStatus;
		gatewaySessionId: string;
		gatewaySessionFile: string;
		workers: Bubble["workers"];
		completedAt: string;
		result: BubbleResult;
	}>,
): Bubble | null {
	const bubble = getBubble(id);
	if (!bubble) return null;

	Object.assign(bubble, patch);
	const filePath = bubbleFilePath(id);
	if (existsSync(filePath)) {
		writeFileSync(filePath, JSON.stringify(bubble, null, 2), "utf-8");
	}

	return bubble;
}

export function deleteBubble(id: string): boolean {
	const dir = bubbleDir(id);
	if (!existsSync(dir)) return false;

	rmSync(dir, { recursive: true, force: true });
	delete getCache()[id];
	return true;
}
