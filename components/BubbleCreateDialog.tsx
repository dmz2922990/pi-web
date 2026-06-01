"use client";

import { useState, useEffect, useCallback } from "react";
import type { BubbleTemplate, Bubble } from "@/lib/bubble-types";
import type { HostConfig } from "@/lib/host-types";

interface ModelOption {
	id: string;
	name: string;
	provider: string;
}

interface Props {
	cwd: string;
	onClose: () => void;
	onBubbleCreated: (bubble: Bubble) => void;
}

export function BubbleCreateDialog({ cwd, onClose, onBubbleCreated }: Props) {
	const [templates, setTemplates] = useState<BubbleTemplate[]>([]);
	const [selectedTemplate, setSelectedTemplate] = useState<BubbleTemplate | null>(null);
	const [envValues, setEnvValues] = useState<Record<string, string>>({});
	const [message, setMessage] = useState("");
	const [bubbleName, setBubbleName] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [selectedModel, setSelectedModel] = useState<string>("");
	const [defaultModelKey, setDefaultModelKey] = useState<string>("");
	const [hosts, setHosts] = useState<HostConfig[]>([]);
	const [defaultHostId, setDefaultHostId] = useState<string>("local");
	const [roleHostOverrides, setRoleHostOverrides] = useState<Record<string, string>>({});

	useEffect(() => {
		fetch("/api/bubbles/templates")
			.then((r) => r.json())
			.then((data) => {
				setTemplates(data.templates ?? []);
				setLoading(false);
			})
			.catch(() => {
				setError("Failed to load templates");
				setLoading(false);
			});

		fetch("/api/models")
			.then((r) => r.json())
			.then((data: {
				modelList?: ModelOption[];
				defaultModel?: { provider: string; modelId: string } | null;
			}) => {
				const list = data.modelList ?? [];
				setModels(list);
				const def = data.defaultModel;
				if (def) {
					const key = `${def.provider}:${def.modelId}`;
					setDefaultModelKey(key);
					setSelectedModel(key);
				} else if (list.length > 0) {
					const key = `${list[0].provider}:${list[0].id}`;
					setDefaultModelKey(key);
					setSelectedModel(key);
				}
			})
			.catch(() => {});

			fetch("/api/hosts")
				.then((r) => r.json())
				.then((data: { hosts?: HostConfig[] }) => {
					setHosts(data.hosts ?? []);
				})
				.catch(() => {});
		}, []);

	const handleTemplateSelect = useCallback((template: BubbleTemplate) => {
		setSelectedTemplate(template);
			setBubbleName(template.name);
		const defaults: Record<string, string> = {};
		if (template.environment) {
			for (const field of template.environment) {
				if (field.default) defaults[field.key] = field.default;
			}
		}
		setEnvValues(defaults);
	}, []);

	const handleCreate = useCallback(async () => {
		if (!selectedTemplate) return;

		if (selectedTemplate.environment) {
			for (const field of selectedTemplate.environment) {
				if (!envValues[field.key]?.trim()) {
					setError(`"${field.label}" is required`);
					return;
				}
			}
		}

		setCreating(true);
		setError(null);

		try {
			const modelParts = selectedModel ? selectedModel.split(":") : undefined;
			const modelObj = modelParts && modelParts.length === 2
				? { provider: modelParts[0], modelId: modelParts[1] }
				: undefined;

				// Build host selections: per-role override or global default
				const hostSelections: Record<string, string> = {};
				for (const role of selectedTemplate.roles) {
					hostSelections[role.name] = roleHostOverrides[role.name] ?? defaultHostId;
				}

			const res = await fetch("/api/bubbles", {
				method: "POST",
				headers: { "Content-Type": "application/json" },

				body: JSON.stringify({
					templateName: selectedTemplate.name,
					name: bubbleName.trim() || selectedTemplate.name,
					cwd,
					environment: envValues,
					message: message.trim() || undefined,
					model: modelObj,
					hostSelections,
				}),
			});

			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error ?? "Failed to create bubble");
			}

			const data = await res.json();
			onBubbleCreated(data.bubble);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create bubble");
		} finally {
			setCreating(false);
		}
	}, [selectedTemplate, cwd, envValues, message, selectedModel, onBubbleCreated, onClose]);

	return (
		<div
			style={{
				position: "fixed", inset: 0, zIndex: 1000,
				display: "flex", alignItems: "center", justifyContent: "center",
				background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)",
			}}
			onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
		>
			<div
				style={{
					width: "90%", maxWidth: 520, maxHeight: "80vh",
					background: "var(--bg-panel)", border: "1px solid var(--border)",
					borderRadius: 14, overflow: "hidden",
					display: "flex", flexDirection: "column",
					boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
				}}
			>
				{/* Header */}
				<div style={{
					padding: "16px 20px", borderBottom: "1px solid var(--border)",
					display: "flex", alignItems: "center", justifyContent: "space-between",
				}}>
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
						New Work Bubble
					</span>
					<button
						onClick={onClose}
						style={{
							background: "none", border: "none", color: "var(--text-muted)",
							cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4,
						}}
					>
						x
					</button>
				</div>

				{/* Body */}
				<div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
					{loading && (
						<div style={{ color: "var(--text-muted)", textAlign: "center", padding: 24 }}>
							Loading templates...
						</div>
					)}

					{!loading && !selectedTemplate && (
						<div>
							<div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
								Select a workflow template:
							</div>
							{templates.length === 0 && (
								<div style={{ color: "var(--text-dim)", textAlign: "center", padding: 24 }}>
									No templates found. Add JSON files to ~/.pi/agent/templates/
								</div>
							)}
							{templates.map((t) => (
								<button
									key={t.name}
									onClick={() => handleTemplateSelect(t)}
									style={{
										display: "block", width: "100%", textAlign: "left",
										padding: "12px 14px", marginBottom: 6,
										background: "var(--bg-hover)", border: "1px solid var(--border)",
										borderRadius: 9, cursor: "pointer",
										transition: "background 0.12s, border-color 0.12s",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.background = "var(--bg-selected)";
										e.currentTarget.style.borderColor = "var(--accent)";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.background = "var(--bg-hover)";
										e.currentTarget.style.borderColor = "var(--border)";
									}}
								>
									<div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
										{t.name}
									</div>
									{t.description && (
										<div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
											{t.description}
										</div>
									)}
									<div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
										{t.roles.length} roles: {t.roles.map((r) => r.label).join(", ")}
									</div>
								</button>
							))}
						</div>
					)}

					{!loading && selectedTemplate && (
						<div>
							{/* Template info */}
							<div style={{
								display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
							}}>
								<button
									onClick={() => setSelectedTemplate(null)}
									style={{
										background: "none", border: "none", color: "var(--text-muted)",
										cursor: "pointer", fontSize: 13, padding: 0,
									}}
								>
									&lt; Back
								</button>
								<span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
									{selectedTemplate.name}
								</span>
							</div>

							{/* Bubble name */}
							<div style={{ marginBottom: 14 }}>
								<label style={{
									display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3,
								}}>
									Bubble name:
								</label>
								<input
									type="text"
									value={bubbleName}
									onChange={(e) => setBubbleName(e.target.value)}
									placeholder="Name for this bubble..."
									style={{
										width: "100%", padding: "6px 10px",
										background: "var(--bg)", border: "1px solid var(--border)",
										borderRadius: 7, color: "var(--text)", fontSize: 12,
										outline: "none", boxSizing: "border-box",
									}}
								/>
							</div>

							{/* Model selector */}
							{models.length > 0 && (
								<div style={{ marginBottom: 14 }}>
									<label style={{
										display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3,
									}}>
										Model:
									</label>
									<select
										value={selectedModel}
										onChange={(e) => setSelectedModel(e.target.value)}
										style={{
											width: "100%", padding: "6px 10px",
											background: "var(--bg)", border: "1px solid var(--border)",
											borderRadius: 7, color: "var(--text)", fontSize: 12,
											outline: "none", boxSizing: "border-box",
										}}
									>
										{models.map((m) => {
											const key = `${m.provider}:${m.id}`;
											const isDefault = key === defaultModelKey;
											return (
												<option key={key} value={key}>
													{m.name}{isDefault ? " (default)" : ""} [{m.provider}]
												</option>
											);
										})}
									</select>
								</div>
							)}

							{/* Environment fields */}
							{selectedTemplate.environment && selectedTemplate.environment.length > 0 && (
								<div style={{ marginBottom: 14 }}>
									<div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
										Configuration:
									</div>
									{selectedTemplate.environment.map((field) => (
										<div key={field.key} style={{ marginBottom: 8 }}>
											<label style={{
												display: "block", fontSize: 11, color: "var(--text-muted)",
												marginBottom: 3,
											}}>
												{field.label}
											</label>
											<input
												type="text"
												value={envValues[field.key] ?? ""}
												onChange={(e) =>
													setEnvValues((v) => ({ ...v, [field.key]: e.target.value }))
												}
												placeholder={field.default ?? field.label}
												style={{
													width: "100%", padding: "6px 10px",
													background: "var(--bg)", border: "1px solid var(--border)",
													borderRadius: 7, color: "var(--text)", fontSize: 12,
													outline: "none", boxSizing: "border-box",
												}}
											/>
										</div>
									))}
								</div>
							)}

							{/* Task description */}
							<div style={{ marginBottom: 14 }}>
								<label style={{
									display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3,
								}}>
									Task description (optional):
								</label>
								<textarea
									value={message}
									onChange={(e) => setMessage(e.target.value)}
									placeholder="Describe the problem you want to solve..."
									rows={3}
									style={{
										width: "100%", padding: "8px 10px",
										background: "var(--bg)", border: "1px solid var(--border)",
										borderRadius: 7, color: "var(--text)", fontSize: 12,
										outline: "none", resize: "vertical", boxSizing: "border-box",
										fontFamily: "inherit",
									}}
								/>
							</div>

							{/* Default execution host */}
							{hosts.length > 0 && (
								<div style={{ marginBottom: 14 }}>
									<label style={{
										display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3,
									}}>
										Default execution host:
									</label>
									<select
										value={defaultHostId}
										onChange={(e) => setDefaultHostId(e.target.value)}
										style={{
											width: "100%", padding: "6px 10px",
											background: "var(--bg)", border: "1px solid var(--border)",
											borderRadius: 7, color: "var(--text)", fontSize: 12,
											outline: "none", boxSizing: "border-box",
										}}
									>
										<option value="local">Local (default)</option>
										{hosts.map((h) => (
											<option key={h.id} value={h.id}>{h.name} ({h.host})</option>
										))}
									</select>
								</div>
							)}

							{/* Workers with host selection */}
							<div style={{
								fontSize: 11, color: "var(--text-dim)",
								padding: "8px 10px", background: "var(--bg)",
								borderRadius: 7, border: "1px solid var(--border)",
							}}>
								<div style={{ marginBottom: 6, color: "var(--text-muted)" }}>
									Workers ({selectedTemplate.roles.length}):
								</div>
								{selectedTemplate.roles.map((r) => (
									<div key={r.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
										<span style={{ color: "var(--text)", minWidth: 70 }}>{r.label}</span>
										<span style={{ color: "var(--text-dim)" }}>
											[{r.tools.join(", ")}]
										</span>
										{hosts.length > 0 && (
											<select
												value={roleHostOverrides[r.name] ?? ""}
												onChange={(e) => setRoleHostOverrides((prev) => ({
													...prev,
													[r.name]: e.target.value,
												}))}
												style={{
													marginLeft: "auto", padding: "3px 6px",
													background: "var(--bg-hover)", border: "1px solid var(--border)",
													borderRadius: 5, color: "var(--text)", fontSize: 10,
													outline: "none",
												}}
											>
												<option value="">Default</option>
												<option value="local">Local</option>
												{hosts.map((h) => (
													<option key={h.id} value={h.id}>{h.name}</option>
												))}
											</select>
										)}
									</div>
								))}
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				{error && (
					<div style={{ padding: "0 20px", fontSize: 12, color: "#ef4444" }}>
						{error}
					</div>
				)}
				<div style={{
					padding: "12px 20px", borderTop: "1px solid var(--border)",
					display: "flex", justifyContent: "flex-end", gap: 8,
				}}>
					<button
						onClick={onClose}
						disabled={creating}
						style={{
							padding: "6px 14px", background: "none",
							border: "1px solid var(--border)", borderRadius: 7,
							color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
						}}
					>
						Cancel
					</button>
					{selectedTemplate && (
						<button
							onClick={handleCreate}
							disabled={creating}
							style={{
								padding: "6px 14px",
								background: creating ? "var(--bg-hover)" : "var(--accent)",
								border: "none", borderRadius: 7,
								color: creating ? "var(--text-muted)" : "#fff",
								cursor: creating ? "default" : "pointer", fontSize: 12,
								fontWeight: 600,
							}}
						>
							{creating ? "Creating..." : "Create Bubble"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
