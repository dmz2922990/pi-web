export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { startFeishuBot } = await import("./lib/feishu-bot");
		const feishuBot = await startFeishuBot();
		if (feishuBot) {
			console.log("[feishu-bot] Started successfully");
		}

		const { startWecomBot } = await import("./lib/wecom-bot");
		const wecomBot = await startWecomBot();
		if (wecomBot) {
			console.log("[wecom-bot] Started successfully");
		}

		const { CronScheduler } = await import("./lib/cron-scheduler");
		CronScheduler.getInstance().init();
	}
}
