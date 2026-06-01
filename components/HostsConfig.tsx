"use client";

import { useState, useEffect, useCallback } from "react";
import type { HostConfig } from "@/lib/host-types";

interface Props {
	onClose: () => void;
}

type EditingHost = Omit<HostConfig, "id" | "createdAt"> & { id?: string };

const EMPTY_HOST: EditingHost = {
	name: "",
	host: "",
	port: 22,
	user: "",
	authType: "password",
	password: "",
	privateKey: "",
	remoteCwd: "",
};

export function HostsConfig({ onClose }: Props) {
	const [hosts, setHosts] = useState<HostConfig[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [editing, setEditing] = useState<EditingHost>({ ...EMPTY_HOST });
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

	useEffect(() => {
		fetch("/api/hosts")
			.then((r) => r.json())
			.then((data) => setHosts(data.hosts ?? []))
			.catch(() => setError("Failed to load hosts"));
	}, []);

	const selectHost = useCallback(
		(host: HostConfig | null) => {
			if (dirty) {
				const ok = confirm("Discard unsaved changes?");
				if (!ok) return;
			}
			if (host) {
				setSelectedId(host.id);
				setEditing({
					id: host.id,
					name: host.name,
					host: host.host,
					port: host.port,
					user: host.user ?? "",
					authType: host.authType,
					password: host.password ?? "",
					privateKey: host.privateKey ?? "",
					remoteCwd: host.remoteCwd ?? "",
				});
			} else {
				setSelectedId(null);
				setEditing({ ...EMPTY_HOST });
			}
			setDirty(false);
			setError(null);
		},
		[dirty],
	);

	const updateField = useCallback(
		(field: keyof EditingHost, value: string | number) => {
			setEditing((prev) => ({ ...prev, [field]: value }));
			setDirty(true);
		},
		[],
	);

	const handleSave = useCallback(async () => {
		if (!editing.name.trim() || !editing.host.trim()) {
			setError("Name and Host are required");
			return;
		}

		setSaving(true);
		setError(null);

		try {
			if (editing.id) {
				const updated = hosts.map((h) =>
					h.id === editing.id
						? {
								...h,
								name: editing.name,
								host: editing.host,
								port: editing.port,
								user: editing.user || undefined,
								authType: editing.authType,
								password: editing.authType === "password" ? editing.password : undefined,
								privateKey: editing.authType === "privateKey" ? editing.privateKey : undefined,
								remoteCwd: editing.remoteCwd || undefined,
							}
						: h,
				);
				await fetch("/api/hosts", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "saveAll", hosts: updated }),
				});
				setHosts(updated);
			} else {
				const res = await fetch("/api/hosts", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						host: {
							name: editing.name,
							host: editing.host,
							port: editing.port,
							user: editing.user || undefined,
							authType: editing.authType,
							password: editing.authType === "password" ? editing.password : undefined,
							privateKey: editing.authType === "privateKey" ? editing.privateKey : undefined,
							remoteCwd: editing.remoteCwd || undefined,
						},
					}),
				});
				const data = await res.json();
				if (data.host) {
					const newHosts = [...hosts, data.host];
					setHosts(newHosts);
					setSelectedId(data.host.id);
					setEditing((prev) => ({ ...prev, id: data.host.id }));
				}
			}
			setDirty(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [editing, hosts]);

	const handleDelete = useCallback(async () => {
		if (!editing.id) return;
		if (!confirm(`Delete host "${editing.name}"?`)) return;

		try {
			await fetch(`/api/hosts?id=${editing.id}`, { method: "DELETE" });
			setHosts((prev) => prev.filter((h) => h.id !== editing.id));
			selectHost(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete");
		}
	}, [editing, selectHost]);

	const handleTest = useCallback(async () => {
		if (!editing.host.trim()) {
			setTestResult({ ok: false, message: "Host is required" });
			return;
		}
		setTesting(true);
		setTestResult(null);
		try {
			const res = await fetch("/api/hosts/test", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					host: editing.host,
					port: editing.port,
					user: editing.user,
					authType: editing.authType,
					password: editing.password,
					privateKey: editing.privateKey,
				}),
			});
			const data = await res.json();
			setTestResult({
				ok: data.ok,
				message: data.ok ? (data.message ?? "OK") : (data.error ?? "Failed"),
			});
		} catch (err) {
			setTestResult({ ok: false, message: err instanceof Error ? err.message : "Failed" });
		} finally {
			setTesting(false);
		}
	}, [editing]);

	const inputStyle = {
		width: "100%",
		padding: "6px 10px",
		background: "var(--bg)",
		border: "1px solid var(--border)",
		borderRadius: 7,
		color: "var(--text)",
		fontSize: 12,
		outline: "none",
		boxSizing: "border-box" as const,
	};

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 1000,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "rgba(0,0,0,0.5)",
				backdropFilter: "blur(4px)",
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				style={{
					width: "90%",
					maxWidth: 640,
					maxHeight: "80vh",
					background: "var(--bg-panel)",
					border: "1px solid var(--border)",
					borderRadius: 14,
					overflow: "hidden",
					display: "flex",
					flexDirection: "column",
					boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
				}}
			>
				{/* Header */}
				<div
					style={{
						padding: "16px 20px",
						borderBottom: "1px solid var(--border)",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
						Remote Hosts
					</span>
					<button
						onClick={onClose}
						style={{
							background: "none",
							border: "none",
							color: "var(--text-muted)",
							cursor: "pointer",
							fontSize: 18,
							lineHeight: 1,
							padding: 4,
						}}
					>
						x
					</button>
				</div>

				{/* Body: two-panel layout */}
				<div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
					{/* Left: host list */}
					<div
						style={{
							width: 180,
							borderRight: "1px solid var(--border)",
							display: "flex",
							flexDirection: "column",
							overflowY: "auto",
						}}
					>
						{hosts.map((h) => (
							<button
								key={h.id}
								onClick={() => selectHost(h)}
								style={{
									display: "block",
									width: "100%",
									textAlign: "left",
									padding: "10px 14px",
									background:
										selectedId === h.id ? "var(--bg-selected)" : "none",
									border: "none",
									borderBottom: "1px solid var(--border)",
									cursor: "pointer",
									color: "var(--text)",
								}}
							>
								<div style={{ fontSize: 12, fontWeight: 600 }}>{h.name}</div>
								<div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
									{h.user ? `${h.user}@` : ""}
									{h.host}:{h.port}
								</div>
							</button>
						))}
						<button
							onClick={() => selectHost(null)}
							style={{
								padding: "10px 14px",
								background: "none",
								border: "none",
								borderTop: "1px solid var(--border)",
								cursor: "pointer",
								color: "var(--accent)",
								fontSize: 12,
								fontWeight: 600,
								width: "100%",
								textAlign: "left",
							}}
						>
							+ Add Host
						</button>
					</div>

					{/* Right: edit form */}
					<div
						style={{
							flex: 1,
							padding: "16px 20px",
							overflowY: "auto",
						}}
					>
						<div style={{ marginBottom: 10 }}>
							<label
								style={{
									display: "block",
									fontSize: 11,
									color: "var(--text-muted)",
									marginBottom: 3,
								}}
							>
								Name *
							</label>
							<input
								type="text"
								value={editing.name}
								onChange={(e) => updateField("name", e.target.value)}
								placeholder="e.g. Dev Server"
								style={inputStyle}
							/>
						</div>

						<div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
							<div style={{ flex: 3 }}>
								<label
									style={{
										display: "block",
										fontSize: 11,
										color: "var(--text-muted)",
										marginBottom: 3,
									}}
								>
									Host *
								</label>
								<input
									type="text"
									value={editing.host}
									onChange={(e) => updateField("host", e.target.value)}
									placeholder="IP or hostname"
									style={inputStyle}
								/>
							</div>
							<div style={{ flex: 1 }}>
								<label
									style={{
										display: "block",
										fontSize: 11,
										color: "var(--text-muted)",
										marginBottom: 3,
									}}
								>
									Port
								</label>
								<input
									type="number"
									value={editing.port}
									onChange={(e) => updateField("port", parseInt(e.target.value) || 22)}
									style={inputStyle}
								/>
							</div>
						</div>

						<div style={{ marginBottom: 10 }}>
							<label
								style={{
									display: "block",
									fontSize: 11,
									color: "var(--text-muted)",
									marginBottom: 3,
								}}
							>
								User
							</label>
							<input
								type="text"
								value={editing.user ?? ""}
								onChange={(e) => updateField("user", e.target.value)}
								placeholder="SSH username"
								style={inputStyle}
							/>
						</div>

						<div style={{ marginBottom: 10 }}>
							<label
								style={{
									display: "block",
									fontSize: 11,
									color: "var(--text-muted)",
									marginBottom: 3,
								}}
							>
								Auth Type
							</label>
							<select
								value={editing.authType}
								onChange={(e) => updateField("authType", e.target.value)}
								style={inputStyle}
							>
								<option value="password">Password</option>
								<option value="privateKey">Private Key</option>
							</select>
						</div>

						{editing.authType === "password" ? (
							<div style={{ marginBottom: 10 }}>
								<label
									style={{
										display: "block",
										fontSize: 11,
										color: "var(--text-muted)",
										marginBottom: 3,
									}}
								>
									Password
								</label>
								<input
									type="password"
									value={editing.password ?? ""}
									onChange={(e) => updateField("password", e.target.value)}
									placeholder="SSH password"
									style={inputStyle}
								/>
							</div>
						) : (
							<div style={{ marginBottom: 10 }}>
								<label
									style={{
										display: "block",
										fontSize: 11,
										color: "var(--text-muted)",
										marginBottom: 3,
									}}
								>
									Private Key Path
								</label>
								<input
									type="text"
									value={editing.privateKey ?? ""}
									onChange={(e) => updateField("privateKey", e.target.value)}
									placeholder="~/.ssh/id_rsa"
									style={inputStyle}
								/>
							</div>
						)}

						<div style={{ marginBottom: 10 }}>
							<label
								style={{
									display: "block",
									fontSize: 11,
									color: "var(--text-muted)",
									marginBottom: 3,
								}}
							>
								Remote Working Dir
							</label>
							<input
								type="text"
								value={editing.remoteCwd ?? ""}
								onChange={(e) => updateField("remoteCwd", e.target.value)}
								placeholder="/home/user/project"
								style={inputStyle}
							/>
						</div>

						{/* Test connection */}
						<div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
							<button
								onClick={handleTest}
								disabled={testing || !editing.host.trim()}
								style={{
									padding: "6px 14px",
									background: testing ? "var(--bg-hover)" : "var(--bg)",
									border: "1px solid var(--border)",
									borderRadius: 7,
									color: testing ? "var(--text-muted)" : "var(--text)",
									cursor: testing || !editing.host.trim() ? "default" : "pointer",
									fontSize: 12,
								}}
							>
								{testing ? "Testing..." : "Test Connection"}
							</button>
							{testResult && (
								<span style={{
									fontSize: 12,
									color: testResult.ok ? "#22c55e" : "#ef4444",
								}}>
									{testResult.message}
								</span>
							)}
						</div>

						{error && (
							<div style={{ fontSize: 12, color: "#ef4444", marginTop: 8 }}>
								{error}
							</div>
						)}
					</div>
				</div>

				{/* Footer */}
				<div
					style={{
						padding: "12px 20px",
						borderTop: "1px solid var(--border)",
						display: "flex",
						justifyContent: "space-between",
						gap: 8,
					}}
				>
					<div>
						{editing.id && (
							<button
								onClick={handleDelete}
								style={{
									padding: "6px 14px",
									background: "none",
									border: "1px solid #ef4444",
									borderRadius: 7,
									color: "#ef4444",
									cursor: "pointer",
									fontSize: 12,
								}}
							>
								Delete
							</button>
						)}
					</div>
					<div style={{ display: "flex", gap: 8 }}>
						<button
							onClick={onClose}
							style={{
								padding: "6px 14px",
								background: "none",
								border: "1px solid var(--border)",
								borderRadius: 7,
								color: "var(--text-muted)",
								cursor: "pointer",
								fontSize: 12,
							}}
						>
							Close
						</button>
						<button
							onClick={handleSave}
							disabled={saving || !dirty}
							style={{
								padding: "6px 14px",
								background: saving || !dirty ? "var(--bg-hover)" : "var(--accent)",
								border: "none",
								borderRadius: 7,
								color: saving || !dirty ? "var(--text-muted)" : "#fff",
								cursor: saving || !dirty ? "default" : "pointer",
								fontSize: 12,
								fontWeight: 600,
							}}
						>
							{saving ? "Saving..." : "Save"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
