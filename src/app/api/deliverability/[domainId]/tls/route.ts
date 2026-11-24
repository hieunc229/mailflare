import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { hasRuaUri } from "@/lib/deliverability/dmarc-record";
import { normalizeDays } from "@/lib/deliverability/dmarc-stats";
import { migrationRequired } from "@/lib/deliverability/route-utils";
import { getTlsRptState } from "@/lib/deliverability/tls-rpt-admin";
import { getTlsStats } from "@/lib/deliverability/tls-stats";
import { queryDns } from "@/lib/dns-query";

type Params = { params: Promise<{ domainId: string }> };

/** `?days=7|30|90`. TLS-RPT state, what `_smtp._tls` says in DNS right now, and totals from verified reporters. */
export async function GET(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, false);
	if (access.error) return access.error;
	const { domain } = access;
	const query = new URL(request.url).searchParams;
	try {
		const state = await getTlsRptState(env, domain);
		let dns: { record: string | null; hasAddress: boolean } | { error: true };
		try {
			const record = (await queryDns(`_smtp._tls.${domain.hostname}`, "TXT")).find((value) => /^\s*v=TLSRPTv1\s*(?:;|$)/i.test(value)) ?? null;
			dns = { record, hasAddress: record ? hasRuaUri(record, state.address) : false };
		} catch {
			dns = { error: true };
		}
		return NextResponse.json({ ...state, dns, manualZone: domain.zoneId === "manual", stats: await getTlsStats(env, domainId, { days: normalizeDays(query.get("days")) }) });
	} catch (error) {
		return migrationRequired(error);
	}
}
