import type {
	WorkflowDefinition,
	WorkflowStep,
	WorkerDefinition,
} from "./bubble-types";

// --- Helpers ---

export function getWorkflowWorkerNames(workflow: WorkflowDefinition): string[] {
	const names = new Set(workflow.steps.map((s) => s.worker));
	return [...names];
}

export function validateWorkflow(
	workflow: WorkflowDefinition,
	workers: Record<string, WorkerDefinition>,
): { valid: boolean; missingWorkers: string[]; orphanSteps: string[] } {
	const missingWorkers: string[] = [];
	for (const name of getWorkflowWorkerNames(workflow)) {
		if (!workers[name]) missingWorkers.push(name);
	}

	const stepIds = new Set(workflow.steps.map((s) => s.id));
	const orphanSteps: string[] = [];
	for (const step of workflow.steps) {
		for (const target of [...(step.onSuccess ?? []), ...(step.onFailure ?? [])]) {
			if (!stepIds.has(target)) orphanSteps.push(`${step.id} → ${target}`);
		}
	}
	if (!stepIds.has(workflow.entryStep)) orphanSteps.push(`entry → ${workflow.entryStep}`);

	return { valid: missingWorkers.length === 0 && orphanSteps.length === 0, missingWorkers, orphanSteps };
}

// --- compileWorkflowToPrompt ---

export function compileWorkflowToPrompt(
	workflow: WorkflowDefinition,
	workers: Record<string, WorkerDefinition>,
): string {
	const parts: string[] = [];

	// 1. User-editable gateway prompt (prefix)
	parts.push(workflow.gatewayPrompt);

	// 2. Available workers
	parts.push("");
	parts.push("## Available Workers");
	const uniqueWorkers = getWorkflowWorkerNames(workflow);
	for (const name of uniqueWorkers) {
		const w = workers[name];
		parts.push(`- invoke_${name}: ${w?.label ?? name}`);
	}

	// 3. Execution flow (walk the graph from entryStep)
	parts.push("");
	parts.push("## Execution Flow");
	parts.push(`Entry step: ${stepLabel(workflow, workflow.entryStep)}`);
	parts.push("");

	const stepIds = new Set(workflow.steps.map((s) => s.id));
	const visited = new Set<string>();
	const stepsByOrder: WorkflowStep[] = [];
	collectStepsBfs(workflow, workflow.entryStep, visited, stepsByOrder);

	for (const step of stepsByOrder) {
		const worker = workers[step.worker];
		const toolName = `invoke_${step.worker}`;
		parts.push(`### ${step.name} (step ${step.id})`);
		parts.push(`Call ${toolName} (${worker?.label ?? step.worker})`);
		if (step.prompt) {
			parts.push(`Task: ${step.prompt}`);
		}

		if (step.terminalStatus) {
			parts.push(`This is a terminal step. If reached, call submit_result with status "${step.terminalStatus}".`);
		} else {
			const validSuccessIds = (step.onSuccess ?? []).filter((id) => stepIds.has(id));
			if (validSuccessIds.length > 0) {
				const targets = validSuccessIds.map((id) => stepLabel(workflow, id));
				if (validSuccessIds.length === 1) {
					parts.push(`On success: proceed to ${targets[0]}`);
				} else {
					parts.push(`On success: execute these in parallel — ${targets.join(", ")}`);
				}
			} else {
				parts.push(`On success: call submit_result with status "success" and a summary.`);
			}

			const validFailureIds = (step.onFailure ?? []).filter((id) => stepIds.has(id));
			if (validFailureIds.length > 0) {
				const targets = validFailureIds.map((id) => stepLabel(workflow, id));
				if (validFailureIds.length === 1) {
					parts.push(`On failure: proceed to ${targets[0]}`);
				} else {
					parts.push(`On failure: proceed to ${targets.join(", ")}`);
				}
			} else {
				parts.push(`On failure: call submit_result with status "failed" and an error summary.`);
			}
		}
		parts.push("");
	}

	// 4. Rules
	parts.push("## Critical Rules");
	parts.push("- When calling invoke tools, pass the COMPLETE output from previous workers in the context parameter — never summarize or abbreviate.");
	parts.push("- When multiple parallel workers complete, synthesize all their outputs before passing to the next step.");
	parts.push("- Call submit_result only when the workflow is truly done or an unrecoverable error occurs.");
	parts.push(`- Maximum iterations through the workflow: ${workflow.maxIterations}. If you detect a loop exceeding this limit, call submit_result with status "failed".`);

	return parts.join("\n");
}

function stepLabel(workflow: WorkflowDefinition, stepId: string): string {
	const step = workflow.steps.find((s) => s.id === stepId);
	return step ? `"${step.name}" (${step.id})` : stepId;
}

function collectStepsBfs(
	workflow: WorkflowDefinition,
	startId: string,
	visited: Set<string>,
	result: WorkflowStep[],
): void {
	const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));
	const queue = [startId];
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		const step = stepMap.get(id);
		if (!step) continue;
		result.push(step);
		for (const next of [...(step.onSuccess ?? []), ...(step.onFailure ?? [])]) {
			if (!visited.has(next) && stepMap.has(next)) queue.push(next);
		}
	}
	// Append unreachable steps so they still appear in the compiled prompt
	for (const step of workflow.steps) {
		if (!visited.has(step.id)) {
			visited.add(step.id);
			result.push(step);
		}
	}
}
