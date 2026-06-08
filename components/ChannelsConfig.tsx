"use client";

import { useState, useEffect, useCallback } from "react";

type BotStatus = "not_configured" | "disabled" | "stopped" | "running" | "error";

export function ChannelsConfig() {
	// ---- Feishu state ----
	const [feishuStatus, setFeishuStatus] = useState<{
		loading: boolean;
		status: BotStatus;
		data?: { connected: boolean; eventsProcessed: number; larkCliPid: number | null };
		error?: string;
	}>({ loading: true, status: "stopped" });
	const [feishuActionLoading, setFeishuActionLoading] = useState(false);
	const [feishuSetupOpen, setFeishuSetupOpen] = useState(false);

	// ---- WeCom state ----
	const [wecomStatus, setWecomStatus] = useState<{
		loading: boolean;
		status: BotStatus;
		data?: { wsConnected: boolean; eventsProcessed: number };
		error?: string;
	}>({ loading: true, status: "stopped" });
	const [wecomActionLoading, setWecomActionLoading] = useState(false);
	const [wecomSetupOpen, setWecomSetupOpen] = useState(false);

	// ---- Feishu callbacks ----
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

	// ---- WeCom callbacks ----
	const refreshWecom = useCallback(async () => {
		try {
			const res = await fetch("/api/wecom");
			const data = await res.json();
			setWecomStatus({
				loading: false,
				status: data.status ?? "stopped",
				data: data.wsConnected !== undefined
					? { wsConnected: data.wsConnected, eventsProcessed: data.eventsProcessed ?? 0 }
					: undefined,
				error: data.error,
			});
		} catch {
			setWecomStatus({ loading: false, status: "error", error: "Failed to fetch status" });
		}
	}, []);

	const handleWecomAction = useCallback(
		async (action: "start" | "stop" | "restart") => {
			setWecomActionLoading(true);
			try {
				const res = await fetch("/api/wecom", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action }),
				});
				const data = await res.json();
				if (!res.ok) throw new Error(data.error || "Failed");
				await refreshWecom();
			} catch {
				await refreshWecom();
			} finally {
				setWecomActionLoading(false);
			}
		},
		[refreshWecom],
	);

	useEffect(() => {
		refreshFeishu();
		refreshWecom();
	}, [refreshFeishu, refreshWecom]);

	// ---- Shared styles ----
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

	const btnStyle = (primary?: boolean, loading?: boolean): React.CSSProperties => ({
		padding: "5px 14px",
		fontSize: 12,
		borderRadius: 6,
		border: primary ? "none" : "1px solid var(--border)",
		background: primary ? "var(--accent)" : "none",
		color: primary ? "#fff" : "var(--text-muted)",
		cursor: loading ? "wait" : "pointer",
		opacity: loading ? 0.5 : 1,
	});

	const preStyle: React.CSSProperties = {
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
	};

	const chatIcon = (color = "var(--text)") => (
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
		</svg>
	);

	const setupToggle = (open: boolean, onClick: () => void) => (
		<button onClick={onClick} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: 0 }}>
			{open ? "▾" : "▸"} Setup Instructions
		</button>
	);

	// ---- Render status badge ----
	const renderStatus = (status: BotStatus, data?: { connected?: boolean; wsConnected?: boolean; eventsProcessed: number }, error?: string) => {
		switch (status) {
			case "running":
				return (
					<>
						{statusDot("#22c55e")}
						<span style={{ fontSize: 12, color: "#22c55e", fontWeight: 500 }}>Running</span>
						{data && (
							<span style={{ fontSize: 11, color: "var(--text-dim)" }}>
								{data.connected ?? data.wsConnected ? "Connected" : "Disconnected"} &middot;{" "}
								{data.eventsProcessed} events processed
							</span>
						)}
					</>
				);
			case "stopped":
				return <>{statusDot("#eab308")}<span style={{ fontSize: 12, color: "#eab308", fontWeight: 500 }}>Stopped</span></>;
			case "disabled":
				return <>{statusDot("#888")}<span style={{ fontSize: 12, color: "#888", fontWeight: 500 }}>Disabled</span></>;
			case "not_configured":
				return <>{statusDot("#888")}<span style={{ fontSize: 12, color: "#888", fontWeight: 500 }}>Not Configured</span></>;
			case "error":
				return <>{statusDot("#ef4444")}<span style={{ fontSize: 12, color: "#ef4444", fontWeight: 500 }}>{error || "Error"}</span></>;
		}
	};

	// ---- Render action buttons ----
	const renderButtons = (status: BotStatus, onAction: (a: "start" | "stop" | "restart") => void, loading: boolean) => {
		if (status === "not_configured") return null;
		return (
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				{(status === "stopped" || status === "disabled") && (
					<button onClick={() => onAction("start")} disabled={loading} style={btnStyle(true, loading)}>Start</button>
				)}
				{status === "running" && (
					<>
						<button onClick={() => onAction("stop")} disabled={loading} style={btnStyle(false, loading)}>Stop</button>
						<button onClick={() => onAction("restart")} disabled={loading} style={btnStyle(false, loading)}>Restart</button>
					</>
				)}
				{status === "error" && (
					<button onClick={() => onAction("start")} disabled={loading} style={btnStyle(true, loading)}>Start</button>
				)}
			</div>
		);
	};

	return (
		<div style={{ padding: 24, overflowY: "auto", flex: 1 }}>
			{/* Feishu Card */}
			<div style={cardStyle}>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
					{chatIcon()}
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>Feishu (Lark)</span>
				</div>

				{feishuStatus.loading ? (
					<div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading...</div>
				) : (
					<>
						<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
							{renderStatus(feishuStatus.status, feishuStatus.data, feishuStatus.error)}
						</div>
						{renderButtons(feishuStatus.status, handleFeishuAction, feishuActionLoading)}
						<div>
							{setupToggle(feishuSetupOpen, () => setFeishuSetupOpen(!feishuSetupOpen))}
							{feishuSetupOpen && (
								<pre style={preStyle}>
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

			{/* WeCom Card */}
			<div style={cardStyle}>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
					{chatIcon()}
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>WeCom (企业微信)</span>
				</div>

				{wecomStatus.loading ? (
					<div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading...</div>
				) : (
					<>
						<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
							{renderStatus(wecomStatus.status, wecomStatus.data, wecomStatus.error)}
						</div>
						{renderButtons(wecomStatus.status, handleWecomAction, wecomActionLoading)}
						<div>
							{setupToggle(wecomSetupOpen, () => setWecomSetupOpen(!wecomSetupOpen))}
							{wecomSetupOpen && (
								<pre style={preStyle}>
{`1. Create a Smart Bot in WeCom admin console
   (Application Management > Smart Bot)
2. Note the botId and secret from the bot settings
3. Create config file ~/.pi/agent/wecom-config.json:
   {
     "enabled": true,
     "botId": "your_bot_id",
     "secret": "your_secret",
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

			{/* DingTalk Card (placeholder) */}
			<div style={{ ...cardStyle, opacity: 0.6 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
					{chatIcon("var(--text-dim)")}
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-dim)" }}>DingTalk (钉钉)</span>
					<span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(120,120,120,0.15)", color: "var(--text-dim)" }}>Coming Soon</span>
				</div>
				<div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
					DingTalk (钉钉) integration via dingtalk-cli
				</div>
				<pre style={preStyle}>
{`npm install -g @anthropic-ai/dingtalk-cli
dingtalk-cli auth login
# Configure ~/.pi/agent/dingtalk-config.json`}
				</pre>
			</div>
		</div>
	);
}
