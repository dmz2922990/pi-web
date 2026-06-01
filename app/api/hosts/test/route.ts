import { NextRequest, NextResponse } from "next/server";
import { SshConnection } from "@/lib/ssh-operations";
import type { SshConfig } from "@/lib/bubble-types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const { host, port, user, authType, password, privateKey } = body as {
			host?: string;
			port?: number;
			user?: string;
			authType?: "password" | "privateKey";
			password?: string;
			privateKey?: string;
		};

		if (!host) {
			return NextResponse.json({ ok: false, error: "host is required" }, { status: 400 });
		}

		const config: SshConfig = {
			host,
			port: port ?? 22,
			user: user || undefined,
			password: authType === "password" ? password : undefined,
			privateKey: authType === "privateKey" ? privateKey : undefined,
		};

		const conn = new SshConnection(config);

		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Connection timed out (10s)")), 10_000),
		);

		await Promise.race([conn.connect(), timeout]);

		// Quick test: run echo to verify the connection works
		const result = await conn.exec("echo OK");
		conn.disconnect();

		if (result.stdout.trim() === "OK") {
			return NextResponse.json({ ok: true, message: "Connection successful" });
		}
		return NextResponse.json({ ok: true, message: `Connected (echo: ${result.stdout.trim()})` });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Connection failed";
		return NextResponse.json({ ok: false, error: message }, { status: 200 });
	}
}
