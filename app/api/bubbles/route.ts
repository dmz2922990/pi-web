import { NextRequest, NextResponse } from "next/server";
import { createBubble, listBubbles, loadTemplate } from "@/lib/bubble-store";
import { startBubble, getBubbleManager, restoreRunningBubbles } from "@/lib/bubble-manager";
import { getHost } from "@/lib/host-store";
import { getWorkflow } from "@/lib/workflow-store";
import { getWorker } from "@/lib/worker-store";
import { getWorkflowWorkerNames } from "@/lib/workflow-compiler";
import type { BubbleTemplate, SshConfig, WorkerDefinition } from "@/lib/bubble-types";

export const dynamic = "force-dynamic";

export async function GET() {
	await restoreRunningBubbles();
	const bubbles = listBubbles();
	const registry = (globalThis as Record<string, unknown>).__piSessions as
		| Map<string, { inner: { isStreaming: boolean } }>
		| undefined;

	const enriched = bubbles.map((b) => {
		const manager = getBubbleManager(b.id);
		if (!manager || !registry) return b;

		const gwWrapper = manager.getGatewayWrapper();
		const gatewayStreaming = gwWrapper?.isAlive()
			? gwWrapper.inner.isStreaming
			: false;

		const workerStates = b.workers.map((w) => {
			const wrapper = manager.getWorkerWrapper(w.sessionId);
			const isStreaming = wrapper?.isAlive()
				? wrapper.inner.isStreaming
				: false;
			return { ...w, isStreaming };
		});

		return { ...b, gatewayStreaming, workerStates };
	});

	return NextResponse.json({ bubbles: enriched });
}

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const { templateName, workflowName, cwd, environment = {}, message, model, hostSelections, name } = body as {
			templateName?: string;
			workflowName?: string;
			cwd?: string;
			environment?: Record<string, string>;
			message?: string;
			model?: { provider: string; modelId: string };
			hostSelections?: Record<string, string>;
		name?: string;
		};

		if ((!templateName && !workflowName) || !cwd) {
			return NextResponse.json(
				{ error: "templateName or workflowName, and cwd are required" },
				{ status: 400 },
			);
		}

		const bubble = createBubble(templateName ?? "", cwd, environment, name, workflowName);

		// Workflow mode: startBubble handles workflow resolution internally
		if (workflowName) {
			const manager = await startBubble(bubble.id, message, model, undefined, hostSelections);
			return NextResponse.json({
				bubble: {
					...bubble,
					gatewaySessionId: manager.getGatewaySessionId(),
					workers: manager.getWorkers(),
					status: manager.getStatus(),
				},
			});
		}

		// Template mode
		let template = loadTemplate(templateName!);
		if (template && hostSelections && Object.keys(hostSelections).length > 0) {
			template = applyHostSelections(template, hostSelections);
		}

		const manager = await startBubble(bubble.id, message, model, template ?? undefined);

		return NextResponse.json({
			bubble: {
				...bubble,
				gatewaySessionId: manager.getGatewaySessionId(),
				workers: manager.getWorkers(),
				status: manager.getStatus(),
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to create bubble";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

function applyHostSelections(
	template: BubbleTemplate,
	hostSelections: Record<string, string>,
): BubbleTemplate {
	// Deep clone to avoid mutating cached template
	const cloned: BubbleTemplate = JSON.parse(JSON.stringify(template));

	for (const role of cloned.roles) {
		const hostId = hostSelections[role.name];
		if (!hostId || hostId === "local") continue;

		const hostConfig = getHost(hostId);
		if (!hostConfig) continue;

		role.executionMode = "ssh";
		role.hostId = hostId;
		role.ssh = {
			host: hostConfig.host,
			port: hostConfig.port,
			user: hostConfig.user,
			password: hostConfig.password,
			privateKey: hostConfig.privateKey,
			remoteCwd: hostConfig.remoteCwd,
		} satisfies SshConfig;
	}

	return cloned;
}
