import { NextRequest, NextResponse } from "next/server";
import { getWorkflow } from "@/lib/workflow-store";
import { getWorker } from "@/lib/worker-store";
import { getWorkflowWorkerNames } from "@/lib/workflow-compiler";
import type { WorkflowBundle } from "@/lib/bubble-types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const name = request.nextUrl.searchParams.get("name");
	if (!name) {
		return NextResponse.json({ error: "name is required" }, { status: 400 });
	}

	const workflow = getWorkflow(name);
	if (!workflow) {
		return NextResponse.json({ error: `Workflow '${name}' not found` }, { status: 404 });
	}

	const workerNames = getWorkflowWorkerNames(workflow);
	const workers: Record<string, NonNullable<ReturnType<typeof getWorker>>> = {};
	for (const wn of workerNames) {
		const def = getWorker(wn);
		if (def) workers[wn] = def;
	}

	const bundle: WorkflowBundle = { version: 1, workflow, workers };
	return NextResponse.json(bundle);
}
