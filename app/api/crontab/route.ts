import { NextRequest, NextResponse } from "next/server";
import * as cronStore from "@/lib/cron-store";

export const dynamic = "force-dynamic";

interface SchedulerHandle {
	notifyTaskCreated(taskId: string): boolean;
	removeTask(taskId: string): boolean;
	removeTasksByTarget(targetId: string): number;
	getTasksByTarget(targetId: string): unknown[];
}

function getScheduler(): SchedulerHandle | undefined {
	return (globalThis as Record<string, unknown>).__piCronScheduler as SchedulerHandle | undefined;
}

export async function GET(req: NextRequest) {
	const targetId = req.nextUrl.searchParams.get("targetId");

	if (targetId) {
		const tasks = cronStore.listTasksByTarget(targetId);
		return NextResponse.json({ tasks });
	}

	const tasks = cronStore.listTasks();
	return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
	const body = (await req.json()) as {
		targetId: string;
		targetType: "session" | "bubble";
		targetName: string;
		cron: string;
		prompt: string;
	};

	if (!body.targetId || !body.targetType || !body.cron || !body.prompt) {
		return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
	}

	const task = cronStore.createTask(body.targetId, body.targetType, body.targetName, body.cron, body.prompt);

	// Notify scheduler (running in nodejs runtime via instrumentation.ts) to start the timer
	const scheduler = getScheduler();
	if (scheduler) {
		scheduler.notifyTaskCreated(task.id);
	} else {
		console.warn("[crontab-api] Scheduler not running, task saved to disk only (will load on restart)");
	}

	return NextResponse.json({ task }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
	const body = (await req.json()) as { taskId: string };

	if (!body.taskId) {
		return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
	}

	const scheduler = getScheduler();
	const deleted = scheduler
		? scheduler.removeTask(body.taskId)
		: cronStore.deleteTask(body.taskId);

	if (!deleted) {
		return NextResponse.json({ error: "Task not found" }, { status: 404 });
	}

	return NextResponse.json({ success: true });
}
