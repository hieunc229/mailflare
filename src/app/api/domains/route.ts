import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { addDomainSchema } from "@/lib/validators";
import { addDomainForUser, getDomainDns, listUserDomains } from "@/lib/domains/service";
import { summariseDns, type DnsStatusSummary } from "@/lib/dns-status";

export async function GET(request: NextRequest) {
	const env = getEnv();
	const user = await requireUser(env);
	const domains = await listUserDomains(env, user.id);

	const includeDns = request.nextUrl.searchParams.get("includeDns") === "true";

	let dns: Record<string, DnsStatusSummary> = {};
	if (includeDns) {
		const results = await Promise.allSettled(
			domains.map(async (domain) => {
				const view = await getDomainDns(env, domain);
				return {
					id: domain.id,
					summary: summariseDns(view.routing.records, view.routing.missing, view.sending),
				};
			}),
		);
		for (const r of results) {
			if (r.status === "fulfilled") {
				dns[r.value.id] = r.value.summary;
			}
		}
	}

	return NextResponse.json({ domains, dns: includeDns ? dns : undefined });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env);
	const parsed = addDomainSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const result = await addDomainForUser(env, user.id, parsed.data.hostname, {
			enableRouting: parsed.data.enableRouting,
			enableSending: parsed.data.enableSending,
		});
		return NextResponse.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to add domain";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
