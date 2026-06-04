import { NextRequest, NextResponse } from "next/server";
import { getFeishuBot, startFeishuBot, stopFeishuBot, loadFeishuConfig } from "@/lib/feishu-bot";

export const dynamic = "force-dynamic";

export async function GET() {
	const config = loadFeishuConfig();

	if (!config) {
		return NextResponse.json({
			status: "not_configured",
			message: "Create ~/.pi/agent/feishu-config.json to enable",
		});
	}

	if (!config.enabled) {
		return NextResponse.json({
			status: "disabled",
			config: { enabled: false },
		});
	}

	const bot = getFeishuBot();
	if (!bot) {
		return NextResponse.json({
			status: "stopped",
			config: { enabled: true, allowedChats: config.allowedChats.length },
		});
	}

	return NextResponse.json({
		status: "running",
		...bot.getStatus(),
	});
}

export async function POST(req: NextRequest) {
	const body = (await req.json()) as { action: "start" | "stop" | "restart" };

	switch (body.action) {
		case "stop":
			await stopFeishuBot();
			return NextResponse.json({ status: "stopped" });

		case "start": {
			const bot = await startFeishuBot();
			if (!bot) {
				return NextResponse.json(
					{ error: "Failed to start: check config and lark-cli" },
					{ status: 400 },
				);
			}
			return NextResponse.json({ status: "running" });
		}

		case "restart":
			await stopFeishuBot();
			{
				const bot = await startFeishuBot();
				if (!bot) {
					return NextResponse.json(
						{ error: "Failed to restart: check config and lark-cli" },
						{ status: 400 },
					);
				}
			}
			return NextResponse.json({ status: "running" });

		default:
			return NextResponse.json({ error: "Invalid action" }, { status: 400 });
	}
}
