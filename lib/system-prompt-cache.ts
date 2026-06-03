import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

declare global {
	var __piSystemPromptCache: Map<string, string> | undefined;
}

const CACHE_FILE_NAME = ".system-prompt-cache.json";

function getCache(): Map<string, string> {
	if (!globalThis.__piSystemPromptCache) {
		globalThis.__piSystemPromptCache = loadFromFile();
	}
	return globalThis.__piSystemPromptCache;
}

function loadFromFile(): Map<string, string> {
	try {
		const agentDir = getAgentDir();
		const filePath = join(agentDir, CACHE_FILE_NAME);
		const data = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
		return new Map(Object.entries(data));
	} catch {
		return new Map();
	}
}

function saveToFile(cache: Map<string, string>): void {
	try {
		const agentDir = getAgentDir();
		mkdirSync(dirname(join(agentDir, CACHE_FILE_NAME)), { recursive: true });
		const filePath = join(agentDir, CACHE_FILE_NAME);
		const obj: Record<string, string> = {};
		for (const [k, v] of cache) obj[k] = v;
		writeFileSync(filePath, JSON.stringify(obj, null, 2));
	} catch {
		// Non-critical — cache is best-effort
	}
}

export function cacheSystemPrompt(sessionId: string, prompt: string): void {
	if (!prompt) return;
	const cache = getCache();
	cache.set(sessionId, prompt);
	saveToFile(cache);
}

export function getCachedSystemPrompt(sessionId: string): string | undefined {
	return getCache().get(sessionId);
}

export function removeCachedSystemPrompt(sessionId: string): void {
	const cache = getCache();
	if (cache.delete(sessionId)) {
		saveToFile(cache);
	}
}
