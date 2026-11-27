import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { canManageDomains } from "@/lib/auth/admin";
import { getDomainForUser } from "@/lib/domains/service";
import { getDomainDnsView, isDomainDnsReady } from "@/lib/domains/dns-view";
import type { DnsAuthRecord } from "@/lib/domains/dns-audit";
import { adoptCloudflareZone } from "@/lib/domains/adopt-zone";
import { setupDomainDnsRecord } from "@/lib/domains/dns-setup";
import { MxConflictError } from "@/lib/domains/receiving-dns";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { mtaStsBlockedResponse } from "@/lib/deliverability/mta-sts-block-response";

type Params = { params: Promise<{ id: string }> };

const DNS_RECORDS: DnsAuthRecord[] = ["mx", "spf", "dkim", "dmarc"];

export async function POST(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });

	const body = (await request.json().catch(() => ({}))) as { record?: string; replaceMx?: boolean };
	const record = body.record as DnsAuthRecord | undefined;
	if (!record || !DNS_RECORDS.includes(record)) {
		return NextResponse.json({ error: "Unknown DNS record" }, { status: 400 });
	}

	try {
		// A domain added with DNS skipped gets its real zone on the first setup.
		domain = await adoptCloudflareZone(env, domain);
		await setupDomainDnsRecord(env, domain, record, { replaceMx: body.replaceMx === true });
		const dns = await getDomainDnsView(env, domain);
		await isDomainDnsReady(env, domain);
		const [updated] = await getDb(env)
			.select()
			.from(domains)
			.where(eq(domains.id, domain.id))
			.limit(1);
		return NextResponse.json({
			domain: { ...(updated ?? domain), sendingEnabled: dns.sendingEnabled },
			dns,
		});
	} catch (err) {
		const blocked = await mtaStsBlockedResponse(err);
		if (blocked) return blocked;
		// 409 MX_CONFLICT asks the caller to confirm and retry with replaceMx.
		if (err instanceof MxConflictError) return NextResponse.json({ error: err.message, code: err.code, records: err.records }, { status: 409 });
		const message = err instanceof Error ? err.message : "Failed to set up DNS record";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
