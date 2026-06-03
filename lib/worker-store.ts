import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { WorkerDefinition } from "./bubble-types";

// --- Path ---

function getWorkersPath(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "/";
	return join(homeDir, ".pi", "agent", "workers.json");
}

// --- Cache ---

interface WorkerCache {
	data: WorkerDefinition[];
	loaded: boolean;
}

function getCache(): WorkerCache {
	if (!(globalThis as Record<string, unknown>).__piWorkersCache) {
		(globalThis as Record<string, unknown>).__piWorkersCache = {
			data: [],
			loaded: false,
		};
	}
	return (globalThis as Record<string, unknown>).__piWorkersCache as WorkerCache;
}

function invalidateCache(): void {
	const cache = getCache();
	cache.data = [];
	cache.loaded = false;
}

// --- Read/Write ---

function readWorkersFromDisk(): WorkerDefinition[] {
	const path = getWorkersPath();
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
}

function writeWorkersToDisk(workers: WorkerDefinition[]): void {
	const path = getWorkersPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(workers, null, 2), "utf8");
}

// --- Public API ---

export function listWorkers(): WorkerDefinition[] {
	const cache = getCache();
	if (!cache.loaded) {
		cache.data = readWorkersFromDisk();
		cache.loaded = true;
	}
	return cache.data;
}

export function getWorker(name: string): WorkerDefinition | undefined {
	return listWorkers().find((w) => w.name === name);
}

export function createWorker(worker: WorkerDefinition): WorkerDefinition {
	const workers = listWorkers();
	workers.push(worker);
	writeWorkersToDisk(workers);
	invalidateCache();
	return worker;
}

export function updateWorker(
	name: string,
	patch: Partial<Omit<WorkerDefinition, "name">>,
): WorkerDefinition | undefined {
	const workers = listWorkers();
	const idx = workers.findIndex((w) => w.name === name);
	if (idx === -1) return undefined;
	Object.assign(workers[idx], patch);
	writeWorkersToDisk(workers);
	invalidateCache();
	return workers[idx];
}

export function deleteWorker(name: string): boolean {
	const workers = listWorkers();
	const idx = workers.findIndex((w) => w.name === name);
	if (idx === -1) return false;
	workers.splice(idx, 1);
	writeWorkersToDisk(workers);
	invalidateCache();
	return true;
}

export function saveAllWorkers(workers: WorkerDefinition[]): void {
	writeWorkersToDisk(workers);
	invalidateCache();
}
