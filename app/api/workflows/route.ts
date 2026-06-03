import { NextRequest, NextResponse } from "next/server";
import { listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow, saveAllWorkflows } from "@/lib/workflow-store";
import { migrateTemplatesIfNeeded } from "@/lib/template-migrator";
import type { WorkflowDefinition } from "@/lib/bubble-types";

export const dynamic = "force-dynamic";

export async function GET() {
	migrateTemplatesIfNeeded();
	const workflows = listWorkflows();
	return NextResponse.json({ workflows });
}

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const { action, workflow, workflows } = body as {
			action?: "create" | "saveAll";
			workflow?: WorkflowDefinition;
			workflows?: WorkflowDefinition[];
		};

		if (action === "saveAll" && workflows) {
			saveAllWorkflows(workflows);
			return NextResponse.json({ ok: true });
		}

		if (workflow) {
			const existing = getWorkflow(workflow.name);
			if (existing) {
				return NextResponse.json({ error: `Workflow '${workflow.name}' already exists` }, { status: 409 });
			}
			const created = createWorkflow(workflow);
			return NextResponse.json({ workflow: created });
		}

		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to create workflow";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function PUT(request: NextRequest) {
	try {
		const body = await request.json();
		const { name, patch } = body as { name: string; patch: Partial<Omit<WorkflowDefinition, "name">> };

		if (!name) {
			return NextResponse.json({ error: "name is required" }, { status: 400 });
		}

		const updated = updateWorkflow(name, patch);
		if (!updated) {
			return NextResponse.json({ error: `Workflow '${name}' not found` }, { status: 404 });
		}
		return NextResponse.json({ workflow: updated });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to update workflow";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function DELETE(request: NextRequest) {
	const name = request.nextUrl.searchParams.get("name");
	if (!name) {
		return NextResponse.json({ error: "name is required" }, { status: 400 });
	}

	const ok = deleteWorkflow(name);
	if (!ok) {
		return NextResponse.json({ error: `Workflow '${name}' not found` }, { status: 404 });
	}
	return NextResponse.json({ ok: true });
}
