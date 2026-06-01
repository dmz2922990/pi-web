import { defineTool, createAgentSession, SessionManager, getAgentDir, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper, startRpcSession, getRpcSession } from "./rpc-manager";
import { cacheSessionPath, resolveSessionPath } from "./session-reader";
import type { Bubble, BubbleTemplate, BubbleWorker, SshConfig, WorkerResult } from "./bubble-types";
import { getBubble, updateBubble, loadTemplate, listBubbles } from "./bubble-store";
import { SshConnection } from "./ssh-operations";
import { createSshTools } from "./ssh-tool-factory";

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
	private template: BubbleTemplate;
	private gatewayWrapper: AgentSessionWrapper | null = null;
	private workerWrappers: Map<string, AgentSessionWrapper> = new Map();
	private sshConnections: SshConnection[] = [];
	private consecutiveFailures: Map<string, number> = new Map();

	constructor(bubble: Bubble, template: BubbleTemplate) {
		this.bubble = bubble;
		this.template = template;
	}

	async start(initialMessage?: string, runtimeModel?: { provider: string; modelId: string }): Promise<void> {
		const cwd = this.bubble.cwd;
		const agentDir = getAgentDir();

		// 1. Create worker sessions
		for (const role of this.template.roles) {
			await this.createWorker(role);
		}

		// 2. Build custom tools for gateway
		const invokeTools = this.template.roles.map((role) =>
			this.createInvokeTool(role),
		);
		const submitResultTool = this.createSubmitResultTool();
		const customTools = [...invokeTools, submitResultTool];

		// 3. Create gateway session
		const customToolNames = customTools.map((t) => t.name);
		const sessionManager = SessionManager.create(cwd, undefined);
		const gatewayPrompt = this.interpolateEnv(this.template.gateway.systemPrompt);

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

		// Apply model: runtime selection takes priority over template definition
		const modelSpec = runtimeModel ?? this.template.gateway.model;
		if (modelSpec) {
			const model = gatewayInner.modelRegistry.find(
				modelSpec.provider,
				modelSpec.modelId,
			);
			if (model) {
				await gatewayInner.setModel(model);
			}
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

	private async createWorker(role: BubbleTemplate["roles"][number]): Promise<string> {
		const cwd = this.bubble.cwd;
		const agentDir = getAgentDir();
		const registry = (globalThis as Record<string, unknown>).__piSessions as
			| Map<string, AgentSessionWrapper>
			| undefined;

		const interpolatedPrompt = this.interpolateEnv(role.systemPrompt);

		const workerLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			systemPromptOverride: () => interpolatedPrompt,
			appendSystemPromptOverride: () => [],
		});
		await workerLoader.reload();

		const workerSessionManager = SessionManager.create(cwd, undefined);

		let workerInner: Awaited<ReturnType<typeof createAgentSession>>["session"];

		if (role.executionMode === "ssh" && role.ssh) {
			const sshConfig = this.interpolateSshConfig(role.ssh);
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
				tools: role.tools,
			});
			workerInner = result.session;
		}

		const wrapper = new AgentSessionWrapper(workerInner, { noIdleTimeout: true });
		wrapper.start();

		const realSessionId = workerInner.sessionId as string;
		const realSessionFile = workerInner.sessionFile as string | undefined;
		if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

		wrapper.onDestroy(() => registry?.delete(realSessionId));
		registry?.set(realSessionId, wrapper);

		this.workerWrappers.set(realSessionId, wrapper);

		// Update or add the worker entry in bubble.workers
		const isRemote = role.executionMode === "ssh";
		const existingIdx = this.bubble.workers.findIndex((w) => w.roleName === role.name);
		const workerEntry = {
			roleName: role.name,
			sessionId: realSessionId,
			isRemote,
			sessionFile: realSessionFile,
			hostId: role.hostId,
		};
		if (existingIdx >= 0) {
			this.bubble.workers[existingIdx] = workerEntry;
		} else {
			this.bubble.workers.push(workerEntry);
		}

		return realSessionId;
	}

	private async ensureWorker(roleName: string): Promise<AgentSessionWrapper | null> {
		const role = this.template.roles.find((r) => r.name === roleName);
		if (!role) return null;

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
			await this.createWorker(role);
			updateBubble(this.bubble.id, { workers: this.bubble.workers });
			const entry = this.bubble.workers.find((w) => w.roleName === roleName);
			return entry ? this.workerWrappers.get(entry.sessionId) ?? null : null;
		} catch {
			return null;
		}
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

	getWorkerWrapper(sessionId: string): AgentSessionWrapper | null {
		return this.workerWrappers.get(sessionId) ?? null;
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

	createInvokeTool(role: BubbleTemplate["roles"][number]) {
		const manager = this;

		return defineTool({
			name: `invoke_${role.name}`,
			label: `Invoke ${role.label}`,
			description: `Call the ${role.label} worker. IMPORTANT: in the task parameter, include the COMPLETE output from previous workers — do NOT summarize or omit details. Pass full file paths, line numbers, code snippets, and error messages verbatim.`,
			parameters: {
				type: "object" as const,
				properties: {
					task: { type: "string" as const, description: "Detailed task description. MUST include the FULL verbatim output/results from previous workers, including all details (file paths, line numbers, code snippets, errors). Do NOT summarize previous worker results." },
					context: { type: "string" as const, description: "Brief 1-2 sentence summary of the overall workflow progress so far" },
				},
				required: ["task"],
			},
			promptSnippet: `invoke_${role.name}: Call the ${role.label} worker`,
			executionMode: "sequential" as const,
			execute: async (_toolCallId, params, _signal, onUpdate, _ctx) => {
				const timeoutMs = (role.timeoutMinutes ?? 10) * 60_000;
				const failures = manager.consecutiveFailures.get(role.name) ?? 0;

				// After 3 consecutive failures, force-recreate and try once more
				// but return a non-retryable error to stop Gateway from looping
				const forceRecreate = failures >= 3;

				const wrapper = await manager.ensureWorker(role.name);
				if (!wrapper) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({
							status: "failed",
							summary: `Worker '${role.label}' could not be created. The session may have crashed. Please try again or use submit_result to end the workflow.`,
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
					role.label,
					onUpdate,
					0,
				);

				if (result.status === "success") {
					manager.consecutiveFailures.delete(role.name);
				} else {
					manager.consecutiveFailures.set(role.name, failures + 1);

					// Force-recreate the worker on failure so next invocation is clean
					try {
						const entry = manager.bubble.workers.find((w) => w.roleName === role.name);
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
							text: `Workflow ${params.status}: ${params.summary}`,
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
): Promise<BubbleManager> {
	const existing = getManagers()[bubbleId];
	if (existing) return existing;

	const bubble = getBubble(bubbleId);
	if (!bubble) throw new Error(`Bubble ${bubbleId} not found`);

	const template = templateOverride ?? loadTemplate(bubble.templateName);
	if (!template) throw new Error(`Template ${bubble.templateName} not found`);

	const manager = new BubbleManager(bubble, template);
	await manager.start(message, model);

	return manager;
}

export function getBubbleManager(bubbleId: string): BubbleManager | undefined {
	return getManagers()[bubbleId];
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
	restorePromise = doRestore();
	try { await restorePromise; } finally { restorePromise = null; }
}

async function doRestore(): Promise<void> {
	const managers = getManagers();
	if (Object.keys(managers).length > 0) return; // Already restored

	const bubbles = listBubbles().filter((b) => b.status === "running");
	if (bubbles.length === 0) return;

	const registry = (globalThis as Record<string, unknown>).__piSessions as
		| Map<string, AgentSessionWrapper>
		| undefined;
	if (!registry) return;

	for (const bubble of bubbles) {
		const template = loadTemplate(bubble.templateName);
		if (!template) continue;

		const manager = new BubbleManager(bubble, template);

		// Restore worker sessions
		for (const worker of bubble.workers) {
			const role = template.roles.find((r) => r.name === worker.roleName);
			if (!role) continue;

			const sessionFile = worker.sessionFile ?? await resolveSessionPath(worker.sessionId);
			if (!sessionFile) continue;

			// Resolve SSH config: hostId (from bubble.json) → lookup hosts store → SshConfig
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
			// Fallback: template's role-level SSH config
			if (!workerSsh && role.executionMode === "ssh" && role.ssh) {
				workerSsh = role.ssh;
			}

			try {
				const workerSessionManager = SessionManager.open(sessionFile, undefined);
				const workerLoader = new DefaultResourceLoader({
					cwd: bubble.cwd,
					agentDir: getAgentDir(),
					systemPromptOverride: () => manager.interpolateEnv(role.systemPrompt),
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
						tools: role.tools,
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
					systemPromptOverride: () => manager.interpolateEnv(template.gateway.systemPrompt),
					appendSystemPromptOverride: () => [],
				});
				await gwLoader.reload();

				const invokeTools = template.roles.map((role) => manager.createInvokeTool(role));
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
