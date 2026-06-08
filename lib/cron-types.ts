export interface CronTask {
	id: string;
	targetId: string;
	targetType: "session" | "bubble";
	targetName: string;
	cron: string;
	prompt: string;
	createdAt: string;
	lastRunAt: string | null;
	lastStatus: "success" | "error" | "timeout" | null;
}
