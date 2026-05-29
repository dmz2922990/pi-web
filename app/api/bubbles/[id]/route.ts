import { NextRequest, NextResponse } from "next/server";
import { getBubble, deleteBubble as deleteBubbleStore } from "@/lib/bubble-store";
import { stopBubble, getBubbleManager } from "@/lib/bubble-manager";

export const dynamic = "force-dynamic";

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const bubble = getBubble(id);
	if (!bubble) {
		return NextResponse.json({ error: "Bubble not found" }, { status: 404 });
	}

	const manager = getBubbleManager(id);
	const workerStates = bubble.workers.map((w) => {
		const wrapper = manager?.getWorkerWrapper(w.sessionId);
		return {
			...w,
			isStreaming: wrapper?.inner.isStreaming ?? false,
		};
	});

	const gatewayWrapper = manager?.getGatewayWrapper();

	return NextResponse.json({
		bubble: {
			...bubble,
			status: manager?.getStatus() ?? bubble.status,
			gatewayStreaming: gatewayWrapper?.inner.isStreaming ?? false,
			workerStates,
		},
	});
}

export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;

	try {
		await stopBubble(id);
		deleteBubbleStore(id);
		return NextResponse.json({ success: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to delete bubble";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
