import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { updateReports } from "@/lib/deliverability/reports-admin";
import { migrationRequired } from "@/lib/deliverability/route-utils";

type Params = { params: Promise<{ domainId: string }> };

/** `{ enabled?, alertEmail?, confirm? }`: turning reporting on or off answers with a `_dmarc` preview until `confirm: true`. */
export async function PUT(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, true);
	if (access.error) return access.error;
	const body = await request.json().catch(() => null);
	try {
		const result = await updateReports(env, access.domain, body);
		if (result.kind === "error") return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
		return NextResponse.json(result);
	} catch (error) {
		return migrationRequired(error);
	}
}
