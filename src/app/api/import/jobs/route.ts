import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { listImportJobs } from "@/lib/import/jobs";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	return NextResponse.json({ jobs: await listImportJobs(env, user.id) });
}
