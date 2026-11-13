import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { addDomainSchema } from "@/lib/validators";
import { addDomainForUser, listUserDomains } from "@/lib/domains/service";
import { domainListOwnerIds } from "@/lib/domains/utils";
import { getDomainDnsView, summariseDomainDns } from "@/lib/domains/dns-view";
import { getDomainProvisioningError } from "@/lib/domains/errors";
import type { DnsStatusSummary } from "@/lib/dns-status";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "domains");
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const domains = await listUserDomains(env, domainListOwnerIds(auth.user));
	const results = await Promise.allSettled(
		domains.map((domain) => summariseDomainDns(env, domain)),
	);

	const dns: Record<string, DnsStatusSummary> = {};
	const domainViews = domains.map((domain, index) => {
		const result = results[index];
		if (result.status !== "fulfilled") return domain;
		dns[domain.id] = result.value.summary;
		return { ...domain, sendingEnabled: result.value.sendingEnabled };
	});

	return NextResponse.json({ domains: domainViews, dns });
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "domains");
	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const parsed = addDomainSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const result = await addDomainForUser(env, auth.userId, parsed.data.hostname, {
			enableRouting: parsed.data.enableRouting,
			enableSending: parsed.data.enableSending,
			replaceMxRecords: parsed.data.replaceMxRecords,
			receivingProvider: parsed.data.receivingProvider,
			sendingProvider: parsed.data.sendingProvider,
		});
		let dns = result.dns;
		try {
			dns = await getDomainDnsView(env, result.domain);
		} catch (error) {
			console.warn("v1 addDomain: failed to read DNS after provisioning", error);
		}
		return NextResponse.json({ ...result, dns });
	} catch (err) {
		const failure = getDomainProvisioningError(err, "Failed to add domain");
		return NextResponse.json(
			{ error: failure.message, code: failure.code },
			{ status: failure.status },
		);
	}
}
