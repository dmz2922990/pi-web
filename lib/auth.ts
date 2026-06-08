import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import { writeFileSync, mkdirSync, chmodSync } from "fs";
import { NextRequest } from "next/server";
import { PASSKEY_DIR, PASSKEY_PATH, COOKIE_TTL, HMAC_ALGO } from "./auth-config";

// ============================================================================
// GlobalThis
// ============================================================================

declare global {
	// eslint-disable-next-line no-var
	var __piWebPasskey: string | undefined;
}

// ============================================================================
// Passkey Management
// ============================================================================

export function initializePasskey(): string {
	const envPassword = process.env.PI_WEB_PASSWORD;

	let passkey: string;
	if (envPassword) {
		// Configured mode: use env var, do NOT write to file
		passkey = envPassword;
	} else {
		// Random mode: generate new passkey on every startup
		passkey = randomBytes(16).toString("hex");
		mkdirSync(PASSKEY_DIR, { recursive: true });
		writeFileSync(PASSKEY_PATH, passkey, "utf8");
		try {
			chmodSync(PASSKEY_PATH, 0o600);
		} catch {
			// chmod may fail on Windows, ignore
		}
	}

	globalThis.__piWebPasskey = passkey;
	return passkey;
}

export function getPasskey(): string {
	if (!globalThis.__piWebPasskey) {
		throw new Error("Passkey not initialized");
	}
	return globalThis.__piWebPasskey;
}

export function getPasskeyPath(): string {
	return PASSKEY_PATH;
}

// ============================================================================
// Token Management
// ============================================================================

export function createToken(passkey: string): string {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const hmac = createHmac(HMAC_ALGO, passkey)
		.update(timestamp)
		.digest("hex");
	return `${timestamp}.${hmac}`;
}

export function verifyToken(token: string, passkey: string): boolean {
	const parts = token.split(".");
	if (parts.length !== 2) return false;

	const [timestampStr, providedHmac] = parts;
	const timestamp = Number(timestampStr);
	if (Number.isNaN(timestamp)) return false;

	if (Math.floor(Date.now() / 1000) - timestamp >= COOKIE_TTL) return false;

	const expectedHmac = createHmac(HMAC_ALGO, passkey)
		.update(timestampStr)
		.digest("hex");

	if (providedHmac.length !== expectedHmac.length) return false;

	return timingSafeEqual(
		Buffer.from(providedHmac, "hex"),
		Buffer.from(expectedHmac, "hex"),
	);
}

// ============================================================================
// Localhost Detection
// ============================================================================

export function isLocalhost(req: NextRequest): boolean {
	// Check Host header — the actual URL the browser used to reach us
	const host = req.headers.get("host") || "";
	const hostname = host.split(":")[0]; // strip port
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1"
	)
		return true;

	// Check forwarded headers (behind reverse proxy)
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) {
		const firstIp = forwarded.split(",")[0].trim();
		if (firstIp === "127.0.0.1" || firstIp === "::1") return true;
	}

	const realIp = req.headers.get("x-real-ip");
	if (realIp === "127.0.0.1" || realIp === "::1") return true;

	return false;
}
