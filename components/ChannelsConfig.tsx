"use client";

import { useState, useEffect, useCallback } from "react";

export function ChannelsConfig() {
	const [feishuStatus, setFeishuStatus] = useState<{
		loading: boolean;
		status: "not_configured" | "disabled" | "stopped" | "running" | "error";
		data?: { connected: boolean; eventsProcessed: number; larkCliPid: number | null };
		error?: string;
	}>({ loading: true, status: "stopped" });
	const [feishuActionLoading, setFeishuActionLoading] = useState(false);
	const [feishuSetupOpen, setFeishuSetupOpen] = useState(false);

	const refreshFeishu = useCallback(async () => {
		try {
			const res = await fetch("/api/feishu");
			const data = await res.json();
			setFeishuStatus({
				loading: false,
				status: data.status ?? "stopped",
				data: data.data,
				error: data.error,
			});
		} catch {
			setFeishuStatus({ loading: false, status: "error", error: "Failed to fetch status" });
		}
	}, []);

	useEffect(() => {
		refreshFeishu();
	}, [refreshFeishu]);

	const handleFeishuAction = useCallback(
		async (action: "start" | "stop" | "restart") => {
			setFeishuActionLoading(true);
			try {
				const res = await fetch("/api/feishu", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action }),
				});
				const data = await res.json();
				if (!res.ok) throw new Error(data.error || "Failed");
				await refreshFeishu();
			} catch {
				await refreshFeishu();
			} finally {
				setFeishuActionLoading(false);
			}
		},
		[refreshFeishu],
	);

	const cardStyle: React.CSSProperties = {
		border: "1px solid var(--border)",
		borderRadius: 10,
		padding: 20,
		background: "var(--bg-panel)",
		marginBottom: 12,
	};

	const statusDot = (color: string) => (
		<span
			style={{
				display: "inline-block",
				width: 8,
				height: 8,
				borderRadius: "50%",
				background: color,
				flexShrink: 0,
			}}
		/>
	);

	const btnStyle = (primary?: boolean): React.CSSProperties => ({
		padding: "5px 14px",
		fontSize: 12,
		borderRadius: 6,
		border: primary ? "none" : "1px solid var(--border)",
		background: primary ? "var(--accent)" : "none",
		color: primary ? "#fff" : "var(--text-muted)",
		cursor: feishuActionLoading ? "wait" : "pointer",
		opacity: feishuActionLoading ? 0.5 : 1,
	});

	return (
		<div style={{ padding: 24, overflowY: "auto", flex: 1 }}>
			{/* Feishu Card */}
			<div style={cardStyle}>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--text)"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
					</svg>
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
						Feishu (Lark)
					</span>
				</div>

				{feishuStatus.loading ? (
					<div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading...</div>
				) : (
					<>
						{/* Status badge */}
						<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
							{feishuStatus.status === "running" && (
								<>
									{statusDot("#22c55e")}
									<span style={{ fontSize: 12, color: "#22c55e", fontWeight: 500 }}>
										Running
									</span>
									{feishuStatus.data && (
										<span style={{ fontSize: 11, color: "var(--text-dim)" }}>
											{feishuStatus.data.connected ? "Connected" : "Disconnected"} &middot;{" "}
											{feishuStatus.data.eventsProcessed} events processed
										</span>
									)}
								</>
							)}
							{feishuStatus.status === "stopped" && (
								<>
									{statusDot("#eab308")}
									<span style={{ fontSize: 12, color: "#eab308", fontWeight: 500 }}>Stopped</span>
								</>
							)}
							{feishuStatus.status === "disabled" && (
								<>
									{statusDot("#888")}
									<span style={{ fontSize: 12, color: "#888", fontWeight: 500 }}>Disabled</span>
								</>
							)}
							{feishuStatus.status === "not_configured" && (
								<>
									{statusDot("#888")}
									<span style={{ fontSize: 12, color: "#888", fontWeight: 500 }}>
										Not Configured
									</span>
								</>
							)}
							{feishuStatus.status === "error" && (
								<>
									{statusDot("#ef4444")}
									<span style={{ fontSize: 12, color: "#ef4444", fontWeight: 500 }}>
										{feishuStatus.error || "Error"}
									</span>
								</>
							)}
						</div>

						{/* Action buttons */}
						{feishuStatus.status !== "not_configured" && (
							<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
								{(feishuStatus.status === "stopped" || feishuStatus.status === "disabled") && (
									<button
										onClick={() => handleFeishuAction("start")}
										disabled={feishuActionLoading}
										style={btnStyle(true)}
									>
										Start
									</button>
								)}
								{feishuStatus.status === "running" && (
									<>
										<button
											onClick={() => handleFeishuAction("stop")}
											disabled={feishuActionLoading}
											style={btnStyle()}
										>
											Stop
										</button>
										<button
											onClick={() => handleFeishuAction("restart")}
											disabled={feishuActionLoading}
											style={btnStyle()}
										>
											Restart
										</button>
									</>
								)}
								{feishuStatus.status === "error" && (
									<button
										onClick={() => handleFeishuAction("start")}
										disabled={feishuActionLoading}
										style={btnStyle(true)}
									>
										Start
									</button>
								)}
							</div>
						)}

						{/* Collapsible setup instructions */}
						<div>
							<button
								onClick={() => setFeishuSetupOpen(!feishuSetupOpen)}
								style={{
									background: "none",
									border: "none",
									color: "var(--accent)",
									cursor: "pointer",
									fontSize: 12,
									padding: 0,
								}}
							>
								{feishuSetupOpen ? "▾" : "▸"} Setup Instructions
							</button>
							{feishuSetupOpen && (
								<pre
									style={{
										marginTop: 8,
										padding: 12,
										background: "var(--bg)",
										border: "1px solid var(--border)",
										borderRadius: 6,
										fontSize: 11,
										fontFamily: "var(--font-mono)",
										color: "var(--text-muted)",
										whiteSpace: "pre-wrap",
										lineHeight: 1.6,
									}}
								>
{`1. Install lark-cli:
   npm install -g @anthropic-ai/lark-cli
2. Login as bot:
   lark-cli auth login --as bot
3. Create config file ~/.pi/agent/feishu-config.json:
   {
     "enabled": true,
     "allowedChats": ["your_chat_id"],
     "allowedUsers": ["your_user_id"]
   }
4. Start the bot from this page or restart the server`}
								</pre>
							)}
						</div>
					</>
				)}
			</div>

			{/* WeCom Card (placeholder) */}
			<div style={{ ...cardStyle, opacity: 0.6 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--text-dim)"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
					</svg>
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-dim)" }}>
						WeCom (企业微信)
					</span>
					<span
						style={{
							fontSize: 10,
							padding: "2px 6px",
							borderRadius: 4,
							background: "rgba(120,120,120,0.15)",
							color: "var(--text-dim)",
						}}
					>
						Coming Soon
					</span>
				</div>
				<div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
					WeCom (企业微信) integration via wecom-cli
				</div>
				<pre
					style={{
						padding: 10,
						background: "var(--bg)",
						border: "1px solid var(--border)",
						borderRadius: 6,
						fontSize: 11,
						fontFamily: "var(--font-mono)",
						color: "var(--text-dim)",
						whiteSpace: "pre-wrap",
						lineHeight: 1.5,
					}}
				>
{`npm install -g @anthropic-ai/wecom-cli
wecom-cli auth login
# Configure ~/.pi/agent/wecom-config.json`}
				</pre>
			</div>

			{/* DingTalk Card (placeholder) */}
			<div style={{ ...cardStyle, opacity: 0.6 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--text-dim)"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
					</svg>
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-dim)" }}>
						DingTalk (钉钉)
					</span>
					<span
						style={{
							fontSize: 10,
							padding: "2px 6px",
							borderRadius: 4,
							background: "rgba(120,120,120,0.15)",
							color: "var(--text-dim)",
						}}
					>
						Coming Soon
					</span>
				</div>
				<div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
					DingTalk (钉钉) integration via dingtalk-cli
				</div>
				<pre
					style={{
						padding: 10,
						background: "var(--bg)",
						border: "1px solid var(--border)",
						borderRadius: 6,
						fontSize: 11,
						fontFamily: "var(--font-mono)",
						color: "var(--text-dim)",
						whiteSpace: "pre-wrap",
						lineHeight: 1.5,
					}}
				>
{`npm install -g @anthropic-ai/dingtalk-cli
dingtalk-cli auth login
# Configure ~/.pi/agent/dingtalk-config.json`}
				</pre>
			</div>
		</div>
	);
}
