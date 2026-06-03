import { NextRequest, NextResponse } from "next/server";
import { listWorkers, getWorker, createWorker, updateWorker, deleteWorker, saveAllWorkers } from "@/lib/worker-store";
import type { WorkerDefinition } from "@/lib/bubble-types";

export const dynamic = "force-dynamic";

export async function GET() {
	const workers = listWorkers();
	return NextResponse.json({ workers });
}

export async function POST(request: NextRequest) {
	try {
		const body = await request.json();
		const { action, worker, workers } = body as {
			action?: "create" | "saveAll";
			worker?: WorkerDefinition;
			workers?: WorkerDefinition[];
		};

		if (action === "saveAll" && workers) {
			saveAllWorkers(workers);
			return NextResponse.json({ ok: true });
		}

		if (worker) {
			const existing = getWorker(worker.name);
			if (existing) {
				return NextResponse.json({ error: `Worker '${worker.name}' already exists` }, { status: 409 });
			}
			const created = createWorker(worker);
			return NextResponse.json({ worker: created });
		}

		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to create worker";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function PUT(request: NextRequest) {
	try {
		const body = await request.json();
		const { name, patch } = body as { name: string; patch: Partial<Omit<WorkerDefinition, "name">> };

		if (!name) {
			return NextResponse.json({ error: "name is required" }, { status: 400 });
		}

		const updated = updateWorker(name, patch);
		if (!updated) {
			return NextResponse.json({ error: `Worker '${name}' not found` }, { status: 404 });
		}
		return NextResponse.json({ worker: updated });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to update worker";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function DELETE(request: NextRequest) {
	const name = request.nextUrl.searchParams.get("name");
	if (!name) {
		return NextResponse.json({ error: "name is required" }, { status: 400 });
	}

	const ok = deleteWorker(name);
	if (!ok) {
		return NextResponse.json({ error: `Worker '${name}' not found` }, { status: 404 });
	}
	return NextResponse.json({ ok: true });
}
