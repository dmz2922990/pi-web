"use client";

import { useState } from "react";
import type { Bubble } from "@/lib/bubble-types";
import type { SessionInfo } from "@/lib/types";

interface WorkerState {
	roleName: string;
	sessionId: string;
	isStreaming?: boolean;
	isRemote?: boolean;
}

interface BubbleWithState extends Bubble {
	workerStates?: WorkerState[];
	gatewayStreaming?: boolean;
}

interface Props {
	bubble: BubbleWithState;
	selectedSessionId: string | null;
	onSelectSession: (session: SessionInfo) => void;
	onDelete?: (bubbleId: string) => void;
}

export function BubbleNode({ bubble, selectedSessionId, onSelectSession, onDelete }: Props) {
	const [collapsed, setCollapsed] = useState(true);

	const anyWorking =
		bubble.gatewayStreaming ||
		(bubble.workerStates ?? []).some((w) => w.isStreaming);

		const bubbleDotColor =
			anyWorking ? "#3b82f6" :
			bubble.status === "completed" ? "#22c55e" :
			bubble.status === "failed" ? "#ef4444" :
			"var(--text-dim)";

	const bubbleLabel = bubble.name || bubble.workflowName || bubble.templateName;

	const makeSessionInfo = (sessionId: string, label: string): SessionInfo => ({
		id: sessionId,
		path: "",
		cwd: bubble.cwd,
		name: label,
		created: bubble.createdAt,
		modified: bubble.createdAt,
		messageCount: 0,
		firstMessage: "",
	});

	return (
		<div style={{ marginBottom: 2 }}>
			{/* Bubble header */}
			<div
				style={{
					display: "flex", alignItems: "center", gap: 6,
					padding: "8px 10px", cursor: "pointer",
					borderRadius: 7, transition: "background 0.12s",
				}}
				onClick={() => {
				if (bubble.gatewaySessionId) {
					onSelectSession(makeSessionInfo(bubble.gatewaySessionId, `Gateway (${bubbleLabel})`));
				}
			}}
				onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
				onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
			>
				<svg
					width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
					strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
					onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
					style={{
						flexShrink: 0, transition: "transform 0.15s",
						transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
					}}
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
				<div style={{
					width: 8, height: 8, borderRadius: "50%",
					background: bubbleDotColor, flexShrink: 0,
					boxShadow: anyWorking && bubble.status === "running" ? `0 0 6px #3b82f6` : "none",
				}} />
				<span style={{
					fontSize: 12, fontWeight: 600, color: "var(--text)",
					overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
				}}>
					{bubbleLabel}
				</span>
				{onDelete && (
					<button
						onClick={(e) => { e.stopPropagation(); onDelete(bubble.id); }}
						title="Delete bubble"
						style={{
							marginLeft: "auto", background: "none", border: "none",
							color: "var(--text-dim)", cursor: "pointer", padding: 2,
							fontSize: 10, opacity: 0.6,
						}}
						onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "#ef4444"; }}
						onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.color = "var(--text-dim)"; }}
					>
						x
					</button>
				)}
			</div>

			{/* Children: Gateway + Workers */}
			{!collapsed && (
				<div style={{ paddingLeft: 20 }}>
					{/* Gateway */}
					{bubble.gatewaySessionId && (
						<BubbleSessionItem
							label="Gateway"
							sessionId={bubble.gatewaySessionId}
							isStreaming={bubble.gatewayStreaming}
							isSelected={selectedSessionId === bubble.gatewaySessionId}
							onClick={() => onSelectSession(makeSessionInfo(bubble.gatewaySessionId, `Gateway (${bubbleLabel})`))}
						/>
					)}
					{/* Workers */}
					{(bubble.workerStates ?? bubble.workers).map((w) => (
						<BubbleSessionItem
							key={w.sessionId}
							label={w.roleName}
							sessionId={w.sessionId}
							isStreaming={"isStreaming" in w ? Boolean(w.isStreaming) : false}
							isRemote={"isRemote" in w ? Boolean(w.isRemote) : false}
							isSelected={selectedSessionId === w.sessionId}
							onClick={() => onSelectSession(makeSessionInfo(w.sessionId, w.roleName))}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function BubbleSessionItem({
	label,
	sessionId,
	isStreaming,
	isRemote,
	isSelected,
	onClick,
}: {
	label: string;
	sessionId: string;
	isStreaming?: boolean;
	isRemote?: boolean;
	isSelected: boolean;
	onClick: () => void;
}) {
	return (
		<div
			onClick={onClick}
			style={{
				display: "flex", alignItems: "center", gap: 6,
				padding: "5px 10px", cursor: "pointer",
				borderRadius: 6,
				background: isSelected ? "var(--bg-selected)" : "transparent",
				transition: "background 0.12s",
			}}
			onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
			onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
		>
			<div style={{
				width: 6, height: 6, borderRadius: "50%",
				background: isStreaming ? "#3b82f6" : "var(--text-dim)",
				flexShrink: 0,
				boxShadow: isStreaming ? "0 0 4px #3b82f6" : "none",
			}} />
			<span style={{
				fontSize: 11, color: isSelected ? "var(--text)" : "var(--text-muted)",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			}}>
				{label}
			</span>
			{isRemote && (
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)"
					strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
					style={{ flexShrink: 0, marginLeft: "auto" }}
					aria-label="Remote (SSH)"
				>
					<rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
					<rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
					<line x1="6" y1="6" x2="6.01" y2="6" />
					<line x1="6" y1="18" x2="6.01" y2="18" />
				</svg>
			)}
		</div>
	);
}
