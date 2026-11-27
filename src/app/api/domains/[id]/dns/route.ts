import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { getDomainForUser } from "@/lib/domains/service";
import { getDomainDnsView, isDomainDnsReady } from "@/lib/domains/dns-view";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });

	try {
		// The last check is served until the caller asks for a new one.
		const saved = new URL(request.url).searchParams.get("recheck") !== "true";
		const dns = await getDomainDnsView(env, domain, { saved });
		if (!saved) await isDomainDnsReady(env, domain);
		return NextResponse.json({
			domain: { ...domain, sendingEnabled: dns.sendingEnabled },
			dns,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to fetch DNS";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
