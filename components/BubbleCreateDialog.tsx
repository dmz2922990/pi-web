"use client";

import { useState, useEffect, useCallback } from "react";
import type { BubbleTemplate, Bubble, WorkflowDefinition, WorkerDefinition, BubbleEnvironmentField } from "@/lib/bubble-types";
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

type Page = "select" | "configure" | "manage-workers" | "manage-workflows";

// Extract {env.KEY} references from text
function extractEnvRefs(text: string): string[] {
	const keys: string[] = [];
	const re = /\{env\.([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) keys.push(m[1]);
	return keys;
}

// Merge declared environment fields with auto-detected {env.KEY} references
function getMergedEnvironment(wf: WorkflowDefinition, workers: WorkerDefinition[]): BubbleEnvironmentField[] {
	const fields: BubbleEnvironmentField[] = [];
	const seen = new Set<string>();

	const add = (f: BubbleEnvironmentField) => {
		if (!seen.has(f.key)) { seen.add(f.key); fields.push(f); }
	};

	// Declared workflow environment (highest priority, has labels/defaults)
	for (const f of wf.environment ?? []) add(f);

	// Declared worker environment
	const uniqueWorkerNames = [...new Set(wf.steps.map((s) => s.worker))];
	for (const wn of uniqueWorkerNames) {
		const wk = workers.find((w) => w.name === wn);
		for (const f of wk?.environment ?? []) add(f);
	}

	// Auto-detect from workflow gateway prompt
	for (const key of extractEnvRefs(wf.gatewayPrompt)) {
		add({ key, label: key, type: "string" });
	}

	// Auto-detect from step prompts
	for (const step of wf.steps) {
		if (step.prompt) {
			for (const key of extractEnvRefs(step.prompt)) {
				add({ key, label: key, type: "string" });
			}
		}
	}

	// Auto-detect from worker system prompts
	for (const wn of uniqueWorkerNames) {
		const wk = workers.find((w) => w.name === wn);
		if (wk?.systemPrompt) {
			for (const key of extractEnvRefs(wk.systemPrompt)) {
				add({ key, label: key, type: "string" });
			}
		}
	}

	return fields;
}

export function BubbleCreateDialog({ cwd, onClose, onBubbleCreated }: Props) {
	const [page, setPage] = useState<Page>("select");
	const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
	const [workers, setWorkers] = useState<WorkerDefinition[]>([]);
	const [templates, setTemplates] = useState<BubbleTemplate[]>([]);
	const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowDefinition | null>(null);
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
	const [workerHostOverrides, setWorkerHostOverrides] = useState<Record<string, string>>({});
	const [workerModelOverrides, setWorkerModelOverrides] = useState<Record<string, string>>({});

	const loadData = useCallback(() => {
		Promise.all([
			fetch("/api/bubbles/templates").then((r) => r.json()),
			fetch("/api/workflows").then((r) => r.json()),
			fetch("/api/workers").then((r) => r.json()),
		])
			.then(([tplData, wfData, wkData]) => {
				setTemplates(tplData.templates ?? []);
				setWorkflows(wfData.workflows ?? []);
				setWorkers(wkData.workers ?? []);
				setLoading(false);
			})
			.catch(() => {
				setError("Failed to load data");
				setLoading(false);
			});
	}, []);

	useEffect(() => {
		loadData();

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
	}, [loadData]);

	const handleWorkflowSelect = useCallback((wf: WorkflowDefinition) => {
		setSelectedWorkflow(wf);
		setBubbleName(wf.label);
		const defaults: Record<string, string> = {};
		for (const field of getMergedEnvironment(wf, workers)) {
			if (field.default) defaults[field.key] = field.default;
		}
		setEnvValues(defaults);
		setPage("configure");
	}, [workers]);

	const handleCreate = useCallback(async () => {
		if (!selectedWorkflow) return;

			const envFields = getMergedEnvironment(selectedWorkflow, workers);
			for (const field of envFields) {
				if (!envValues[field.key]?.trim()) {
					setError(`"${field.label}" is required`);
					return;
				}
			}

		setCreating(true);
		setError(null);

		try {
			const modelParts = selectedModel ? selectedModel.split(":") : undefined;
			const modelObj = modelParts && modelParts.length === 2
				? { provider: modelParts[0], modelId: modelParts[1] }
				: undefined;

			const workerNames = [...new Set(selectedWorkflow.steps.map((s) => s.worker))];
			const hostSelections: Record<string, string> = {};
			for (const wn of workerNames) {
				hostSelections[wn] = workerHostOverrides[wn] ?? defaultHostId;
			}

			const res = await fetch("/api/bubbles", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					workflowName: selectedWorkflow.name,
					name: bubbleName.trim() || selectedWorkflow.label,
					cwd,
					environment: envValues,
					message: message.trim() || undefined,
					model: modelObj,
					hostSelections,
					workerModels: Object.fromEntries(
						Object.entries(workerModelOverrides).filter(([_, v]) => v).map(([k, v]) => {
							const parts = v.split(":");
							return [k, { provider: parts[0], modelId: parts[1] }];
						})
					),
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
	}, [selectedWorkflow, workers, cwd, envValues, message, selectedModel, workerHostOverrides, workerModelOverrides, defaultHostId, bubbleName, onBubbleCreated, onClose]);

	// Collect merged environment from workflow + all referenced workers
		const mergedEnvironment = selectedWorkflow
			? getMergedEnvironment(selectedWorkflow, workers)
			: [];

	// Collect unique worker names from selected workflow
	const uniqueWorkerNames = selectedWorkflow
		? [...new Set(selectedWorkflow.steps.map((s) => s.worker))]
		: [];

	const renderSelectPage = () => (
		<div>
			<div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
				Select a workflow:
			</div>
			{workflows.length === 0 && templates.length === 0 && (
				<div style={{ color: "var(--text-dim)", textAlign: "center", padding: 24 }}>
					No workflows found. Create one or add templates to ~/.pi/agent/templates/
				</div>
			)}
			{workflows.map((wf) => (
				<button
					key={wf.name}
					onClick={() => handleWorkflowSelect(wf)}
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
						{wf.label}
					</div>
					{wf.description && (
						<div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
							{wf.description}
						</div>
					)}
					<div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
						{wf.steps.length} steps: {[...new Set(wf.steps.map((s) => s.worker))].join(", ")}
					</div>
				</button>
			))}
			<div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "center" }}>
				<button
					onClick={() => setPage("manage-workers")}
					style={manageBtnStyle}
				>
					Manage Workers
				</button>
				<button
					onClick={() => setPage("manage-workflows")}
					style={manageBtnStyle}
				>
					Manage Workflows
				</button>
			</div>
		</div>
	);

	const renderConfigurePage = () => (
		<div>
			<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
				<button
					onClick={() => { setSelectedWorkflow(null); setPage("select"); }}
					style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, padding: 0 }}
				>
					&lt; Back
				</button>
				<span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
					{selectedWorkflow!.label}
				</span>
			</div>

			{/* Bubble name */}
			<div style={{ marginBottom: 14 }}>
				<label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
					Bubble name:
				</label>
				<input
					type="text"
					value={bubbleName}
					onChange={(e) => setBubbleName(e.target.value)}
					placeholder="Name for this bubble..."
					style={inputStyle}
				/>
			</div>

			{/* Model selector */}
			{models.length > 0 && (
				<div style={{ marginBottom: 14 }}>
					<label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
						Model:
					</label>
					<select
						value={selectedModel}
						onChange={(e) => setSelectedModel(e.target.value)}
						style={inputStyle}
					>
						{models.map((m) => {
							const key = `${m.provider}:${m.id}`;
							return (
								<option key={key} value={key}>
									{m.name}{key === defaultModelKey ? " (default)" : ""} [{m.provider}]
								</option>
							);
						})}
					</select>
				</div>
			)}

			{/* Environment fields (merged from workflow + workers) */}
			{mergedEnvironment.length > 0 && (
				<div style={{ marginBottom: 14 }}>
					<div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
						Configuration:
					</div>
					{mergedEnvironment.map((field) => (
						<div key={field.key} style={{ marginBottom: 8 }}>
							<label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
								{field.label}
							</label>
							<input
								type="text"
								value={envValues[field.key] ?? ""}
								onChange={(e) => setEnvValues((v) => ({ ...v, [field.key]: e.target.value }))}
								placeholder={field.default ?? field.label}
								style={inputStyle}
							/>
						</div>
					))}
				</div>
			)}

			{/* Task description */}
			<div style={{ marginBottom: 14 }}>
				<label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
					Task description (optional):
				</label>
				<textarea
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder="Describe the problem you want to solve..."
					rows={3}
					style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
				/>
			</div>

			{/* Default execution host */}
			{hosts.length > 0 && (
				<div style={{ marginBottom: 14 }}>
					<label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
						Default execution host:
					</label>
					<select
						value={defaultHostId}
						onChange={(e) => setDefaultHostId(e.target.value)}
						style={inputStyle}
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
					Workers ({uniqueWorkerNames.length}):
				</div>
				{uniqueWorkerNames.map((wn) => {
					const wk = workers.find((w) => w.name === wn);
					return (
						<div key={wn} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
							<span style={{ color: "var(--text)", minWidth: 70 }}>{wk?.label ?? wn}</span>
							<span style={{ color: "var(--text-dim)" }}>
								[{wk?.tools.join(", ") ?? wn}]
							</span>
							{models.length > 0 && (
								<select
									value={workerModelOverrides[wn] ?? ""}
									onChange={(e) => setWorkerModelOverrides((prev) => ({ ...prev, [wn]: e.target.value }))}
									style={{
										marginLeft: "auto", padding: "3px 6px",
										background: "var(--bg-hover)", border: "1px solid var(--border)",
										borderRadius: 5, color: "var(--text)", fontSize: 10,
										outline: "none",
									}}
								>
									<option value="">Global Model</option>
									{models.map((m) => {
										const key = `${m.provider}:${m.id}`;
										return <option key={key} value={key}>{m.name} [{m.provider}]</option>;
									})}
								</select>
							)}
							{hosts.length > 0 && (
								<select
									value={workerHostOverrides[wn] ?? ""}
									onChange={(e) => setWorkerHostOverrides((prev) => ({ ...prev, [wn]: e.target.value }))}
									style={{
										padding: "3px 6px",
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
					);
				})}
			</div>
		</div>
	);

	const renderManageWorkersPage = () => (
		<WorkerManager
			workers={workers}
			hosts={hosts}
			onBack={() => { loadData(); setPage("select"); }}
			onRefresh={() => loadData()}
		/>
	);

	const renderManageWorkflowsPage = () => (
		<WorkflowManager
			workflows={workflows}
			workers={workers}
			onBack={() => { loadData(); setPage("select"); }}
			onRefresh={() => loadData()}
		/>
	);

	return (
		<div
			style={{
				position: "fixed", inset: 0, zIndex: 1000,
				display: "flex", alignItems: "center", justifyContent: "center",
				background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)",
			}}
			onMouseDown={(e) => { e.currentTarget.dataset.downTarget = e.target === e.currentTarget ? "1" : ""; }}
			onClick={(e) => { if (e.target === e.currentTarget && e.currentTarget.dataset.downTarget === "1") onClose(); }}
		>
			<div style={dialogStyle}>
				{/* Header */}
				<div style={headerStyle}>
					<span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
						{page === "select" && "New Work Bubble"}
						{page === "configure" && "Configure Bubble"}
						{page === "manage-workers" && "Manage Workers"}
						{page === "manage-workflows" && "Manage Workflows"}
					</span>
					<button onClick={onClose} style={closeBtnStyle}>x</button>
				</div>

				{/* Body */}
				<div style={bodyStyle}>
					{loading && (
						<div style={{ color: "var(--text-muted)", textAlign: "center", padding: 24 }}>
							Loading...
						</div>
					)}
					{!loading && page === "select" && renderSelectPage()}
					{!loading && page === "configure" && selectedWorkflow && renderConfigurePage()}
					{!loading && page === "manage-workers" && renderManageWorkersPage()}
					{!loading && page === "manage-workflows" && renderManageWorkflowsPage()}
				</div>

				{/* Footer */}
				{error && (
					<div style={{ padding: "0 20px", fontSize: 12, color: "#ef4444" }}>
						{error}
					</div>
				)}
				{page === "configure" && (
					<div style={footerStyle}>
						<button onClick={() => { setSelectedWorkflow(null); setPage("select"); }} disabled={creating} style={cancelBtnStyle}>
							Cancel
						</button>
						<button onClick={handleCreate} disabled={creating} style={{
							padding: "6px 14px",
							background: creating ? "var(--bg-hover)" : "var(--accent)",
							border: "none", borderRadius: 7,
							color: creating ? "var(--text-muted)" : "#fff",
							cursor: creating ? "default" : "pointer",
							fontSize: 12, fontWeight: 600,
							transition: "background 0.2s, color 0.2s",
						}}>
							{creating ? "Creating..." : "Create Bubble"}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

// --- Worker Manager ---

const DEFAULT_WORKER_TEMPLATE = `<role>
You are a senior code reviewer with deep expertise in software architecture, design patterns, and best practices.
Your task is to review code changes thoroughly, focusing on correctness, maintainability, performance, and security.
You provide actionable, precise feedback — not vague opinions.
</role>

<rule>
1. Review Scope: Only comment on the diff and its immediate context. Do not propose unrelated refactors.
2. Severity Levels: Classify each finding as [Critical], [Warning], or [Suggestion].
   - [Critical]: Bugs, security vulnerabilities, logic errors, data loss risks.
   - [Warning]: Potential issues, performance concerns, missing error handling.
   - [Suggestion]: Style improvements, naming, readability enhancements.
3. Be Specific: Always reference exact file paths and line numbers. Quote the relevant code snippet.
4. Suggest Fixes: For every [Critical] or [Warning], provide a concrete fix — do not just describe the problem.
5. No False Positives: If you are unsure whether something is a bug, state your uncertainty. Never flag definitively without confidence.
6. No Nitpicking: Skip trivial style preferences that are already handled by linters or formatters.
7. Acknowledge Good Code: Call out well-written sections when appropriate — review is not purely negative.
8. Language: Use the same language as the codebase comments for all feedback.
</rule>

<env>
{env.source_path}
</env>

<output_format>
Respond with a structured review in the following format:

## Summary
<One-line verdict: approve, request changes, or needs discussion>

## Findings
For each finding:
- **[Severity]** \`<file_path:line_number>\` — <description>
  <code snippet if relevant>
  **Fix:** <concrete suggestion>

## Notes
<Any additional observations, acknowledgments of good patterns, or context the author should know>
</output_format>`;


function WorkerManager({ workers, hosts, onBack, onRefresh }: {
	workers: WorkerDefinition[];
	hosts: HostConfig[];
	onBack: () => void;
	onRefresh: () => void;
}) {
	const [selected, setSelected] = useState<WorkerDefinition | null>(null);
	const [form, setForm] = useState<Partial<WorkerDefinition>>({});
	const [saving, setSaving] = useState(false);
	const [savedOk, setSavedOk] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);

	const selectWorker = (w: WorkerDefinition) => {
		setSelected(w);
		setForm({ ...w });
		setError(null);
		setDirty(false);
	};

	const newWorker = () => {
		setSelected(null);
		setForm({
				name: "",
				label: "",
				systemPrompt: DEFAULT_WORKER_TEMPLATE,
				tools: [],
			});
		setError(null);
		setDirty(false);
	};

	const handleSave = async () => {
		if (!form.name || !form.label || !form.systemPrompt) {
			setError("name, label, and systemPrompt are required");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			if (selected) {
				const res = await fetch("/api/workers", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: selected.name, patch: form }),
				});
				if (!res.ok) throw new Error("Save failed");
			} else {
				const res = await fetch("/api/workers", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ worker: form }),
				});
				if (!res.ok) throw new Error("Save failed");
			}
			onRefresh();
			setDirty(false);
			setSavedOk(true);
			setTimeout(() => setSavedOk(false), 2000);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async () => {
		if (!selected) return;
		setSaving(true);
		try {
			await fetch(`/api/workers?name=${encodeURIComponent(selected.name)}`, { method: "DELETE" });
			setSelected(null);
			setForm({});
			onRefresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Delete failed");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div style={{ display: "flex", gap: 12, minHeight: 300 }}>
			{/* List */}
			<div style={{ width: 160, borderRight: "1px solid var(--border)", paddingRight: 8 }}>
				{workers.map((w) => (
					<button
						key={w.name}
						onClick={() => selectWorker(w)}
						style={{
							display: "block", width: "100%", textAlign: "left",
							padding: "6px 8px", marginBottom: 2,
							background: selected?.name === w.name ? "var(--bg-selected)" : "none",
							border: "none", borderRadius: 5, cursor: "pointer",
							color: selected?.name === w.name ? "var(--text)" : "var(--text-muted)",
							fontSize: 12,
						}}
					>
						{w.label}
					</button>
				))}
				<button onClick={newWorker} style={{ ...manageBtnStyle, marginTop: 8, fontSize: 11 }}>
					+ New Worker
				</button>
				<button onClick={onBack} style={{ ...manageBtnStyle, marginTop: 4, fontSize: 11 }}>
					Back
				</button>
			</div>

			{/* Form */}
			<div style={{ flex: 1 }}>
				{!form.name && form.name !== "" ? (
					<div style={{ color: "var(--text-dim)", textAlign: "center", padding: 40 }}>
						Select a worker or create new
					</div>
				) : (
					<div>
						{error && <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 8 }}>{error}</div>}
						<FormInput label="Name" value={form.name ?? ""} onChange={(v) => { setForm((f) => ({ ...f, name: v })); setDirty(true); }} disabled={!!selected} placeholder="e.g. code-reviewer (kebab-case, unique ID)" />
						<FormInput label="Label" value={form.label ?? ""} onChange={(v) => { setForm((f) => ({ ...f, label: v })); setDirty(true); }} placeholder="e.g. Code Reviewer (display name)" />
						<FormTextarea label="System Prompt" value={form.systemPrompt ?? ""} onChange={(v) => { setForm((f) => ({ ...f, systemPrompt: v })); setDirty(true); }} rows={12} placeholder="Describe the worker role and behavior. Use XML tags like <role>, <rule>, <env>, <output_format> for structure." />
						<div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: -6, marginBottom: 8 }}>
							Tip: Use <code>{"{"}env.xxx{"}"}</code> placeholders as variables, e.g. <code>{"{"}env.source_path{"}"}</code>. Configure their values in the Workflow step settings.
						</div>
						<FormInput label="Tools (comma-separated)" value={(form.tools ?? []).join(", ")} onChange={(v) => { setForm((f) => ({ ...f, tools: v.split(",").map((s) => s.trim()).filter(Boolean) })); setDirty(true); }} placeholder="e.g. read, write, bash (leave empty for default)" />
						<FormInput label="Timeout (minutes)" value={form.timeoutMinutes?.toString() ?? ""} onChange={(v) => { setForm((f) => ({ ...f, timeoutMinutes: v ? parseInt(v) : undefined })); setDirty(true); }} placeholder="10 (default)" />
						<div style={{ display: "flex", gap: 8, marginTop: 12 }}>
							<button onClick={handleSave} disabled={saving || !dirty} style={createBtnStyle(saving, savedOk, dirty)}>
								{savedOk ? "Saved ✓" : saving ? "Saving..." : "Save"}
							</button>
							{selected && (
								<button onClick={handleDelete} disabled={saving} style={{ ...cancelBtnStyle, color: "#ef4444" }}>
									Delete
								</button>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// --- Workflow Manager ---

function WorkflowManager({ workflows, workers, onBack, onRefresh }: {
	workflows: WorkflowDefinition[];
	workers: WorkerDefinition[];
	onBack: () => void;
	onRefresh: () => void;
}) {
	const [selected, setSelected] = useState<WorkflowDefinition | null>(null);
	const [form, setForm] = useState<Partial<WorkflowDefinition>>({});
	const [steps, setSteps] = useState<WorkflowDefinition["steps"]>([]);
	const [saving, setSaving] = useState(false);
	const [savedOk, setSavedOk] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);

	const selectWorkflow = (wf: WorkflowDefinition) => {
		setSelected(wf);
		setForm({ label: wf.label, description: wf.description, gatewayPrompt: wf.gatewayPrompt, maxIterations: wf.maxIterations });
		setSteps([...wf.steps]);
		setError(null);
		setDirty(false);
	};

	const newWorkflow = () => {
		setSelected(null);
		setForm({ name: "", label: "", description: "", gatewayPrompt: "", maxIterations: 10, entryStep: "step_1" });
		setSteps([]);
		setError(null);
		setDirty(false);
	};

	const handleSave = async () => {
		const name = selected?.name ?? (form as { name?: string }).name;
		if (!name || !form.label || !form.gatewayPrompt) {
			setError("name, label, and gatewayPrompt are required");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			if (selected) {
				const res = await fetch("/api/workflows", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: selected.name, patch: { ...form, steps } }),
				});
				if (!res.ok) throw new Error("Save failed");
			} else {
				const res = await fetch("/api/workflows", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ workflow: { ...form, name, steps, entryStep: steps.length > 0 ? steps[0].id : "step_1" } }),
				});
				if (!res.ok) throw new Error("Save failed");
			}
			onRefresh();
			setDirty(false);
			setSavedOk(true);
			setTimeout(() => setSavedOk(false), 2000);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Save failed");
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async () => {
		if (!selected) return;
		setSaving(true);
		try {
			await fetch(`/api/workflows?name=${encodeURIComponent(selected.name)}`, { method: "DELETE" });
			setSelected(null);
			setForm({});
			setSteps([]);
			onRefresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Delete failed");
		} finally {
			setSaving(false);
		}
	};

	const handleExport = async () => {
		if (!selected) return;
		const res = await fetch(`/api/workflows/export?name=${encodeURIComponent(selected.name)}`);
		const data = await res.json();
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${selected.name}.pi-workflow.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const handleImport = async () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,.pi-workflow.json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const bundle = JSON.parse(text);
				const res = await fetch("/api/workflows/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(bundle),
				});
				const result = await res.json();
				if (result.imported) {
					onRefresh();
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Import failed");
			}
		};
		input.click();
	};

	const addStep = () => {
		const idx = steps.length + 1;
		setSteps((s) => [...s, { id: `step_${idx}`, name: `Step ${idx}`, worker: workers[0]?.name ?? "" }]);
		setDirty(true);
	};

	const updateStep = (i: number, patch: Partial<WorkflowDefinition["steps"][0]>) => {
		setSteps((s) => {
			const next = [...s];
			next[i] = { ...next[i], ...patch };
			return next;
		});
		setDirty(true);
	};

	const removeStep = (i: number) => {
		setSteps((s) => s.filter((_, idx) => idx !== i));
		setDirty(true);
	};

	return (
		<div style={{ display: "flex", gap: 12, minHeight: 300 }}>
			{/* List */}
			<div style={{ width: 160, borderRight: "1px solid var(--border)", paddingRight: 8 }}>
				{workflows.map((wf) => (
					<button
						key={wf.name}
						onClick={() => selectWorkflow(wf)}
						style={{
							display: "block", width: "100%", textAlign: "left",
							padding: "6px 8px", marginBottom: 2,
							background: selected?.name === wf.name ? "var(--bg-selected)" : "none",
							border: "none", borderRadius: 5, cursor: "pointer",
							color: selected?.name === wf.name ? "var(--text)" : "var(--text-muted)",
							fontSize: 12,
						}}
					>
						{wf.label}
					</button>
				))}
				<button onClick={newWorkflow} style={{ ...manageBtnStyle, marginTop: 8, fontSize: 11 }}>
					+ New Workflow
				</button>
				<button onClick={handleImport} style={{ ...manageBtnStyle, marginTop: 4, fontSize: 11 }}>
					Import
				</button>
				<button onClick={onBack} style={{ ...manageBtnStyle, marginTop: 4, fontSize: 11 }}>
					Back
				</button>
			</div>

			{/* Form */}
			<div style={{ flex: 1, overflowY: "auto" }}>
				{!form.label && form.label !== "" ? (
					<div style={{ color: "var(--text-dim)", textAlign: "center", padding: 40 }}>
						Select a workflow or create new
					</div>
				) : (
					<div>
						{error && <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 8 }}>{error}</div>}
						{!selected && (
							<FormInput label="Name" value={(form as { name?: string }).name ?? ""} onChange={(v) => { setForm((f) => ({ ...f, name: v })); setDirty(true); }} placeholder="e.g. bug-fix-pipeline (kebab-case, unique ID)" />
						)}
						<FormInput label="Label" value={form.label ?? ""} onChange={(v) => { setForm((f) => ({ ...f, label: v })); setDirty(true); }} placeholder="e.g. Bug Fix Pipeline (display name)" />
						<FormInput label="Description" value={form.description ?? ""} onChange={(v) => { setForm((f) => ({ ...f, description: v })); setDirty(true); }} placeholder="Brief description of what this workflow does" />
						<FormTextarea label="Gateway Prompt" value={form.gatewayPrompt ?? ""} onChange={(v) => { setForm((f) => ({ ...f, gatewayPrompt: v })); setDirty(true); }} rows={4} placeholder="High-level goal / instructions for the Gateway agent that orchestrates the workflow" />
						<FormInput label="Max Iterations" value={form.maxIterations?.toString() ?? "10"} onChange={(v) => { setForm((f) => ({ ...f, maxIterations: parseInt(v) || 10 })); setDirty(true); }} placeholder="10 (default, prevents infinite loops)" />

						{/* Steps editor */}
						<div style={{ fontSize: 12, color: "var(--text-muted)", margin: "12px 0 6px" }}>
							Steps ({steps.length}):
						</div>
							{steps.map((step, i) => (
								<div key={i} style={{
									padding: "8px 10px", marginBottom: 6,
									background: "var(--bg)", border: "1px solid var(--border)",
									borderRadius: 7,
								}}>
									<div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
										<span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", minWidth: 20 }}>{step.id}</span>
										<input
											value={step.name}
											onChange={(e) => updateStep(i, { name: e.target.value })}
											placeholder="Step name"
											style={{ ...inputStyle, flex: 1 }}
										/>
										<select
											value={step.worker}
											onChange={(e) => updateStep(i, { worker: e.target.value })}
											style={{ ...inputStyle, width: 130 }}
										>
											{workers.map((w) => (
												<option key={w.name} value={w.name}>{w.label}</option>
											))}
										</select>
										<button onClick={() => removeStep(i)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 14 }}>x</button>
									</div>
									<input
										value={step.prompt ?? ""}
										onChange={(e) => updateStep(i, { prompt: e.target.value || undefined })}
										placeholder="Step prompt (optional, appended after worker system prompt)"
										style={inputStyle}
									/>
									{/* On Success row */}
									<div style={{ display: "flex", gap: 4, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
										<span style={{ fontSize: 10, color: "var(--text-muted)", minWidth: 60 }}>On success:</span>
										<StepTargetChips
											steps={steps} currentIdx={i}
											selected={step.onSuccess ?? []}
											onChange={(ids) => updateStep(i, {
												onSuccess: ids.length > 0 ? ids : undefined,
												terminalStatus: ids.length > 0 ? undefined : step.terminalStatus,
											})}
										/>
										<button
											onClick={() => updateStep(i, {
												terminalStatus: step.terminalStatus === "success" ? undefined : "success",
												onSuccess: step.terminalStatus === "success" ? step.onSuccess : undefined,
											})}
											style={{
												padding: "2px 6px", fontSize: 10, borderRadius: 4, border: "1px solid",
												borderColor: step.terminalStatus === "success" ? "#22c55e" : "var(--border)",
												background: step.terminalStatus === "success" ? "#22c55e" : "var(--bg)",
												color: step.terminalStatus === "success" ? "#fff" : "var(--text-dim)",
												cursor: "pointer", whiteSpace: "nowrap",
											}}
										>End workflow</button>
									</div>
									{/* On Failure row */}
									<div style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
										<span style={{ fontSize: 10, color: "var(--text-muted)", minWidth: 60 }}>On failure:</span>
										<StepTargetChips
											steps={steps} currentIdx={i}
											selected={step.onFailure ?? []}
											onChange={(ids) => updateStep(i, {
												onFailure: ids.length > 0 ? ids : undefined,
											})}
										/>
										<button
											onClick={() => updateStep(i, {
												terminalStatus: step.terminalStatus === "failed" ? undefined : "failed",
												onFailure: step.terminalStatus === "failed" ? step.onFailure : undefined,
											})}
											style={{
												padding: "2px 6px", fontSize: 10, borderRadius: 4, border: "1px solid",
												borderColor: step.terminalStatus === "failed" ? "#ef4444" : "var(--border)",
												background: step.terminalStatus === "failed" ? "#ef4444" : "var(--bg)",
												color: step.terminalStatus === "failed" ? "#fff" : "var(--text-dim)",
												cursor: "pointer", whiteSpace: "nowrap",
											}}
										>End workflow</button>
									</div>
								</div>
							))}
						<button onClick={addStep} style={{ ...manageBtnStyle, marginTop: 4, fontSize: 11 }}>
							+ Add Step
						</button>

						<div style={{ display: "flex", gap: 8, marginTop: 12 }}>
							<button onClick={handleSave} disabled={saving || !dirty} style={createBtnStyle(saving, savedOk, dirty)}>
								{savedOk ? "Saved ✓" : saving ? "Saving..." : "Save"}
							</button>
							{selected && (
								<>
									<button onClick={handleExport} style={cancelBtnStyle}>Export</button>
									<button onClick={handleDelete} disabled={saving} style={{ ...cancelBtnStyle, color: "#ef4444" }}>
										Delete
									</button>
								</>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// --- Shared UI helpers ---

const dialogStyle: React.CSSProperties = {
	width: "90%", maxWidth: 640, maxHeight: "85vh",
	background: "var(--bg-panel)", border: "1px solid var(--border)",
	borderRadius: 14, overflow: "hidden",
	display: "flex", flexDirection: "column",
	boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
};

const headerStyle: React.CSSProperties = {
	padding: "16px 20px", borderBottom: "1px solid var(--border)",
	display: "flex", alignItems: "center", justifyContent: "space-between",
};

const bodyStyle: React.CSSProperties = {
	padding: "16px 20px", overflowY: "auto", flex: 1,
};

const footerStyle: React.CSSProperties = {
	padding: "12px 20px", borderTop: "1px solid var(--border)",
	display: "flex", justifyContent: "flex-end", gap: 8,
};

const closeBtnStyle: React.CSSProperties = {
	background: "none", border: "none", color: "var(--text-muted)",
	cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4,
};

const cancelBtnStyle: React.CSSProperties = {
	padding: "6px 14px", background: "none",
	border: "1px solid var(--border)", borderRadius: 7,
	color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
};

const manageBtnStyle: React.CSSProperties = {
	padding: "6px 12px", background: "var(--bg-hover)",
	border: "1px solid var(--border)", borderRadius: 7,
	color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
};

const inputStyle: React.CSSProperties = {
	width: "100%", padding: "6px 10px",
	background: "var(--bg)", border: "1px solid var(--border)",
	borderRadius: 7, color: "var(--text)", fontSize: 12,
	outline: "none", boxSizing: "border-box",
};

function createBtnStyle(saving: boolean, savedOk?: boolean, dirty?: boolean): React.CSSProperties {
	return {
		padding: "6px 14px",
		background: saving ? "var(--bg-hover)" : savedOk ? "rgba(74,222,128,0.18)" : dirty ? "var(--accent)" : "var(--bg-hover)",
		border: savedOk ? "1px solid rgba(74,222,128,0.4)" : "none",
		borderRadius: 7,
		color: saving ? "var(--text-muted)" : savedOk ? "#4ade80" : dirty ? "#fff" : "var(--text-dim)",
		cursor: saving || !dirty ? "default" : "pointer",
		fontSize: 12,
		fontWeight: 600,
		transition: "background 0.2s, color 0.2s, border-color 0.2s",
	};
}

function StepTargetChips({ steps, currentIdx, selected, onChange }: {
	steps: WorkflowDefinition["steps"];
	currentIdx: number;
	selected: string[];
	onChange: (ids: string[]) => void;
}) {
	const targets = steps.filter((_, si) => si !== currentIdx);
	if (targets.length === 0) {
		return <span style={{ fontSize: 10, color: "var(--text-dim)" }}>No other steps</span>;
	}
	return (
		<div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
			{targets.map((s) => {
				const active = selected.includes(s.id);
				return (
					<button
						key={s.id}
						onClick={() => {
							const next = active ? selected.filter((x) => x !== s.id) : [...selected, s.id];
							onChange(next);
						}}
						style={{
							padding: "2px 6px", fontSize: 10, borderRadius: 4, border: "1px solid",
							borderColor: active ? "var(--accent)" : "var(--border)",
							background: active ? "var(--accent)" : "var(--bg)",
							color: active ? "#fff" : "var(--text-muted)",
							cursor: "pointer",
						}}
					>
						{s.name || s.id}
					</button>
				);
			})}
		</div>
	);
}

function FormInput({ label, value, onChange, disabled, placeholder }: {
	label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string;
}) {
	return (
		<div style={{ marginBottom: 10 }}>
			<label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
				{label}:
			</label>
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
				placeholder={placeholder}
				style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }}
			/>
		</div>
	);
}

function FormTextarea({ label, value, onChange, rows, placeholder }: {
	label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string;
}) {
	return (
		<div style={{ marginBottom: 10 }}>
			<label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 3 }}>
				{label}:
			</label>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				rows={rows ?? 3}
				placeholder={placeholder}
				style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
			/>
		</div>
	);
}
