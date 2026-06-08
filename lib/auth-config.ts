import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "/";

export const PASSKEY_DIR = join(HOME, ".pi", "pi-web");
export const PASSKEY_PATH = join(PASSKEY_DIR, "passkey");

export const COOKIE_NAME = "pi-web-token";
export const COOKIE_TTL = 86400; // 24 hours in seconds

export const HMAC_ALGO = "sha256";
