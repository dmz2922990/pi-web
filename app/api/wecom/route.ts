import { NextRequest, NextResponse } from "next/server";
import { getWecomBot, startWecomBot, stopWecomBot, loadWecomConfig } from "@/lib/wecom-bot";

export const dynamic = "force-dynamic";

export async function GET() {
	const config = loadWecomConfig();

	if (!config) {
		return NextResponse.json({
			status: "not_configured",
			message: "Create ~/.pi/agent/wecom-config.json to enable",
		});
	}

	if (!config.enabled) {
		return NextResponse.json({
			status: "disabled",
			config: { enabled: false },
		});
	}

	const bot = getWecomBot();
	if (!bot) {
		return NextResponse.json({
			status: "stopped",
			config: { enabled: true, allowedChats: config.allowedChats.length, allowedUsers: config.allowedUsers.length },
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
			await stopWecomBot();
			return NextResponse.json({ status: "stopped" });

		case "start": {
			const bot = await startWecomBot();
			if (!bot) {
				return NextResponse.json(
					{ error: "Failed to start: check config and botId/secret" },
					{ status: 400 },
				);
			}
			return NextResponse.json({ status: "running" });
		}

		case "restart":
			await stopWecomBot();
			{
				const bot = await startWecomBot();
				if (!bot) {
					return NextResponse.json(
						{ error: "Failed to restart: check config and botId/secret" },
						{ status: 400 },
					);
				}
			}
			return NextResponse.json({ status: "running" });

		default:
			return NextResponse.json({ error: "Invalid action" }, { status: 400 });
	}
}
