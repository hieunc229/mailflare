import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authorizeDomainAdmin } from "@/lib/deliverability/access";
import { getMtaStsState, mxDrift, updateMtaSts } from "@/lib/deliverability/mta-sts-admin";
import { migrationRequired } from "@/lib/deliverability/route-utils";
import { queryDns } from "@/lib/dns-query";

type Params = { params: Promise<{ domainId: string }> };

/** The MTA-STS policy state, the exact policy text, and whether the `_mta-sts` record in DNS announces the current id. */
export async function GET(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, false);
	if (access.error) return access.error;
	const { domain } = access;
	try {
		const state = await getMtaStsState(env, domain);
		let dns: { record: string | null; matches: boolean } | { error: true };
		try {
			const record = (await queryDns(`_mta-sts.${domain.hostname}`, "TXT")).find((value) => /^\s*v=STSv1\s*(?:;|$)/i.test(value)) ?? null;
			dns = { record, matches: Boolean(record && state.policyId && new RegExp(`(?:^|;)\\s*id\\s*=\\s*${state.policyId}\\s*(?:;|$)`, "i").test(record)) };
		} catch {
			dns = { error: true };
		}
		// The live MX records against the policy's list; only worth a lookup once a policy is published.
		return NextResponse.json({ ...state, dns, mxDrift: state.policyId ? await mxDrift(domain, state) : null, manualZone: domain.zoneId === "manual" });
	} catch (error) {
		return migrationRequired(error);
	}
}

/** `{ mode: "testing" | "enforce" | "none", maxAge?, acknowledgeRisk? }`. `none` starts the removal period. */
export async function PUT(request: Request, { params }: Params) {
	const { domainId } = await params;
	const env = getEnv();
	const access = await authorizeDomainAdmin(env, request, domainId, true);
	if (access.error) return access.error;
	const body = await request.json().catch(() => null);
	try {
		const result = await updateMtaSts(env, access.domain, body);
		if (result.kind === "error") return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
		return NextResponse.json(result);
	} catch (error) {
		return migrationRequired(error);
	}
}
