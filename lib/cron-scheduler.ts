import { validate } from "node-cron";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import type { AgentSessionWrapper } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import type { CronTask } from "./cron-types";
import * as cronStore from "./cron-store";

// ============================================================================
// Types
// ============================================================================

interface QueueState {
	running: boolean;
	pending: string[]; // taskIds
}

// ============================================================================
// Cron expression matching (replaces node-cron schedule())
// ============================================================================

function matchCron(expr: string, date: Date): boolean {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return false;
	const [minute, hour, day, month, weekday] = parts;
	const v = date;

	if (!matchField(minute, v.getMinutes(), 0, 59)) return false;
	if (!matchField(hour, v.getHours(), 0, 23)) return false;
	if (!matchField(day, v.getDate(), 1, 31)) return false;
	if (!matchField(month, v.getMonth() + 1, 1, 12)) return false;
	if (!matchField(weekday, v.getDay(), 0, 6)) return false;

	return true;
}

function matchField(field: string, value: number, min: number, max: number): boolean {
	if (field === "*") return true;
	// Range: 1-5
	if (field.includes("-")) {
		const [lo, hi] = field.split("-").map(Number);
		return value >= lo && value <= hi;
	}
	// Step: */5 or 1-10/2
	if (field.includes("/")) {
		const [base, step] = field.split("/");
		const stepNum = Number(step);
		if (base === "*") return value % stepNum === 0;
		if (base.includes("-")) {
			const [lo, hi] = base.split("-").map(Number);
			return value >= lo && value <= hi && (value - lo) % stepNum === 0;
		}
		const start = Number(base);
		return value >= start && (value - start) % stepNum === 0;
	}
	// List: 1,3,5
	if (field.includes(",")) {
		return field.split(",").map(Number).includes(value);
	}
	// Single value
	return Number(field) === value;
}

// ============================================================================
// Singleton
// ============================================================================

declare global {
	var __piCronScheduler: CronScheduler | undefined;
}

export class CronScheduler {
	private queues = new Map<string, QueueState>();
	private shuttingDown = false;
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private lastTickMinute = -1;
	private registeredTaskIds = new Set<string>();

	static getInstance(): CronScheduler {
		if (!globalThis.__piCronScheduler) {
			globalThis.__piCronScheduler = new CronScheduler();
		}
		return globalThis.__piCronScheduler;
	}

	// ---- Lifecycle ----

	init(): void {
		const tasks = cronStore.listTasks();
		for (const task of tasks) {
			this.registeredTaskIds.add(task.id);
		}
		console.log(`[cron-scheduler] Loaded ${tasks.length} tasks`);

		// Poll every 15s — granular enough for minute-level cron
		this.tickInterval = setInterval(() => this.tick(), 15_000);
		// Prevent the interval from keeping the process alive unnecessarily
		if (this.tickInterval && typeof this.tickInterval === "object" && "unref" in this.tickInterval) {
			this.tickInterval.unref();
		}
		// Run first tick immediately
		this.tick();
	}

