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
	sessionId: string;
}

export interface BubbleResult {
	status: "success" | "failed";
	summary: string;
}

export interface Bubble {
	id: string;
	templateName: string;
	cwd: string;
	status: BubbleStatus;
	gatewaySessionId: string;
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
	files?: string[];
}
