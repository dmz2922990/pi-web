import { defineTool, createAgentSession, SessionManager, getAgentDir, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper, startRpcSession, getRpcSession } from "./rpc-manager";
import { cacheSessionPath, resolveSessionPath } from "./session-reader";
import { cacheSystemPrompt } from "./system-prompt-cache";
import type { Bubble, BubbleTemplate, BubbleWorker, SshConfig, WorkerResult, WorkerDefinition, WorkflowDefinition } from "./bubble-types";
import { getBubble, updateBubble, loadTemplate, listBubbles, findBubbleBySessionId } from "./bubble-store";
import { SshConnection } from "./ssh-operations";
import { createSshTools } from "./ssh-tool-factory";
import { compileWorkflowToPrompt, getWorkflowWorkerNames } from "./workflow-compiler";
import { getWorkflow } from "./workflow-store";
import { getWorker } from "./worker-store";

// --- Internal unified worker config ---

interface WorkerInstanceConfig {
	name: string;
	label: string;
	systemPrompt: string;
	tools: string[];
	model?: { provider: string; modelId: string };
	timeoutMinutes?: number;
	executionMode?: "local" | "ssh";
	ssh?: SshConfig;
	hostId?: string;
}

// --- Registry ---

interface BubbleManagerMap {
	[id: string]: BubbleManager;
}

function getManagers(): BubbleManagerMap {
	if (!(globalThis as Record<string, unknown>).__piBubbleManagers) {
		(globalThis as Record<string, unknown>).__piBubbleManagers = {};
	}
	return (globalThis as Record<string, unknown>).__piBubbleManagers as BubbleManagerMap;
}

// --- BubbleManager ---

export class BubbleManager {
	private bubble: Bubble;
	private template: BubbleTemplate | null = null;
	private workflow: WorkflowDefinition | null = null;
	private workflowWorkers: Map<string, WorkerDefinition> = new Map();
	private workerConfigs: Map<string, WorkerInstanceConfig> = new Map();
	private gatewayWrapper: AgentSessionWrapper | null = null;
	private workerWrappers: Map<string, AgentSessionWrapper> = new Map();
	private sshConnections: SshConnection[] = [];
	private consecutiveFailures: Map<string, number> = new Map();

	constructor(bubble: Bubble, config: BubbleTemplate | { workflow: WorkflowDefinition; workers: Map<string, WorkerDefinition>; workerConfigs: Map<string, WorkerInstanceConfig> }) {
		this.bubble = bubble;
		if ("gateway" in config) {
			this.template = config;
		} else {
			this.workflow = config.workflow;
			this.workflowWorkers = config.workers;
			this.workerConfigs = config.workerConfigs;
		}
	}

	private isWorkflowMode(): boolean {
		return this.workflow !== null;
	}

