import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getPasskey, createToken } from "@/lib/auth";
import { COOKIE_NAME, COOKIE_TTL } from "@/lib/auth-config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	try {
		const body = await req.json();
		const provided = body.passkey;
		if (!provided || typeof provided !== "string") {
			return NextResponse.json(
				{ error: "Passkey is required" },
				{ status: 400 },
			);
		}

		const passkey = getPasskey();
		const providedBuf = Buffer.from(provided, "utf8");
		const expectedBuf = Buffer.from(passkey, "utf8");

		// Constant-time comparison
		let valid = providedBuf.length === expectedBuf.length;
		if (valid) {
			valid = timingSafeEqual(providedBuf, expectedBuf);
		}

		if (!valid) {
			return NextResponse.json(
				{ error: "Invalid passkey" },
				{ status: 401 },
			);
		}

		const token = createToken(passkey);
		const res = NextResponse.json({ ok: true });
		res.cookies.set({
			name: COOKIE_NAME,
			value: token,
			httpOnly: true,
			path: "/",
			sameSite: "lax",
			secure: false,
			maxAge: COOKIE_TTL,
		});
		return res;
	} catch {
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
