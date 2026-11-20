import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { migrationRequired } from "@/lib/deliverability/route-utils";
import { updateTlsRpt } from "@/lib/deliverability/tls-rpt-admin";

type Params = { params: Promise<{ domainId: string }> };

/** `{ enabled: boolean }`: adds or removes our address in the `_smtp._tls` record. Needs DMARC reports on (same address). */
export async function PUT(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, true);
	if (access.error) return access.error;
	const body = await request.json().catch(() => null);
	try {
		const result = await updateTlsRpt(env, access.domain, body);
		if (result.kind === "error") return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
		return NextResponse.json(result);
	} catch (error) {
		return migrationRequired(error);
	}
}