	async start(initialMessage?: string, runtimeModel?: { provider: string; modelId: string }): Promise<void> {
		const cwd = this.bubble.cwd;
		const agentDir = getAgentDir();

		// 1. Resolve worker configs
		const configs = this.isWorkflowMode()
			? [...this.workerConfigs.values()]
			: this.template!.roles.map((role): WorkerInstanceConfig => ({
					name: role.name,
					label: role.label,
					systemPrompt: role.systemPrompt,
					tools: role.tools,
					model: role.model,
					timeoutMinutes: role.timeoutMinutes,
					executionMode: (role.executionMode === "ssh" ? "ssh" : undefined) as "local" | "ssh" | undefined,
					ssh: role.ssh,
					hostId: role.hostId,
				}));

		// 2. Create worker sessions
		for (const wc of configs) {
			await this.createWorkerFromConfig(wc);
		}

		// 3. Build invoke tools (one per unique worker name)
		const invokeTools = configs.map((wc) => this.createInvokeTool(wc));
		const submitResultTool = this.createSubmitResultTool();
		const customTools = [...invokeTools, submitResultTool];

		// 4. Build gateway prompt
		const customToolNames = customTools.map((t) => t.name);
		const sessionManager = SessionManager.create(cwd, undefined);
		let gatewayPrompt: string;

		if (this.isWorkflowMode()) {
			const workersObj: Record<string, WorkerDefinition> = {};
			for (const [name, w] of this.workflowWorkers) workersObj[name] = w;
			const wPaths: Record<string, string> = {};
			for (const [name, wc] of this.workerConfigs) {
				wPaths[name] = wc.ssh?.remoteCwd ?? this.bubble.cwd;
			}
			gatewayPrompt = this.interpolateEnv(
				compileWorkflowToPrompt(this.workflow!, workersObj, wPaths),
			);
		} else {
			gatewayPrompt = this.interpolateEnv(this.template!.gateway.systemPrompt);
		}

		// 5. Create gateway session
		const gatewayLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			systemPromptOverride: () => gatewayPrompt,
			appendSystemPromptOverride: () => [],
		});
		await gatewayLoader.reload();

		const { session: gatewayInner } = await createAgentSession({
			cwd,
			agentDir,
			resourceLoader: gatewayLoader,
			sessionManager,
			tools: customToolNames as unknown as string[],
			customTools,
		});

		// Apply model
		const modelSpec = runtimeModel ?? (this.template?.gateway.model);
		if (modelSpec) {
			gatewayInner.modelRegistry.authStorage.reload();
			const model = gatewayInner.modelRegistry.find(modelSpec.provider, modelSpec.modelId);
			if (model) await gatewayInner.setModel(model);
		}

		// Wrap gateway in AgentSessionWrapper and register in global session registry
		const registry = (globalThis as Record<string, unknown>).__piSessions as
			| Map<string, AgentSessionWrapper>
			| undefined;

		const gwWrapper = new AgentSessionWrapper(gatewayInner, { noIdleTimeout: true });
		gwWrapper.start();

		const gwSessionId = gatewayInner.sessionId as string;
		const gwSessionFile = gatewayInner.sessionFile as string | undefined;
		if (gwSessionFile) cacheSessionPath(gwSessionId, gwSessionFile);
		if (gatewayPrompt) cacheSystemPrompt(gwSessionId, gatewayPrompt);

		gwWrapper.onDestroy(() => registry?.delete(gwSessionId));
		registry?.set(gwSessionId, gwWrapper);

		this.gatewayWrapper = gwWrapper;
		this.bubble.gatewaySessionId = gwSessionId;
		if (gwSessionFile) this.bubble.gatewaySessionFile = gwSessionFile;

		// 4. Persist bubble with session IDs
		updateBubble(this.bubble.id, {
			gatewaySessionId: gwSessionId,
			gatewaySessionFile: gwSessionFile,
			workers: this.bubble.workers,
		});

		// 5. Register manager
		getManagers()[this.bubble.id] = this;

		// 6. Send initial message if provided
		if (initialMessage) {
			gatewayInner.prompt(initialMessage).catch(() => {});
		}
	}

	private async createWorkerFromConfig(wc: WorkerInstanceConfig): Promise<string> {
		const cwd = this.bubble.cwd;
		const agentDir = getAgentDir();
		const registry = (globalThis as Record<string, unknown>).__piSessions as
			| Map<string, AgentSessionWrapper>
			| undefined;

		const interpolatedPrompt = this.interpolateEnv(wc.systemPrompt);

		const workerLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			systemPromptOverride: () => interpolatedPrompt,
			appendSystemPromptOverride: () => [],
		});
		await workerLoader.reload();

		const workerSessionManager = SessionManager.create(cwd, undefined);

		let workerInner: Awaited<ReturnType<typeof createAgentSession>>["session"];

		if (wc.executionMode === "ssh" && wc.ssh) {
			const sshConfig = this.interpolateSshConfig(wc.ssh);
			const sshConn = new SshConnection(sshConfig);
			await sshConn.connect();
			this.sshConnections.push(sshConn);

			const workerCwd = sshConfig.remoteCwd ?? cwd;
			const sshToolInstances = createSshTools(workerCwd, sshConn);
			const sshToolNames = sshToolInstances.map((t) => t.name);

			const result = await createAgentSession({
				cwd: workerCwd,
				agentDir,
				resourceLoader: workerLoader,
				sessionManager: workerSessionManager,
				noTools: "builtin",
				tools: sshToolNames as unknown as string[],
				customTools: sshToolInstances,
			});
			workerInner = result.session;
		} else {
			const result = await createAgentSession({
				cwd,
				agentDir,
				resourceLoader: workerLoader,
				sessionManager: workerSessionManager,
				tools: wc.tools,
			});
			workerInner = result.session;
		}

		const wrapper = new AgentSessionWrapper(workerInner, { noIdleTimeout: true });
		wrapper.start();

		// Apply worker-specific model
		if (wc.model) {
			workerInner.modelRegistry.authStorage.reload();
			const wModel = workerInner.modelRegistry.find(wc.model.provider, wc.model.modelId);
			if (wModel) await workerInner.setModel(wModel);
		}

		const realSessionId = workerInner.sessionId as string;
		const realSessionFile = workerInner.sessionFile as string | undefined;
		if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
		if (interpolatedPrompt) cacheSystemPrompt(realSessionId, interpolatedPrompt);

		wrapper.onDestroy(() => registry?.delete(realSessionId));
		registry?.set(realSessionId, wrapper);

		this.workerWrappers.set(realSessionId, wrapper);

		// Update or add the worker entry in bubble.workers
		const isRemote = wc.executionMode === "ssh";
		const existingIdx = this.bubble.workers.findIndex((w) => w.roleName === wc.name);
		const workerEntry = {
			roleName: wc.name,
			workerName: this.isWorkflowMode() ? wc.name : undefined,
			sessionId: realSessionId,
			isRemote,
			sessionFile: realSessionFile,
			hostId: wc.hostId,
		};
		if (existingIdx >= 0) {
			this.bubble.workers[existingIdx] = workerEntry;
		} else {
			this.bubble.workers.push(workerEntry);
		}

		return realSessionId;
	}

	async ensureWorker(roleName: string): Promise<AgentSessionWrapper | null> {
		const wc = this.resolveWorkerConfig(roleName);
		if (!wc) return null;

		const workerEntry = this.bubble.workers.find((w) => w.roleName === roleName);
		if (workerEntry) {
			const existing = this.workerWrappers.get(workerEntry.sessionId);
			if (existing?.isAlive()) return existing;

			// Clean up dead wrapper
			if (existing) {
				this.workerWrappers.delete(workerEntry.sessionId);
			}
		}

		// Recreate the worker
		try {
			await this.createWorkerFromConfig(wc);
			updateBubble(this.bubble.id, { workers: this.bubble.workers });
			const entry = this.bubble.workers.find((w) => w.roleName === roleName);
			return entry ? this.workerWrappers.get(entry.sessionId) ?? null : null;
		} catch {
			return null;
		}
	}

	private resolveWorkerConfig(name: string): WorkerInstanceConfig | null {
		if (this.isWorkflowMode()) {
			return this.workerConfigs.get(name) ?? null;
		}
		const role = this.template!.roles.find((r) => r.name === name);
		if (!role) return null;
		return {
			name: role.name,
			label: role.label,
			systemPrompt: role.systemPrompt,
			tools: role.tools,
			model: role.model,
			timeoutMinutes: role.timeoutMinutes,
			executionMode: role.executionMode as "local" | "ssh" | undefined,
			ssh: role.ssh,
			hostId: role.hostId,
		};
	}

	getGatewaySessionId(): string {
		return this.bubble.gatewaySessionId;
	}

	getWorkers(): Bubble["workers"] {
		return this.bubble.workers;
	}

	getStatus(): Bubble["status"] {
		return this.bubble.status;
	}

	getGatewayWrapper(): AgentSessionWrapper | null {
		return this.gatewayWrapper;
	}

	setGatewayWrapper(wrapper: AgentSessionWrapper): void {
		this.gatewayWrapper = wrapper;
	}

	addWorkerWrapper(sessionId: string, wrapper: AgentSessionWrapper): void {
		this.workerWrappers.set(sessionId, wrapper);
	}

	addSshConnection(conn: SshConnection): void {
		this.sshConnections.push(conn);
	}

	async restoreWorkerSession(worker: BubbleWorker): Promise<AgentSessionWrapper | null> {
		const wc = this.resolveWorkerConfig(worker.roleName);
		if (!wc) return null;

		const registry = (globalThis as Record<string, unknown>).__piSessions as
			| Map<string, AgentSessionWrapper>
			| undefined;
		if (!registry) return null;

		// Already alive?
		const alive = this.workerWrappers.get(worker.sessionId);
		if (alive?.isAlive()) return alive;

		const sessionFile = worker.sessionFile ?? await resolveSessionPath(worker.sessionId);
		if (!sessionFile) return null;

		// Resolve SSH config
		let workerSsh: SshConfig | undefined;
		if (worker.hostId && worker.hostId !== "local") {
			const { getHost } = await import("./host-store");
			const hostConfig = getHost(worker.hostId);
			if (hostConfig) {
				workerSsh = {
					host: hostConfig.host,
					port: hostConfig.port,
					user: hostConfig.user,
					password: hostConfig.password,
					privateKey: hostConfig.privateKey,
					remoteCwd: hostConfig.remoteCwd,
				};
			}
		}
		if (!workerSsh && wc.executionMode === "ssh" && wc.ssh) {
			workerSsh = wc.ssh;
		}

		try {
			const workerSessionManager = SessionManager.open(sessionFile, undefined);
			const workerLoader = new DefaultResourceLoader({
				cwd: this.bubble.cwd,
				agentDir: getAgentDir(),
				systemPromptOverride: () => this.interpolateEnv(wc.systemPrompt),
				appendSystemPromptOverride: () => [],
			});
			await workerLoader.reload();

			let workerInner: Awaited<ReturnType<typeof createAgentSession>>["session"];

			if (workerSsh) {
				const sshConn = new SshConnection(workerSsh);
				await sshConn.connect();
				this.sshConnections.push(sshConn);

				const workerCwd = workerSsh.remoteCwd ?? this.bubble.cwd;
				const sshToolInstances = createSshTools(workerCwd, sshConn);
				const sshToolNames = sshToolInstances.map((t) => t.name);

				const result = await createAgentSession({
					cwd: workerCwd,
					agentDir: getAgentDir(),
					resourceLoader: workerLoader,
					sessionManager: workerSessionManager,
					noTools: "builtin",
					tools: sshToolNames as unknown as string[],
					customTools: sshToolInstances,
				});
				workerInner = result.session;
			} else {
				const result = await createAgentSession({
					cwd: this.bubble.cwd,
					agentDir: getAgentDir(),
					resourceLoader: workerLoader,
					sessionManager: workerSessionManager,
					tools: wc.tools,
				});
				workerInner = result.session;
			}

			// Apply worker-specific model
			if (wc.model) {
				workerInner.modelRegistry.authStorage.reload();
				const wModel = workerInner.modelRegistry.find(wc.model.provider, wc.model.modelId);
				if (wModel) await workerInner.setModel(wModel);
			}

			const wrapper = new AgentSessionWrapper(workerInner, { noIdleTimeout: true });
			wrapper.start();
			cacheSessionPath(workerInner.sessionId as string, sessionFile);
			if (wc.systemPrompt) cacheSystemPrompt(workerInner.sessionId as string, this.interpolateEnv(wc.systemPrompt));

			wrapper.onDestroy(() => registry.delete(workerInner.sessionId as string));
			registry.set(workerInner.sessionId as string, wrapper);
			this.workerWrappers.set(workerInner.sessionId as string, wrapper);

			return wrapper;
		} catch {
			return null;
		}
	}

	getWorkerWrapper(sessionId: string): AgentSessionWrapper | null {
		return this.workerWrappers.get(sessionId) ?? null;
	}

	async restoreGatewaySession(): Promise<AgentSessionWrapper | null> {
		if (this.gatewayWrapper?.isAlive()) return this.gatewayWrapper;

		const gwSessionFile = this.bubble.gatewaySessionFile ?? await resolveSessionPath(this.bubble.gatewaySessionId);
		if (!gwSessionFile) return null;

		const registry = (globalThis as Record<string, unknown>).__piSessions as
			| Map<string, AgentSessionWrapper>
			| undefined;
		if (!registry) return null;

		try {
			// Build invoke tools from current worker configs
			const configs = this.isWorkflowMode()
				? [...this.workerConfigs.values()]
				: this.template!.roles.map((role) => ({
						name: role.name,
						label: role.label,
						systemPrompt: role.systemPrompt,
						tools: role.tools,
						model: role.model,
						timeoutMinutes: role.timeoutMinutes,
						executionMode: role.executionMode as "local" | "ssh" | undefined,
						ssh: role.ssh,
						hostId: role.hostId,
					}));
			const invokeTools = configs.map((wc) => this.createInvokeTool(wc));
			const submitResultTool = this.createSubmitResultTool();
			const customTools = [...invokeTools, submitResultTool];
			const customToolNames = customTools.map((t) => t.name);

			// Build gateway prompt
			let gatewayPrompt: string;
			if (this.isWorkflowMode()) {
				const workersObj: Record<string, WorkerDefinition> = {};
				for (const [name, w] of this.workflowWorkers) workersObj[name] = w;
				const wPaths: Record<string, string> = {};
				for (const [name, wc] of this.workerConfigs) {
					wPaths[name] = wc.ssh?.remoteCwd ?? this.bubble.cwd;
				}
				gatewayPrompt = this.interpolateEnv(
					compileWorkflowToPrompt(this.workflow!, workersObj, wPaths),
				);
			} else {
				gatewayPrompt = this.interpolateEnv(this.template!.gateway.systemPrompt);
			}

			const gwSessionManager = SessionManager.open(gwSessionFile, undefined);
			const gwLoader = new DefaultResourceLoader({
				cwd: this.bubble.cwd,
				agentDir: getAgentDir(),
				systemPromptOverride: () => gatewayPrompt,
				appendSystemPromptOverride: () => [],
			});
			await gwLoader.reload();

			const { session: gwInner } = await createAgentSession({
				cwd: this.bubble.cwd,
				agentDir: getAgentDir(),
				resourceLoader: gwLoader,
				sessionManager: gwSessionManager,
				tools: customToolNames as unknown as string[],
				customTools,
			});

			const gwWrapper = new AgentSessionWrapper(gwInner, { noIdleTimeout: true });
			gwWrapper.start();
			cacheSessionPath(gwInner.sessionId as string, gwSessionFile);
			gwWrapper.onDestroy(() => registry.delete(gwInner.sessionId as string));
			registry.set(gwInner.sessionId as string, gwWrapper);
			this.setGatewayWrapper(gwWrapper);
			return gwWrapper;
		} catch {
			return null;
		}
	}

	async destroy(): Promise<void> {
		// Abort + destroy synchronously; abort() runs in background to avoid
		// hanging when a worker is stuck on SSH I/O.
		const aborts: Promise<void>[] = [];

		if (this.gatewayWrapper?.isAlive()) {
			aborts.push(this.gatewayWrapper.inner.abort().catch(() => {}));
			this.gatewayWrapper.destroy();
		}

		for (const [_, wrapper] of this.workerWrappers) {
			if (wrapper.isAlive()) {
				aborts.push(wrapper.inner.abort().catch(() => {}));
				wrapper.destroy();
			}
		}

		this.workerWrappers.clear();
		this.gatewayWrapper = null;

		for (const conn of this.sshConnections) {
			try { conn.disconnect(); } catch { /* ignore */ }
		}
		this.sshConnections = [];

		delete getManagers()[this.bubble.id];

		// Let background aborts settle, but don't block destroy() on them
		Promise.all(aborts).catch(() => {});
	}

	// --- Private Helpers ---

	interpolateEnv(prompt: string): string {
		return prompt.replace(/\{env\.(\w+)\}/g, (_, key: string) => {
			return this.bubble.environment[key] ?? "";
		});
	}

	interpolateSshConfig(config: SshConfig): SshConfig {
		const interpolate = (value: string | undefined): string | undefined =>
			value?.replace(/\{env\.(\w+)\}/g, (_, key: string) =>
				this.bubble.environment[key] ?? "");

		return {
			host: interpolate(config.host) ?? config.host,
			port: config.port,
			user: interpolate(config.user),
			privateKey: interpolate(config.privateKey),
			password: interpolate(config.password),
			remoteCwd: interpolate(config.remoteCwd),
		};
	}

	createInvokeTool(wc: WorkerInstanceConfig) {
		const manager = this;

		return defineTool({
			name: `invoke_${wc.name}`,
			label: `Invoke ${wc.label}`,
			description: `Call the ${wc.label} worker. IMPORTANT: in the task parameter, include the COMPLETE output from previous workers — do NOT summarize or omit details. Pass full file paths, line numbers, code snippets, and error messages verbatim.`,
			parameters: {
				type: "object" as const,
				properties: {
					task: { type: "string" as const, description: "Detailed task description. MUST include the FULL verbatim output/results from previous workers, including all details (file paths, line numbers, code snippets, errors). Do NOT summarize previous worker results." },
					context: { type: "string" as const, description: "Brief 1-2 sentence summary of the overall workflow progress so far" },
				},
				required: ["task"],
			},
			promptSnippet: `invoke_${wc.name}: Call the ${wc.label} worker`,
			executionMode: "sequential" as const,
			execute: async (_toolCallId, params, _signal, onUpdate, _ctx) => {
				// Reset bubble status to running when workflow re-executes
				if (manager.bubble.status !== "running") {
					manager.bubble.status = "running";
					manager.bubble.completedAt = undefined;
					manager.bubble.result = undefined;
					updateBubble(manager.bubble.id, { status: "running", completedAt: undefined, result: undefined });
				}
				const timeoutMs = (wc.timeoutMinutes ?? 10) * 60_000;
				const failures = manager.consecutiveFailures.get(wc.name) ?? 0;

				// After 3 consecutive failures, force-recreate and try once more
				// but return a non-retryable error to stop Gateway from looping
				const forceRecreate = failures >= 3;

				const wrapper = await manager.ensureWorker(wc.name);
				if (!wrapper) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({
							status: "failed",
							summary: `Worker '${wc.label}' could not be created. The session may have crashed. Please try again or use submit_result to end the workflow.`,
							error: "Session creation failed",
							retryable: true,
						} satisfies WorkerResult) }],
						details: {},
					};
				}

				const result = await manager.executeWorker(
					wrapper,
					params.task as string,
					params.context as string | undefined,
					timeoutMs,
					wc.label,
					onUpdate,
					0,
				);

				if (result.status === "success") {
					manager.consecutiveFailures.delete(wc.name);
				} else {
					manager.consecutiveFailures.set(wc.name, failures + 1);

					// Force-recreate the worker on failure so next invocation is clean
					try {
						const entry = manager.bubble.workers.find((w) => w.roleName === wc.name);
						if (entry) {
							const dead = manager.workerWrappers.get(entry.sessionId);
							if (dead) {
								try { await dead.inner.abort(); } catch { /* ignore */ }
								dead.destroy();
								manager.workerWrappers.delete(entry.sessionId);
							}
						}
					} catch { /* ignore */ }

					// After repeated failures, tell Gateway to stop retrying
					if (forceRecreate || failures + 1 >= 3) {
						result.retryable = false;
						result.summary += ` STOP RETRYING: This worker has failed ${failures + 1} times. Use submit_result to end the workflow, or try a different approach.`;
					}
				}

				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					details: result,
				};
			},
		});
	}

	private async executeWorker(
		wrapper: AgentSessionWrapper,
		task: string,
		context: string | undefined,
		timeoutMs: number,
		roleLabel: string,
		onUpdate:
			| ((result: {
					content: { type: "text"; text: string }[];
					details: unknown;
			  }) => void)
			| undefined,
		attempt: number,
	): Promise<WorkerResult> {
		const fullPrompt = context
			? `${task}\n\nContext from previous steps:\n${context}`
			: task;

		const attemptLabel = attempt > 0 ? ` (retry #${attempt})` : "";

		return new Promise<WorkerResult>((resolve) => {
			let resolved = false;

			const timer = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					resolve({
						status: "failed",
						summary: `${roleLabel} timed out after ${timeoutMs / 1000}s${attemptLabel}`,
						error: `Worker did not respond within ${timeoutMs / 1000} seconds. The model API may be slow or unresponsive.`,
						retryable: true,
					});
					// Cleanup in background — abort() may hang if the underlying tool is stuck on I/O
					wrapper.inner.abort().catch(() => {});
					try { wrapper.destroy(); } catch { /* ignore */ }
				}
			}, timeoutMs);

			const unsubscribe = wrapper.onEvent((event: Record<string, unknown>) => {
				if (event.type === "agent_end" && !resolved) {
					resolved = true;
					clearTimeout(timer);
					unsubscribe();

					const result = this.extractWorkerResult(wrapper);
					resolve(result);
				}

				if (event.type === "error" && !resolved) {
					resolved = true;
					clearTimeout(timer);
					unsubscribe();
					const errMsg = (event.error as string) || (event.message as string) || "Unknown error";
					resolve({
						status: "failed",
						summary: `${roleLabel} encountered an error${attemptLabel}`,
						error: errMsg,
						retryable: true,
					});
				}
			});

			onUpdate?.({
				content: [
					{ type: "text", text: `${roleLabel}${attemptLabel} is working on: ${task.slice(0, 100)}...` },
				],
				details: { phase: "running", workerRole: roleLabel },
			});

			wrapper.inner.prompt(fullPrompt).catch((err) => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timer);
					unsubscribe();
					const errMsg = err instanceof Error ? err.message : String(err);
					resolve({
						status: "failed",
						summary: `${roleLabel} failed: ${errMsg || "unknown error"}`,
						error: errMsg,
						retryable: true,
					});
				}
			});
		});
	}

	private extractWorkerResult(wrapper: AgentSessionWrapper): WorkerResult {
		const sessionFile = wrapper.inner.sessionFile;
		if (!sessionFile) {
			return { status: "failed", summary: "No session file available" };
		}

		try {
			const sm = SessionManager.open(sessionFile);
			const entries = sm.getEntries();

			if (!entries || entries.length === 0) {
				return { status: "failed", summary: "No output from worker" };
			}

			// Find the last assistant message
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as unknown as Record<string, unknown>;
				if (entry.type === "message") {
					const message = entry.message as Record<string, unknown>;
					if (message?.role === "assistant") {
						const content = message.content as Array<Record<string, unknown>>;
						const textParts = content
							?.filter((c) => c.type === "text")
							.map((c) => c.text as string)
							.filter(Boolean);

						if (textParts?.length) {
							return {
								status: "success",
								summary: textParts.join("\n"),
							};
						}
					}
				}
			}
		} catch {
			// Fall through to default
		}

		return { status: "success", summary: "Worker completed" };
	}

	createSubmitResultTool() {
		const bubbleId = this.bubble.id;

		return defineTool({
			name: "submit_result",
			label: "Submit Result",
			description:
				"Submit the final result of the workflow. Call this when all tasks are completed or when an unrecoverable error occurs.",
			parameters: {
				type: "object" as const,
				properties: {
					status: {
						enum: ["success", "failed"] as const,
						description: "Result status",
					},
					summary: {
						type: "string" as const,
						description: "Final result summary",
					},
				},
				required: ["status", "summary"],
			},
			promptSnippet: "submit_result: Submit the final workflow result",
			executionMode: "sequential" as const,
			execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
				const now = new Date().toISOString();
				updateBubble(bubbleId, {
					status: params.status === "success" ? "completed" : "failed",
					completedAt: now,
					result: {
						status: params.status as "success" | "failed",
						summary: params.summary as string,
					},
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ status: params.status, summary: params.summary }),
						},
					],
					details: { bubbleId, status: params.status },
					terminate: true,
				};
			},
		});
	}
}

