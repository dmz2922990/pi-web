import { NextResponse } from "next/server";
import { loadTemplates } from "@/lib/bubble-store";

export const dynamic = "force-dynamic";

export async function GET() {
	const templates = loadTemplates();
	return NextResponse.json({ templates });
}
