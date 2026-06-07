"use client";

import { useState } from "react";
import { ModelsConfig } from "./ModelsConfig";
import { HostsConfig } from "./HostsConfig";
import { ChannelsConfig } from "./ChannelsConfig";

type Section = "models" | "hosts" | "channels";

interface Props {
	onClose: () => void;
	onModelsRefresh: () => void;
}

const sections: { key: Section; label: string; icon: React.ReactNode }[] = [
	{
		key: "models",
		label: "Models",
		icon: (
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
				<line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
				<line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
				<line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
				<line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
			</svg>
		),
	},
	{
		key: "hosts",
		label: "Hosts",
		icon: (
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><circle cx="6" cy="6" r="1" /><circle cx="6" cy="18" r="1" />
			</svg>
		),
	},
	{
		key: "channels",
		label: "Channels",
		icon: (
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			</svg>
		),
	},
];

export function SettingsDialog({ onClose, onModelsRefresh }: Props) {
	const [activeSection, setActiveSection] = useState<Section>("models");

	return (
		<div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "stretch" }}>
			<div style={{ flex: 1, background: "var(--bg)", display: "flex", flexDirection: "column" }}>

				{/* Header */}
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", height: 44, flexShrink: 0 }}>
					<span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Settings</span>
					<button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
				</div>

				{/* Body: left nav + right content */}
				<div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

					{/* Left nav */}
					<div style={{ width: 210, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "var(--bg-panel)", flexShrink: 0, padding: "8px 0" }}>
						{sections.map((s) => (
							<div
								key={s.key}
								onClick={() => setActiveSection(s.key)}
								style={{
									display: "flex", alignItems: "center", gap: 10,
									padding: "10px 16px", cursor: "pointer",
									background: activeSection === s.key ? "var(--bg-selected)" : "none",
									color: activeSection === s.key ? "var(--text)" : "var(--text-muted)",
									fontSize: 13, fontWeight: activeSection === s.key ? 600 : 400,
									borderLeft: activeSection === s.key ? "3px solid var(--accent)" : "3px solid transparent",
									transition: "background 0.12s, color 0.12s",
								}}
								onMouseEnter={(e) => {
									if (activeSection !== s.key) {
										e.currentTarget.style.background = "var(--bg-hover)";
										e.currentTarget.style.color = "var(--text)";
									}
								}}
								onMouseLeave={(e) => {
									if (activeSection !== s.key) {
										e.currentTarget.style.background = "none";
										e.currentTarget.style.color = "var(--text-muted)";
									}
								}}
							>
								{s.icon}
								<span>{s.label}</span>
							</div>
						))}
					</div>

					{/* Right content */}
					<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
						{activeSection === "models" && (
							<ModelsConfig embedded onClose={onClose} onModelsSaved={onModelsRefresh} />
						)}
						{activeSection === "hosts" && (
							<HostsConfig embedded onClose={onClose} />
						)}
						{activeSection === "channels" && (
							<ChannelsConfig />
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