// --- Module-level helpers ---

export async function startBubble(
	bubbleId: string,
	message?: string,
	model?: { provider: string; modelId: string },
	templateOverride?: BubbleTemplate,
	hostSelections?: Record<string, string>,
	workerModels?: Record<string, { provider: string; modelId: string }>,
): Promise<BubbleManager> {
	const existing = getManagers()[bubbleId];
	if (existing) return existing;

	const bubble = getBubble(bubbleId);
	if (!bubble) throw new Error(`Bubble ${bubbleId} not found`);

	let config: BubbleTemplate | { workflow: WorkflowDefinition; workers: Map<string, WorkerDefinition>; workerConfigs: Map<string, WorkerInstanceConfig> };

	if (bubble.workflowName) {
		const { getWorkflow: loadWf } = await import("./workflow-store");
		const { getWorker: loadWk } = await import("./worker-store");
		const { getHost } = await import("./host-store");
		const workflow = loadWf(bubble.workflowName);
		if (!workflow) throw new Error(`Workflow ${bubble.workflowName} not found`);

		const workerNames = getWorkflowWorkerNames(workflow);
		const workersMap = new Map<string, WorkerDefinition>();
		const workerConfigsMap = new Map<string, WorkerInstanceConfig>();

		for (const name of workerNames) {
			const w = loadWk(name);
			if (!w) throw new Error(`Worker ${name} not found`);
			workersMap.set(name, w);

			const hostId = hostSelections?.[name];
			let executionMode: "local" | "ssh" | undefined;
			let ssh: SshConfig | undefined;
			let resolvedHostId: string | undefined;

			if (hostId && hostId !== "local") {
				const hostConfig = getHost(hostId);
				if (hostConfig) {
					executionMode = "ssh";
					ssh = {
						host: hostConfig.host,
						port: hostConfig.port,
						user: hostConfig.user,
						password: hostConfig.password,
						privateKey: hostConfig.privateKey,
						remoteCwd: hostConfig.remoteCwd,
					};
					resolvedHostId = hostId;
				}
			}

			workerConfigsMap.set(name, {
				name: w.name,
				label: w.label,
				systemPrompt: w.systemPrompt,
				tools: w.tools,
				model: workerModels?.[name] ?? w.model,
				timeoutMinutes: w.timeoutMinutes,
				executionMode,
				ssh,
				hostId: resolvedHostId,
			});
		}

		config = { workflow, workers: workersMap, workerConfigs: workerConfigsMap };
	} else {
		const template = templateOverride ?? loadTemplate(bubble.templateName);
		if (!template) throw new Error(`Template ${bubble.templateName} not found`);
		config = template;
	}

	const manager = new BubbleManager(bubble, config);
	await manager.start(message, model);

	return manager;
}

