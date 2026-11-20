import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { markMtaStsVerified } from "@/lib/deliverability/mta-sts-admin";
import { migrationRequired } from "@/lib/deliverability/route-utils";

type Params = { params: Promise<{ domainId: string }> };

/** Records that the admin's browser fetched the policy from the host and it matched. Informational only. */
export async function POST(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, true);
	if (access.error) return access.error;
	try {
		const result = await markMtaStsVerified(env, access.domain);
		if (result.kind === "error") return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
		return NextResponse.json(result);
	} catch (error) {
		return migrationRequired(error);
	}
}
