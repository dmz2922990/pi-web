// --- Worker Definition (independent, reusable agent) ---

export interface WorkerDefinition {
  name: string;
  label: string;
  systemPrompt: string;
  tools: string[];
  model?: { provider: string; modelId: string };
  timeoutMinutes?: number;
  environment?: BubbleEnvironmentField[];
}

// --- Workflow ---

export interface WorkflowStep {
  id: string;
  name: string;
  worker: string;
  prompt?: string;
  terminalStatus?: "success" | "failed";
  onSuccess?: string[];
  onFailure?: string[];
}

export interface WorkflowDefinition {
  name: string;
  label: string;
  description?: string;
  gatewayPrompt: string;
  maxIterations: number;
  environment?: BubbleEnvironmentField[];
  steps: WorkflowStep[];
  entryStep: string;
}

export interface WorkflowBundle {
  version: 1;
  workflow: WorkflowDefinition;
  workers: Record<string, WorkerDefinition>;
}

// --- SSH Configuration ---

export interface SshConfig {
	host: string;
	port?: number;
	user?: string;
	privateKey?: string;
	password?: string;
	remoteCwd?: string;
}

// --- Bubble Template ---

export interface BubbleEnvironmentField {
	key: string;
	label: string;
	type: "path" | "string";
	default?: string;
}

export interface BubbleRole {
	name: string;
	label: string;
	systemPrompt: string;
	tools: string[];
	model?: { provider: string; modelId: string };
	timeoutMinutes?: number;
	executionMode?: "local" | "ssh" | "remote";
	ssh?: SshConfig;
	hostId?: string;
}

export interface BubbleGateway {
	systemPrompt: string;
	model?: { provider: string; modelId: string };
}

export interface BubbleTemplate {
	name: string;
	description: string;
	gateway: BubbleGateway;
	roles: BubbleRole[];
	environment?: BubbleEnvironmentField[];
}

// --- Bubble Instance ---

export type BubbleStatus = "running" | "completed" | "failed";

export interface BubbleWorker {
	roleName: string;
		workerName?: string;
	sessionId: string;
	isRemote?: boolean;
	sessionFile?: string;
	hostId?: string;
}

export interface BubbleResult {
	status: "success" | "failed";
	summary: string;
}

export interface Bubble {
	id: string;
	name: string;
	templateName: string;
	workflowName?: string;
	cwd: string;
	status: BubbleStatus;
	gatewaySessionId: string;
	gatewaySessionFile?: string;
	workers: BubbleWorker[];
	environment: Record<string, string>;
	createdAt: string;
	completedAt?: string;
	result?: BubbleResult;
}

// --- Tool Parameters (plain JSON Schema objects for defineTool) ---

export const InvokeToolParamsSchema = {
	type: "object" as const,
	properties: {
		task: { type: "string" as const, description: "Task description for the worker" },
		context: { type: "string" as const, description: "Summary from previous steps" },
	},
	required: ["task"],
};

export const SubmitResultParamsSchema = {
	type: "object" as const,
	properties: {
		status: { enum: ["success", "failed"] as const, description: "Result status" },
		summary: { type: "string" as const, description: "Final result summary" },
	},
	required: ["status", "summary"],
};

export interface InvokeToolParams {
	task: string;
	context?: string;
}

export interface SubmitResultParams {
	status: "success" | "failed";
	summary: string;
}

// --- Worker Result ---

export interface WorkerResult {
	status: "success" | "failed";
	summary: string;
	error?: string;
	retryable?: boolean;
	files?: string[];
}