export function getBubbleManager(bubbleId: string): BubbleManager | undefined {
	return getManagers()[bubbleId];
}

export function isBubbleRemoteSession(sessionId: string): boolean {
	const bubble = findBubbleBySessionId(sessionId);
	if (!bubble) return false;
	const worker = bubble.workers.find((w) => w.sessionId === sessionId);
	return worker?.isRemote === true;
}

async function ensureManager(bubble: Bubble): Promise<BubbleManager | null> {
	const existing = getManagers()[bubble.id];
	if (existing) return existing;

	// Build manager from bubble config (same logic as doRestore)
	let manager: BubbleManager;
	let workerConfigs: Map<string, WorkerInstanceConfig>;

	if (bubble.workflowName) {
		const workflow = getWorkflow(bubble.workflowName);
		if (!workflow) return null;
		const workerNames = getWorkflowWorkerNames(workflow);
		const workerDefsMap = new Map<string, WorkerDefinition>();
		const configs = new Map<string, WorkerInstanceConfig>();
		for (const name of workerNames) {
			const def = getWorker(name);
			if (def) {
				workerDefsMap.set(name, def);
				configs.set(name, {
					name: def.name,
					label: def.label,
					systemPrompt: def.systemPrompt,
					tools: def.tools,
					model: def.model,
					timeoutMinutes: def.timeoutMinutes,
				});
			}
		}
		manager = new BubbleManager(bubble, { workflow, workers: workerDefsMap, workerConfigs: configs });
		workerConfigs = configs;
	} else {
		const template = loadTemplate(bubble.templateName);
		if (!template) return null;
		manager = new BubbleManager(bubble, template);
		workerConfigs = new Map();
		for (const role of template.roles) {
			workerConfigs.set(role.name, {
				name: role.name,
				label: role.label,
				systemPrompt: role.systemPrompt,
				tools: role.tools,
				model: role.model,
				timeoutMinutes: role.timeoutMinutes,
				executionMode: role.executionMode as "local" | "ssh" | undefined,
				ssh: role.ssh,
				hostId: role.hostId,
			});
		}
	}

	// Restore gateway: reuse if alive, otherwise rebuild from session file
	const registry = (globalThis as Record<string, unknown>).__piSessions as
		| Map<string, AgentSessionWrapper>
		| undefined;
	const gwSession = registry?.get(bubble.gatewaySessionId);
	if (gwSession?.isAlive()) {
		manager.setGatewayWrapper(gwSession);
	} else if (bubble.gatewaySessionId) {
		await manager.restoreGatewaySession();
	}

	// Restore existing alive workers
	for (const worker of bubble.workers) {
		const wSession = registry?.get(worker.sessionId);
		if (wSession?.isAlive()) {
			manager.addWorkerWrapper(worker.sessionId, wSession);
		}
	}

	getManagers()[bubble.id] = manager;
	return manager;
}

