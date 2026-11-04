import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { resumeImportJob } from "@/lib/import/jobs";

type Params = { params: Promise<{ id: string }> };

/** Continues a failed import from where it stopped. IMAP imports need the password again. */
export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const { id } = await params;
	const body = await readJsonBody<{ password?: unknown }>(request, 8 * 1024).catch(() => ({}) as { password?: unknown });
	const password = typeof body.password === "string" && body.password ? body.password : undefined;
	const result = await resumeImportJob(env, user.id, id, password);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
	return NextResponse.json({ job: result.job }, { status: 202 });
}
