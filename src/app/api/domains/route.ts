import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { canManageDomains } from "@/lib/auth/admin";
import { addDomainSchema } from "@/lib/validators";
import { addDomainForUser, listUserDomains } from "@/lib/domains/service";
import { domainListOwnerIds } from "@/lib/domains/utils";
import type { DnsStatusSummary } from "@/lib/dns-status";
import { summariseDomainDns } from "@/lib/domains/dns-view";
import { getDomainProvisioningError } from "@/lib/domains/errors";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

export async function GET(request: NextRequest) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const domains = await listUserDomains(env, domainListOwnerIds(user));

	const includeDns = request.nextUrl.searchParams.get("includeDns") === "true";

	const dns: Record<string, DnsStatusSummary> = {};
	let domainViews = domains;
	if (includeDns) {
		const results = await Promise.allSettled(
			domains.map(async (domain) => {
				const { summary, sendingEnabled } = await summariseDomainDns(env, domain);
				return { id: domain.id, summary, sendingEnabled };
			}),
		);
		const sendingEnabledByDomain = new Map<string, boolean>();
		for (const r of results) {
			if (r.status === "fulfilled") {
				dns[r.value.id] = r.value.summary;
				sendingEnabledByDomain.set(r.value.id, r.value.sendingEnabled);
			}
		}
		domainViews = domains.map((domain) => ({
			...domain,
			sendingEnabled: sendingEnabledByDomain.get(domain.id) ?? domain.sendingEnabled,
		}));
	}

	return NextResponse.json({ domains: domainViews, dns: includeDns ? dns : undefined });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = addDomainSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const result = await addDomainForUser(env, user.id, parsed.data.hostname, {
			enableRouting: parsed.data.enableRouting,
			enableSending: parsed.data.enableSending,
			replaceMxRecords: parsed.data.replaceMxRecords,
			skipDns: parsed.data.skipDns,
			receivingProvider: parsed.data.receivingProvider,
			sendingProvider: parsed.data.sendingProvider,
		});
		return NextResponse.json(result);
	} catch (err) {
		const failure = getDomainProvisioningError(err, "Failed to add domain");
		return NextResponse.json(
			{ error: failure.message, code: failure.code },
			{ status: failure.status },
		);
	}
}