export async function restoreBubbleSession(sessionId: string): Promise<AgentSessionWrapper | null> {
	const registry = (globalThis as Record<string, unknown>).__piSessions as
		| Map<string, AgentSessionWrapper>
		| undefined;
	if (!registry) return null;

	// Already restored?
	const existing = registry.get(sessionId);
	if (existing?.isAlive()) return existing;

	const bubble = findBubbleBySessionId(sessionId);
	if (!bubble) return null;

	// Gateway session
	if (bubble.gatewaySessionId === sessionId) {
		const mgr = await ensureManager(bubble);
		return mgr?.getGatewayWrapper() ?? null;
	}

	// Worker session — find which role this sessionId belongs to
	const workerEntry = bubble.workers.find((w) => w.sessionId === sessionId);
	console.log("[restoreBubbleSession] workerEntry=", workerEntry ? workerEntry.roleName : null, "isRemote=", workerEntry?.isRemote, "hostId=", workerEntry?.hostId);
	if (!workerEntry) return null;

	const mgr = await ensureManager(bubble);
	console.log("[restoreBubbleSession] mgr=", !!mgr);
	if (!mgr) return null;

	const restored = await mgr.restoreWorkerSession(workerEntry);
	console.log("[restoreBubbleSession] restored=", !!restored);
	return restored;
}