	shutdown(): void {
		this.shuttingDown = true;
		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}
		console.log("[cron-scheduler] Shutdown");
	}

	// ---- Task management ----

	addTask(
		targetId: string,
		targetType: "session" | "bubble",
		targetName: string,
		cronExpr: string,
		prompt: string,
	): CronTask | { error: string } {
		if (!validate(cronExpr)) {
			return { error: `Invalid cron expression: ${cronExpr}` };
		}

		const task = cronStore.createTask(targetId, targetType, targetName, cronExpr, prompt);
		this.registeredTaskIds.add(task.id);
		console.log(`[cron-scheduler] Added task ${task.id.slice(0, 8)} for ${targetName} [${cronExpr}]`);
		return task;
	}

	// Register a task already persisted to disk (called from API route via globalThis)
	notifyTaskCreated(taskId: string): boolean {
		const task = cronStore.getTask(taskId);
		if (!task) return false;
		this.registeredTaskIds.add(task.id);
		console.log(`[cron-scheduler] Registered existing task ${task.id.slice(0, 8)} for ${task.targetName} [${task.cron}]`);
		return true;
	}

	removeTask(taskId: string): boolean {
		this.registeredTaskIds.delete(taskId);
		return cronStore.deleteTask(taskId);
	}

	removeTasksByTarget(targetId: string): number {
		const tasks = cronStore.listTasksByTarget(targetId);
		for (const task of tasks) {
			this.registeredTaskIds.delete(task.id);
			cronStore.deleteTask(task.id);
		}
		if (tasks.length > 0) {
			console.log(`[cron-scheduler] Removed ${tasks.length} tasks for ${targetId}`);
		}
		return tasks.length;
	}

	getTasksByTarget(targetId: string): CronTask[] {
		return cronStore.listTasksByTarget(targetId);
	}

	// ---- Tick-based scheduling ----

	private tick(): void {
		const now = new Date();
		const currentMinute = now.getMinutes();

		// Only fire once per minute
		if (currentMinute === this.lastTickMinute) return;
		this.lastTickMinute = currentMinute;

		for (const taskId of this.registeredTaskIds) {
			const task = cronStore.getTask(taskId);
			if (!task) {
				this.registeredTaskIds.delete(taskId);
				continue;
			}
			if (matchCron(task.cron, now)) {
				this.enqueue(task.id);
			}
		}
	}

	// ---- Serial queue per target ----

	private enqueue(taskId: string): void {
		const task = cronStore.getTask(taskId);
		if (!task) return;

		let queue = this.queues.get(task.targetId);
		if (!queue) {
			queue = { running: false, pending: [] };
			this.queues.set(task.targetId, queue);
		}

		queue.pending.push(taskId);
		console.log(`[cron-scheduler] Task ${taskId.slice(0, 8)} queued for ${task.targetName}`);

		if (!queue.running) {
			this.drainQueue(task.targetId);
		}
	}

	private async drainQueue(targetId: string): Promise<void> {
		const queue = this.queues.get(targetId);
		if (!queue) return;

		queue.running = true;

		while (queue.pending.length > 0 && !this.shuttingDown) {
			const taskId = queue.pending.shift()!;
			await this.executeTask(taskId);
		}

		queue.running = false;

		if (queue.pending.length === 0) {
			this.queues.delete(targetId);
		}
	}

	// ---- Execution ----

	private async executeTask(taskId: string): Promise<void> {
		const task = cronStore.getTask(taskId);
		if (!task) return;

		console.log(`[cron-scheduler] Executing task ${taskId.slice(0, 8)} for ${task.targetName}: ${task.prompt.slice(0, 60)}...`);

		try {
			const wrapper = await this.getOrCreateWrapper(task);
			if (!wrapper || !wrapper.isAlive()) {
				console.error(`[cron-scheduler] Session not alive for task ${taskId.slice(0, 8)}`);
				cronStore.updateTask(taskId, {
					lastRunAt: new Date().toISOString(),
					lastStatus: "error",
				});
				return;
			}

			await new Promise<void>((resolve) => {
				let settled = false;

				const timer = setTimeout(async () => {
					if (!settled) {
						settled = true;
						unsubscribe();
						cronStore.updateTask(taskId, {
							lastRunAt: new Date().toISOString(),
							lastStatus: "timeout",
						});
						console.warn(`[cron-scheduler] Task ${taskId.slice(0, 8)} timed out`);
						resolve();
					}
				}, 600_000); // 10 min timeout

				const unsubscribe = wrapper.onEvent(async (event: Record<string, unknown>) => {
					if (event.type === "agent_end" && !settled) {
						settled = true;
						clearTimeout(timer);
						unsubscribe();
						cronStore.updateTask(taskId, {
							lastRunAt: new Date().toISOString(),
							lastStatus: "success",
						});
						console.log(`[cron-scheduler] Task ${taskId.slice(0, 8)} completed`);
						resolve();
					}

					if (event.type === "error" && !settled) {
						settled = true;
						clearTimeout(timer);
						unsubscribe();
						cronStore.updateTask(taskId, {
							lastRunAt: new Date().toISOString(),
							lastStatus: "error",
						});
						console.error(`[cron-scheduler] Task ${taskId.slice(0, 8)} agent error`);
						resolve();
					}
				});

				wrapper.send({ type: "prompt", message: task.prompt }).catch((err) => {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						unsubscribe();
						cronStore.updateTask(taskId, {
							lastRunAt: new Date().toISOString(),
							lastStatus: "error",
						});
						console.error(`[cron-scheduler] Task ${taskId.slice(0, 8)} send failed:`, err);
						resolve();
					}
				});
			});
		} catch (err) {
			cronStore.updateTask(taskId, {
				lastRunAt: new Date().toISOString(),
				lastStatus: "error",
			});
			console.error(`[cron-scheduler] Task ${taskId.slice(0, 8)} error:`, err);
		}
	}

	// ---- Session resolution ----

	private async getOrCreateWrapper(task: CronTask): Promise<AgentSessionWrapper | null> {
		const existing = getRpcSession(task.targetId);
		if (existing?.isAlive()) return existing;

		if (task.targetType === "bubble") {
			try {
				const { getBubbleManager } = await import("./bubble-manager");
				const manager = getBubbleManager(task.targetId);
				const gw = manager?.getGatewayWrapper();
				if (gw?.isAlive()) return gw;
			} catch { /* fall through */ }
			return null;
		}

		try {
			const sessionFile = await resolveSessionPath(task.targetId);
			if (!sessionFile) return null;

			const sessions = await (await import("./session-reader")).listAllSessions();
			const info = sessions.find((s) => s.id === task.targetId);
			const cwd = info?.cwd ?? process.cwd();

			const result = await startRpcSession(task.targetId, sessionFile, cwd);
			return result.session;
		} catch (err) {
			console.error(`[cron-scheduler] Failed to start session ${task.targetId.slice(0, 8)}:`, err);
			return null;
		}
	}
}
