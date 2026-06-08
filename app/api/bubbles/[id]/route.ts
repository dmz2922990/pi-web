import { NextRequest, NextResponse } from "next/server";
import { getBubble, deleteBubble as deleteBubbleStore } from "@/lib/bubble-store";
import { stopBubble, getBubbleManager } from "@/lib/bubble-manager";
import { resolveSessionPath, invalidateSessionPathCache } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { unlinkSync } from "fs";

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
		const bubble = getBubble(id);
		await stopBubble(id);

		// Delete associated session files (gateway + workers)
		if (bubble) {
			const sessionIds: string[] = [];
			if (bubble.gatewaySessionId) sessionIds.push(bubble.gatewaySessionId);
			for (const w of bubble.workers) {
				if (w.sessionId) sessionIds.push(w.sessionId);
			}
			for (const sid of sessionIds) {
				getRpcSession(sid)?.destroy();
				const path = await resolveSessionPath(sid);
				if (path) {
					try { unlinkSync(path); } catch { /* ignore */ }
				}
				invalidateSessionPathCache(sid);
			}
		}

		deleteBubbleStore(id);

		// Clean up associated cron tasks
		try {
			const scheduler = (globalThis as Record<string, unknown>).__piCronScheduler as
				| { removeTasksByTarget: (id: string) => number }
				| undefined;
			scheduler?.removeTasksByTarget(id);
		} catch { /* non-critical */ }

		return NextResponse.json({ success: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to delete bubble";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
