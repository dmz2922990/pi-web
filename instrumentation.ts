export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { startFeishuBot } = await import("./lib/feishu-bot");
		const bot = await startFeishuBot();
		if (bot) {
			console.log("[feishu-bot] Started successfully");
		}
	}
}
