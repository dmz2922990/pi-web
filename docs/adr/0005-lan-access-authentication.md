# LAN Access Authentication via Passkey

pi-web supports binding to `0.0.0.0` for LAN access, but exposes all API endpoints without authentication — including agent control, API key management, SSH credentials, and package installation. We chose to add a single-secret authentication layer: a Passkey (configured or auto-generated) with HMAC-signed session cookies, enforced by Next.js middleware with localhost exemption.

## Status: accepted

## Considered Options

### 1. Static Passkey with HMAC-signed cookies (chosen)

A single secret (Passkey) stored in `~/.pi/pi-web/passkey`. Two modes: configured via `PI_WEB_PASSWORD` env var, or auto-generated as 32-character hex on each startup. Next.js middleware enforces auth on all non-localhost requests. Successful login sets an HttpOnly cookie containing an HMAC signature (Passkey as key). No server-side token storage needed — middleware verifies the signature against the current Passkey.

**Why**: Fits pi-web's single-user, single-process model. No external dependencies (database, OAuth provider). HMAC signing avoids server-side session state — password change or restart naturally invalidates old tokens. Localhost exemption preserves frictionless local development.

### 2. OAuth / SSO integration

Delegate authentication to an external identity provider (e.g. GitHub OAuth, corporate SSO).

**Why rejected**: pi-web is a local development tool, not a multi-tenant SaaS product. Introducing an OAuth provider adds operational complexity, requires internet connectivity, and provides no meaningful benefit over a shared secret for a single-user scenario.

### 3. IP whitelist

Allow requests only from known LAN IPs (e.g. `192.168.1.*`).

**Why rejected**: LAN IPs can change (DHCP), can be spoofed, and provide no identity verification. An IP whitelist controls network reachability, not identity — any device on the same subnet would pass. Does not protect against compromised devices on the same network.

### 4. mTLS (mutual TLS)

Require LAN clients to present a client certificate.

**Why rejected**: Requires certificate distribution and management. Browser TLS client certificate UX is poor (modal popups, per-browser configuration). Disproportionate complexity for a local development tool.

## Key Design Decisions

### Two Passkey modes, unified behavior

Configured mode (`PI_WEB_PASSWORD`) and random mode (32-char hex) differ only in Passkey source. Both write to `~/.pi/pi-web/passkey`, both use the same HMAC verification logic. This ensures a single code path for auth regardless of mode.

### 32-character hex for random Passkey

Auto-generated Passkeys are 32 hex characters (128 bits of entropy). Long enough that brute-force is infeasible; users copy from the passkey file rather than typing manually.

### Localhost exemption

Requests from `127.0.0.1` and `::1` bypass authentication entirely. The local user is the service owner — forcing them to authenticate adds friction with zero security gain since they have direct access to the passkey file and the terminal running the server.

### HMAC-signed cookie, no server-side session store

After Passkey verification, the server sets an HttpOnly cookie containing a random token and its HMAC signature. Middleware verifies the signature against the current Passkey on every request. No in-memory token registry needed — when the Passkey changes (restart in random mode), old cookies naturally fail verification.

### Login Page for LAN clients

An independent `/login` route displays a password input form and the passkey file path (`~/.pi/pi-web/passkey`) as a hint. Middleware redirects unauthenticated page requests to `/login`; API requests return `401`. SSE connections re-use the same cookie — no special handling needed.

### Passkey file permission 600

The `~/.pi/pi-web/passkey` file is created with `0600` permissions (owner read/write only) to prevent other users on the same machine from reading the secret.

## Consequences

- **Random mode forces re-login on every restart** — all LAN clients must re-enter the Passkey after server restart. This is intentional: the old Passkey is invalidated.
- **Configured mode preserves sessions across restarts** — as long as `PI_WEB_PASSWORD` is unchanged, existing cookies remain valid.
- **No multi-user support** — all LAN clients share the same Passkey. There is no concept of individual user accounts or permissions.
- **No transport encryption** — Passkey and session cookies are sent over HTTP. For LAN-only use this is acceptable; for WAN exposure, HTTPS should be added (out of scope for this ADR).
- **Passkey file is the single point of compromise** — anyone with read access to `~/.pi/pi-web/passkey` on the host machine can authenticate. File permission `600` mitigates this for multi-user machines.
