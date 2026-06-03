import { NextRequest, NextResponse } from "next/server";
import { getWorkflow, createWorkflow } from "@/lib/workflow-store";
import { getWorker, createWorker } from "@/lib/worker-store";
import type { WorkflowBundle } from "@/lib/bubble-types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
	try {
		const bundle = await request.json() as WorkflowBundle;

		if (!bundle.workflow || !bundle.workers) {
			return NextResponse.json({ error: "Invalid bundle: missing workflow or workers" }, { status: 400 });
		}

		const imported: { workers: string[]; workflow: string | null; skipped: string[] } = {
			workers: [],
			workflow: null,
			skipped: [],
		};

		for (const [name, workerDef] of Object.entries(bundle.workers)) {
			if (getWorker(name)) {
				imported.skipped.push(`worker:${name}`);
			} else {
				createWorker(workerDef);
				imported.workers.push(name);
			}
		}

		if (getWorkflow(bundle.workflow.name)) {
			imported.skipped.push(`workflow:${bundle.workflow.name}`);
		} else {
			createWorkflow(bundle.workflow);
			imported.workflow = bundle.workflow.name;
		}

		return NextResponse.json({ imported });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to import bundle";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
