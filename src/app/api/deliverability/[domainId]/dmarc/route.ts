import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { getDmarcStats, normalizeDays } from "@/lib/deliverability/dmarc-stats";
import { migrationRequired } from "@/lib/deliverability/route-utils";

type Params = { params: Promise<{ domainId: string }> };

/** `?days=7|30|90`. Totals come from verified reporters only (see docs/dmarc-reports.md). */
export async function GET(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, false);
	if (access.error) return access.error;
	const query = new URL(request.url).searchParams;
	try {
		return NextResponse.json(await getDmarcStats(env, domainId, { days: normalizeDays(query.get("days")) }));
	} catch (error) {
		return migrationRequired(error);
	}
}
