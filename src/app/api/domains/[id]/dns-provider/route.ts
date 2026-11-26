import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getDomainForUser } from "@/lib/domains/service";
import { getDomainRecords } from "@/lib/tenancy/smtp2go";
import { addRecordsAtProvider, DNS_PROVIDERS, ProviderError } from "@/lib/tenancy/dns-providers";

type Params = { params: Promise<{ id: string }> };

/** DNS helper (hosted workspaces): the DNS hosts whose API can publish the missing records for the admin. */
export async function GET() {
	if (!getEnv().MAILFLARE_TENANT) return NextResponse.json({ error: "Not found" }, { status: 404 });
	return NextResponse.json({ providers: DNS_PROVIDERS });
}

/**
 * Publishes the domain's pending records at the chosen DNS host. The credentials come with this one request and are
 * never stored or logged. Only missing records are sent, so a record that already verified is never touched.
 */
export async function POST(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	if (!env.MAILFLARE_TENANT) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	if (!canManageDomains(user) || !hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as { provider?: unknown; credentials?: unknown } | null;
	if (typeof body?.provider !== "string" || !body.credentials || typeof body.credentials !== "object") return NextResponse.json({ error: "Choose a DNS provider and enter its keys" }, { status: 400 });
	const credentials = Object.fromEntries(Object.entries(body.credentials as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
	try {
		const current = await getDomainRecords(env, domain);
		if (!current.registered) return NextResponse.json({ error: "Connect the domain first" }, { status: 409 });
		const missing = current.records.filter((record) => record.status !== "verified");
		if (missing.length === 0) return NextResponse.json({ provider: body.provider, zone: domain.hostname, results: [] });
		return NextResponse.json(await addRecordsAtProvider(body.provider, domain.hostname, missing, credentials), { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not add the records";
		// A ProviderError is the customer's to fix (bad key, domain not in that account); anything else is ours.
		return NextResponse.json({ error: message }, { status: error instanceof ProviderError ? 400 : 502 });
	}
}