export async function stopBubble(bubbleId: string): Promise<void> {
	const manager = getManagers()[bubbleId];
	if (manager) {
		await manager.destroy();
	}
}

// --- Restore running bubbles after server restart ---

let restorePromise: Promise<void> | null = null;

export async function restoreRunningBubbles(): Promise<void> {
	if (restorePromise) return restorePromise;
	const { migrateTemplatesIfNeeded } = await import("./template-migrator");
	migrateTemplatesIfNeeded();
	restorePromise = doRestore();
	try { await restorePromise; } finally { restorePromise = null; }
}

async function doRestore(): Promise<void> {
	const managers = getManagers();
	if (Object.keys(managers).length > 0) return;

	const bubbles = listBubbles().filter((b) => b.status === "running");
	if (bubbles.length === 0) return;

	const registry = (globalThis as Record<string, unknown>).__piSessions as
		| Map<string, AgentSessionWrapper>
		| undefined;
	if (!registry) return;

	for (const bubble of bubbles) {
		// Determine mode: workflow or template
		let manager: BubbleManager;
		let workerConfigs: Map<string, WorkerInstanceConfig>;
		let gatewayPrompt: string;
		let invokeConfigs: WorkerInstanceConfig[];

		if (bubble.workflowName) {
			const workflow = getWorkflow(bubble.workflowName);
			if (!workflow) continue;
			const workerNames = getWorkflowWorkerNames(workflow);
			const workerDefsMap = new Map<string, WorkerDefinition>();
			const workerDefsRecord: Record<string, WorkerDefinition> = {};
			const configs = new Map<string, WorkerInstanceConfig>();
			for (const name of workerNames) {
				const def = getWorker(name);
				if (def) {
					workerDefsMap.set(name, def);
					workerDefsRecord[name] = def;
					configs.set(name, {
						name: def.name,
						label: def.label,
						systemPrompt: def.systemPrompt,
						tools: def.tools,
						model: def.model,
						timeoutMinutes: def.timeoutMinutes,
					});
				}
			}
			manager = new BubbleManager(bubble, { workflow, workers: workerDefsMap, workerConfigs: configs });
			workerConfigs = configs;
			gatewayPrompt = compileWorkflowToPrompt(workflow, workerDefsRecord);
			invokeConfigs = workerNames
				.map((n) => configs.get(n))
				.filter((c): c is WorkerInstanceConfig => c !== undefined);
		} else {
			const template = loadTemplate(bubble.templateName);
			if (!template) continue;
			manager = new BubbleManager(bubble, template);
			workerConfigs = new Map();
			for (const role of template.roles) {
				workerConfigs.set(role.name, {
					name: role.name,
					label: role.label,
					systemPrompt: role.systemPrompt,
					tools: role.tools,
					model: role.model,
					timeoutMinutes: role.timeoutMinutes,
					executionMode: role.executionMode as "local" | "ssh" | undefined,
					ssh: role.ssh,
					hostId: role.hostId,
				});
			}
			gatewayPrompt = template.gateway.systemPrompt;
			invokeConfigs = template.roles.map((role) => ({
				name: role.name,
				label: role.label,
				systemPrompt: role.systemPrompt,
				tools: role.tools,
				model: role.model,
				timeoutMinutes: role.timeoutMinutes,
				executionMode: role.executionMode as "local" | "ssh" | undefined,
				ssh: role.ssh,
				hostId: role.hostId,
			}));
		}

		// Restore worker sessions
		for (const worker of bubble.workers) {
			const wc = workerConfigs.get(worker.roleName);
			if (!wc) continue;

			const sessionFile = worker.sessionFile ?? await resolveSessionPath(worker.sessionId);
			if (!sessionFile) continue;

			let workerSsh: SshConfig | undefined;
			if (worker.hostId && worker.hostId !== "local") {
				const { getHost } = await import("./host-store");
				const hostConfig = getHost(worker.hostId);
				if (hostConfig) {
					workerSsh = {
						host: hostConfig.host,
						port: hostConfig.port,
						user: hostConfig.user,
						password: hostConfig.password,
						privateKey: hostConfig.privateKey,
						remoteCwd: hostConfig.remoteCwd,
					};
				}
			}
			if (!workerSsh && wc.executionMode === "ssh" && wc.ssh) {
				workerSsh = wc.ssh;
			}

			try {
				const workerSessionManager = SessionManager.open(sessionFile, undefined);
				const workerLoader = new DefaultResourceLoader({
					cwd: bubble.cwd,
					agentDir: getAgentDir(),
					systemPromptOverride: () => manager.interpolateEnv(wc.systemPrompt),
					appendSystemPromptOverride: () => [],
				});
				await workerLoader.reload();

				let workerInner: Awaited<ReturnType<typeof createAgentSession>>["session"];

				if (workerSsh) {
					const sshConn = new SshConnection(workerSsh);
					await sshConn.connect();
					manager.addSshConnection(sshConn);

					const workerCwd = workerSsh.remoteCwd ?? bubble.cwd;
					const sshToolInstances = createSshTools(workerCwd, sshConn);
					const sshToolNames = sshToolInstances.map((t) => t.name);

					const result = await createAgentSession({
						cwd: workerCwd,
						agentDir: getAgentDir(),
						resourceLoader: workerLoader,
						sessionManager: workerSessionManager,
						noTools: "builtin",
						tools: sshToolNames as unknown as string[],
						customTools: sshToolInstances,
					});
					workerInner = result.session;
				} else {
					const result = await createAgentSession({
						cwd: bubble.cwd,
						agentDir: getAgentDir(),
						resourceLoader: workerLoader,
						sessionManager: workerSessionManager,
						tools: wc.tools,
					});
					workerInner = result.session;
				}

				const wrapper = new AgentSessionWrapper(workerInner, { noIdleTimeout: true });
				wrapper.start();
				cacheSessionPath(workerInner.sessionId as string, sessionFile);
				wrapper.onDestroy(() => registry.delete(workerInner.sessionId as string));
				registry.set(workerInner.sessionId as string, wrapper);
				manager.addWorkerWrapper(workerInner.sessionId as string, wrapper);
			} catch {
				// Worker restore failed
			}
		}

		// Restore gateway session
		const gwSessionFile = bubble.gatewaySessionFile ?? await resolveSessionPath(bubble.gatewaySessionId);
		if (gwSessionFile) {
			try {
				const gwSessionManager = SessionManager.open(gwSessionFile, undefined);
				const gwLoader = new DefaultResourceLoader({
					cwd: bubble.cwd,
					agentDir: getAgentDir(),
					systemPromptOverride: () => manager.interpolateEnv(gatewayPrompt),
					appendSystemPromptOverride: () => [],
				});
				await gwLoader.reload();

				const invokeTools = invokeConfigs.map((wc) => manager.createInvokeTool(wc));
				const submitResultTool = manager.createSubmitResultTool();
				const customTools = [...invokeTools, submitResultTool];
				const customToolNames = customTools.map((t) => t.name);

				const { session: gwInner } = await createAgentSession({
					cwd: bubble.cwd,
					agentDir: getAgentDir(),
					resourceLoader: gwLoader,
					sessionManager: gwSessionManager,
					tools: customToolNames as unknown as string[],
					customTools,
				});

				const gwWrapper = new AgentSessionWrapper(gwInner, { noIdleTimeout: true });
				gwWrapper.start();
				cacheSessionPath(gwInner.sessionId as string, gwSessionFile);
				gwWrapper.onDestroy(() => registry.delete(gwInner.sessionId as string));
				registry.set(gwInner.sessionId as string, gwWrapper);
				manager.setGatewayWrapper(gwWrapper);
			} catch {
				// Gateway restore failed — bubble is partially restored
			}
		}

		managers[bubble.id] = manager;
	}
}
