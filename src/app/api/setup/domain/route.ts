import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { provisionDomainOnCloudflare } from "@/lib/domains/provision";
import { getPrimaryDomain } from "@/lib/user";
import { setupDomainSchema } from "@/lib/validators";

export async function POST(request: Request) {
	const env = getEnv();
	const existing = await getPrimaryDomain(env);
	if (existing) {
		return NextResponse.json({ error: "Primary domain already exists" }, { status: 409 });
	}

	const parsed = setupDomainSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	try {
		const provisioned = await provisionDomainOnCloudflare(env, parsed.data.hostname, {
			enableRouting: true,
			enableSending: true,
		});
		return NextResponse.json({
			domain: {
				hostname: provisioned.hostname,
				zoneId: provisioned.zone.id,
				routingEnabled: provisioned.routingEnabled,
				sendingEnabled: provisioned.sendingEnabled,
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Domain setup failed";
		return NextResponse.json({ error: message }, { status: 502 });
	}
}
