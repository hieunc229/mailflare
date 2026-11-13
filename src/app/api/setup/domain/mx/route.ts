import { NextResponse } from "next/server";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getEnv } from "@/lib/cloudflare";
import { preflightSetupDomain } from "@/lib/domains/preflight";
import { isManualZone } from "@/lib/domains/provision";
import { hasConflictingMxRecords } from "@/lib/domains/mx-records";
import { setupDomainSchema } from "@/lib/validators";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";

export async function POST(request: Request) {
	const env = getEnv();
	if (await hasAdminAccount(env)) {
		return NextResponse.json({ error: "Initial setup is already complete" }, { status: 403 });
	}

	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid MX check request" }, { status });
	}

	const parsed = setupDomainSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const domain = await preflightSetupDomain(env, parsed.data.hostname, { skipDns: parsed.data.skipDns });
		// A manual domain has no Cloudflare zone to inspect, so nothing here conflicts.
		if (isManualZone(domain.zone.id)) return NextResponse.json({ hasExistingMx: false });
		const hasExistingMx = await hasConflictingMxRecords(
			env,
			domain.zone.id,
			domain.hostname,
		);
		return NextResponse.json({ hasExistingMx });
	} catch (error) {
		const message = error instanceof Error ? error.message : "MX record check failed";
		return NextResponse.json({ error: message }, { status: 502 });
	}
}
