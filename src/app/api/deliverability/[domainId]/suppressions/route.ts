import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { listSuppressions } from "@/lib/deliverability/suppression-admin";

type Params = { params: Promise<{ domainId: string }> };

export async function GET(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, false);
	if (access.error) return access.error;
	const query = new URL(request.url).searchParams;
	try {
		return NextResponse.json(await listSuppressions(env, domainId, {
			q: query.get("q") ?? undefined,
			reason: query.get("reason") ?? undefined,
			offset: Number(query.get("offset")),
			limit: Number(query.get("limit")),
		}));
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
		throw error;
	}
}
