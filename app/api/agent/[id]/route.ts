import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { restoreBubbleSession, isBubbleRemoteSession } from "@/lib/bubble-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Try bubble session restore first (preserves SSH tools)
    console.log("[POST /api/agent] trying restoreBubbleSession for", id);
    const bubbleSession = await restoreBubbleSession(id);
    console.log("[POST /api/agent] bubbleSession=", !!bubbleSession);
    if (bubbleSession) {
      const result = await bubbleSession.send(body);
      return NextResponse.json({ success: true, data: result });
    }

    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();

    const { session } = await startRpcSession(id, filePath, cwd);
    const result = await session.send(body);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      // Check if this is a bubble session that can be restored
      const bubbleSession = await restoreBubbleSession(id);
      if (bubbleSession) {
        const state = await bubbleSession.send({ type: "get_state" });
        return NextResponse.json({ running: true, state, isRemote: isBubbleRemoteSession(id) });
      }
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state, isRemote: isBubbleRemoteSession(id) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
