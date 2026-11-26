import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { getDomainForUser } from "@/lib/domains/service";
import { getDomainDnsView } from "@/lib/domains/dns-view";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });

	try {
		const dns = await getDomainDnsView(env, domain);
		// A domain added with DNS skipped is complete once every public record verifies: clears the dashboard warning.
		let dnsSkipped = domain.dnsSkipped;
		if (dnsSkipped && Object.values(dns.audit).every((check) => check.status === "ok")) {
			await getDb(env).update(domains).set({ dnsSkipped: false }).where(eq(domains.id, domain.id));
			dnsSkipped = false;
		}
		return NextResponse.json({
			domain: { ...domain, dnsSkipped, sendingEnabled: dns.sendingEnabled },
			dns,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to fetch DNS";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
