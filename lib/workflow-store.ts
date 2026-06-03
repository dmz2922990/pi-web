import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { WorkflowDefinition } from "./bubble-types";

// --- Path ---

function getWorkflowsPath(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "/";
	return join(homeDir, ".pi", "agent", "workflows.json");
}

// --- Cache ---

interface WorkflowCache {
	data: WorkflowDefinition[];
	loaded: boolean;
}

function getCache(): WorkflowCache {
	if (!(globalThis as Record<string, unknown>).__piWorkflowsCache) {
		(globalThis as Record<string, unknown>).__piWorkflowsCache = {
			data: [],
			loaded: false,
		};
	}
	return (globalThis as Record<string, unknown>).__piWorkflowsCache as WorkflowCache;
}

function invalidateCache(): void {
	const cache = getCache();
	cache.data = [];
	cache.loaded = false;
}

// --- Read/Write ---

function readWorkflowsFromDisk(): WorkflowDefinition[] {
	const path = getWorkflowsPath();
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
}

function writeWorkflowsToDisk(workflows: WorkflowDefinition[]): void {
	const path = getWorkflowsPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(workflows, null, 2), "utf8");
}

// --- Public API ---

export function listWorkflows(): WorkflowDefinition[] {
	const cache = getCache();
	if (!cache.loaded) {
		cache.data = readWorkflowsFromDisk();
		cache.loaded = true;
	}
	return cache.data;
}

export function getWorkflow(name: string): WorkflowDefinition | undefined {
	return listWorkflows().find((w) => w.name === name);
}

export function createWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
	const workflows = listWorkflows();
	workflows.push(workflow);
	writeWorkflowsToDisk(workflows);
	invalidateCache();
	return workflow;
}

export function updateWorkflow(
	name: string,
	patch: Partial<Omit<WorkflowDefinition, "name">>,
): WorkflowDefinition | undefined {
	const workflows = listWorkflows();
	const idx = workflows.findIndex((w) => w.name === name);
	if (idx === -1) return undefined;
	Object.assign(workflows[idx], patch);
	writeWorkflowsToDisk(workflows);
	invalidateCache();
	return workflows[idx];
}

export function deleteWorkflow(name: string): boolean {
	const workflows = listWorkflows();
	const idx = workflows.findIndex((w) => w.name === name);
	if (idx === -1) return false;
	workflows.splice(idx, 1);
	writeWorkflowsToDisk(workflows);
	invalidateCache();
	return true;
}

export function saveAllWorkflows(workflows: WorkflowDefinition[]): void {
	writeWorkflowsToDisk(workflows);
	invalidateCache();
}
