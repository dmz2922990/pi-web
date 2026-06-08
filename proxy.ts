import { NextRequest, NextResponse } from "next/server";
import { verifyToken, isLocalhost, getPasskey } from "@/lib/auth";
import { COOKIE_NAME } from "@/lib/auth-config";

const EXEMPT_PATHS = ["/login", "/api/auth/login"];

function isExempt(pathname: string): boolean {
	if (EXEMPT_PATHS.includes(pathname)) return true;
	if (pathname.startsWith("/_next/")) return true;
	if (pathname === "/favicon.ico") return true;
	return false;
}

export function proxy(req: NextRequest) {
	// Localhost bypass
	if (isLocalhost(req)) return NextResponse.next();

	// Exempt paths
	if (isExempt(req.nextUrl.pathname)) return NextResponse.next();

	// Verify cookie
	const token = req.cookies.get(COOKIE_NAME)?.value;
	if (token) {
		const passkey = getPasskey();
		if (passkey && verifyToken(token, passkey)) {
			return NextResponse.next();
		}
	}

	// Not authenticated
	if (req.nextUrl.pathname.startsWith("/api/")) {
		return NextResponse.json(
			{ error: "Authentication required" },
			{ status: 401 },
		);
	}

	const loginUrl = new URL("/login", req.url);
	return NextResponse.redirect(loginUrl);
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
