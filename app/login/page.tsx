"use client";

import { useState, type FormEvent } from "react";

const PASSKEY_PATH = "~/.pi/pi-web/passkey";

export default function LoginPage() {
	const [passkey, setPasskey] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		setError("");
		setLoading(true);

		try {
			const res = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ passkey }),
			});

			if (res.ok) {
				window.location.href = "/";
				return;
			}

			const data = await res.json();
			setError(data.error || "Authentication failed");
		} catch {
			setError("Network error");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div
			style={{
				minHeight: "100dvh",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "var(--bg)",
				fontFamily: "inherit",
			}}
		>
			<form
				onSubmit={handleSubmit}
				style={{
					width: 360,
					padding: 32,
					background: "var(--bg-panel)",
					border: "1px solid var(--border)",
					borderRadius: 12,
					boxSizing: "border-box",
				}}
			>
				<h1
					style={{
						margin: "0 0 8px 0",
						fontSize: 20,
						fontWeight: 600,
						color: "var(--text)",
					}}
				>
					Pi Agent Web
				</h1>
				<p
					style={{
						margin: "0 0 24px 0",
						fontSize: 13,
						color: "var(--text-muted)",
					}}
				>
					This instance requires authentication.
				</p>

				<input
					type="password"
					value={passkey}
					onChange={(e) => setPasskey(e.target.value)}
					placeholder="Enter passkey"
					autoFocus
					disabled={loading}
					style={{
						width: "100%",
						padding: "8px 12px",
						background: "var(--bg)",
						border: "1px solid var(--border)",
						borderRadius: 6,
						color: "var(--text)",
						fontSize: 13,
						outline: "none",
						boxSizing: "border-box",
					}}
				/>

				{error && (
					<p
						style={{
							margin: "8px 0 0 0",
							fontSize: 12,
							color: "#ef4444",
						}}
					>
						{error}
					</p>
				)}

				<button
					type="submit"
					disabled={loading || !passkey}
					style={{
						width: "100%",
						marginTop: 16,
						padding: "8px 0",
						background: loading || !passkey ? "var(--bg-hover)" : "var(--accent)",
						color: loading || !passkey ? "var(--text-dim)" : "#ffffff",
						border: "none",
						borderRadius: 6,
						fontSize: 13,
						fontWeight: 500,
						cursor: loading || !passkey ? "default" : "pointer",
					}}
				>
					{loading ? "Verifying..." : "Login"}
				</button>

				<p
					style={{
						margin: "20px 0 0 0",
						fontSize: 11,
						color: "var(--text-dim)",
						lineHeight: 1.5,
					}}
				>
					Passkey file:{" "}
					<code style={{ fontFamily: "var(--font-mono)" }}>
						{PASSKEY_PATH}
					</code>
				</p>
			</form>
		</div>
	);
}
