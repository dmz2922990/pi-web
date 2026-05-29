import { NextRequest, NextResponse } from "next/server";
import { createBubble, listBubbles } from "@/lib/bubble-store";
import { startBubble } from "@/lib/bubble-manager";

export const dynamic = "force-dynamic";

export async function GET() {
	const bubbles = listBubbles();
	return NextResponse.json({ bubbles });
}

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const { templateName, cwd, environment = {}, message, model } = body as {
			templateName?: string;
			cwd?: string;
			environment?: Record<string, string>;
			message?: string;
			model?: { provider: string; modelId: string };
		};

		if (!templateName || !cwd) {
			return NextResponse.json(
				{ error: "templateName and cwd are required" },
				{ status: 400 },
			);
		}

		const bubble = createBubble(templateName, cwd, environment);

		const manager = await startBubble(bubble.id, message, model);

		return NextResponse.json({
			bubble: {
				...bubble,
				gatewaySessionId: manager.getGatewaySessionId(),
				workers: manager.getWorkers(),
				status: manager.getStatus(),
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to create bubble";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
