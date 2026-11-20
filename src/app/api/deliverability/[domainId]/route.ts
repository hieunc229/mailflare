import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { listOpenAlerts } from "@/lib/deliverability/alerts";
import { hasRuaUri } from "@/lib/deliverability/dmarc-record";
import { getReportState } from "@/lib/deliverability/reports-admin";
import { migrationRequired } from "@/lib/deliverability/route-utils";
import { queryDns } from "@/lib/dns-query";

type Params = { params: Promise<{ domainId: string }> };

/** DMARC reporting state for one domain, plus what `_dmarc` says in DNS right now. */
export async function GET(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, false);
	if (access.error) return access.error;
	const { domain } = access;
	try {
		const state = await getReportState(env, domain);
		let dns: { record: string | null; hasAddress: boolean } | { error: true };
		try {
			const record = (await queryDns(`_dmarc.${domain.hostname}`, "TXT")).find((value) => /^\s*v=DMARC1\s*(?:;|$)/i.test(value)) ?? null;
			dns = { record, hasAddress: record ? hasRuaUri(record, state.address) : false };
		} catch {
			dns = { error: true };
		}
		return NextResponse.json({ ...state, alerts: await listOpenAlerts(env, domain.id), receivingProvider: domain.receivingProvider, manualZone: domain.zoneId === "manual", dns });
	} catch (error) {
		return migrationRequired(error);
	}
}
