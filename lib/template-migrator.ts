import type {
	BubbleTemplate,
	BubbleRole,
	WorkerDefinition,
	WorkflowDefinition,
} from "./bubble-types";
import { listWorkers, getWorker, createWorker } from "./worker-store";
import { listWorkflows, getWorkflow, createWorkflow } from "./workflow-store";

export function migrateTemplate(
	template: BubbleTemplate,
): { workflow: WorkflowDefinition; workers: WorkerDefinition[] } {
	const workers: WorkerDefinition[] = template.roles.map((role: BubbleRole) => ({
		name: role.name,
		label: role.label,
		systemPrompt: role.systemPrompt,
		tools: role.tools,
		model: role.model,
		timeoutMinutes: role.timeoutMinutes,
	}));

	const steps = template.roles.map((role: BubbleRole, i: number) => {
		const isLast = i === template.roles.length - 1;
		const nextId = !isLast ? `step_${i + 2}` : undefined;
		return {
			id: `step_${i + 1}`,
			name: role.label,
			worker: role.name,
			...(isLast ? { terminalStatus: "success" as const } : {}),
			...(!isLast ? { onSuccess: [nextId!] } : {}),
			...(!isLast ? { onFailure: [{ terminalStatus: "failed" as const }] as never } : {}),
		};
	});

	// Clean up steps — onFailure without valid target just means implicit terminal
	for (const step of steps) {
		if (Array.isArray((step as Record<string, unknown>).onFailure)) {
			delete (step as Record<string, unknown>).onFailure;
		}
	}

	const workflow: WorkflowDefinition = {
		name: template.name,
		label: template.name,
		description: template.description,
		gatewayPrompt: template.gateway.systemPrompt,
		maxIterations: 10,
		environment: template.environment,
		steps,
		entryStep: "step_1",
	};

	return { workflow, workers };
}

export function migrateTemplatesIfNeeded(): void {
	const existingWorkers = new Set(listWorkers().map((w) => w.name));
	const existingWorkflows = new Set(listWorkflows().map((w) => w.name));

	// Load templates from disk
	const { loadTemplates } = require("./bubble-store");
	const templates = loadTemplates() as BubbleTemplate[];

	for (const template of templates) {
		if (existingWorkflows.has(template.name)) continue;

		const { workflow, workers } = migrateTemplate(template);

		for (const worker of workers) {
			if (!existingWorkers.has(worker.name)) {
				createWorker(worker);
				existingWorkers.add(worker.name);
			}
		}

		createWorkflow(workflow);
		existingWorkflows.add(workflow.name);
	}
}
