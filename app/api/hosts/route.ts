import { NextRequest, NextResponse } from "next/server";
import { listHosts, createHost, deleteHost, saveAllHosts } from "@/lib/host-store";
import type { HostConfig } from "@/lib/host-types";

export const dynamic = "force-dynamic";

export async function GET() {
	const hosts = listHosts();
	return NextResponse.json({ hosts });
}

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const { action, host, hosts } = body as {
			action?: "create" | "saveAll";
			host?: Omit<HostConfig, "id" | "createdAt">;
			hosts?: HostConfig[];
		};

		if (action === "saveAll" && hosts) {
			saveAllHosts(hosts);
			return NextResponse.json({ ok: true });
		}

		if (host) {
			const created = createHost(host);
			return NextResponse.json({ host: created });
		}

		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to create host";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function DELETE(request: NextRequest) {
	const id = request.nextUrl.searchParams.get("id");
	if (!id) {
		return NextResponse.json({ error: "id is required" }, { status: 400 });
	}

	const ok = deleteHost(id);
	if (!ok) {
		return NextResponse.json({ error: "Host not found" }, { status: 404 });
	}
	return NextResponse.json({ ok: true });
}
