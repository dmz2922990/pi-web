import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { CronTask } from "./cron-types";

// ============================================================================
// Directory
// ============================================================================

function getCronDir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "/";
	return join(homeDir, ".pi", "agent", "pi-web-crontab");
}

function taskFilePath(taskId: string): string {
	return join(getCronDir(), `${taskId}.json`);
}

// ============================================================================
// Cache (survives hot-reload via globalThis)
// ============================================================================

interface CronTaskCache {
	[id: string]: CronTask;
}

function getCache(): CronTaskCache {
	if (!(globalThis as Record<string, unknown>).__piCronTaskCache) {
		(globalThis as Record<string, unknown>).__piCronTaskCache = {};
	}
	return (globalThis as Record<string, unknown>).__piCronTaskCache as CronTaskCache;
}

// ============================================================================
// CRUD
// ============================================================================

export function createTask(
	targetId: string,
	targetType: "session" | "bubble",
	targetName: string,
	cron: string,
	prompt: string,
): CronTask {
	const task: CronTask = {
		id: randomUUID(),
		targetId,
		targetType,
		targetName,
		cron,
		prompt,
		createdAt: new Date().toISOString(),
		lastRunAt: null,
		lastStatus: null,
	};

	const dir = getCronDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(taskFilePath(task.id), JSON.stringify(task, null, 2), "utf-8");

	getCache()[task.id] = task;
	return task;
}

export function getTask(id: string): CronTask | null {
	const cached = getCache()[id];
	if (cached) return cached;

	const filePath = taskFilePath(id);
	if (!existsSync(filePath)) return null;

	try {
		const raw = readFileSync(filePath, "utf-8");
		const task = JSON.parse(raw) as CronTask;
		getCache()[task.id] = task;
		return task;
	} catch {
		return null;
	}
}

export function updateTask(id: string, patch: Partial<Pick<CronTask, "lastRunAt" | "lastStatus">>): CronTask | null {
	const task = getTask(id);
	if (!task) return null;

	Object.assign(task, patch);
	const filePath = taskFilePath(id);
	if (existsSync(filePath)) {
		writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
	}

	return task;
}

export function deleteTask(id: string): boolean {
	const filePath = taskFilePath(id);
	if (!existsSync(filePath)) return false;

	try {
		rmSync(filePath);
	} catch {
		return false;
	}

	delete getCache()[id];
	return true;
}

export function listTasks(): CronTask[] {
	const dir = getCronDir();
	if (!existsSync(dir)) return [];

	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	const tasks: CronTask[] = [];

	for (const file of files) {
		const task = getTask(file.replace(".json", ""));
		if (task) tasks.push(task);
	}

	return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listTasksByTarget(targetId: string): CronTask[] {
	return listTasks().filter((t) => t.targetId === targetId);
}
