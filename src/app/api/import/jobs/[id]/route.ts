import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { cancelOrDismissImportJob } from "@/lib/import/jobs";

type Params = { params: Promise<{ id: string }> };

/** Cancels a running import, or removes the record of a finished one. */
export async function DELETE(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const { id } = await params;
	if (!(await cancelOrDismissImportJob(env, user.id, id))) {
		return NextResponse.json({ error: "Import not found" }, { status: 404 });
	}
	return NextResponse.json({ ok: true });
}
