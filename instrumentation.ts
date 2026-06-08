export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { initializePasskey, getPasskeyPath } = await import(
			"./lib/auth"
		);
		const passkey = initializePasskey();
		const mode = process.env.PI_WEB_PASSWORD ? "configured" : "random";
		console.log(`[pi-web-auth] Passkey initialized (${mode} mode)`);
		console.log(`[pi-web-auth] Passkey file: ${getPasskeyPath()}`);
		if (!process.env.PI_WEB_PASSWORD) {
			console.log(`[pi-web-auth] Passkey: ${passkey}`);
		}

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
