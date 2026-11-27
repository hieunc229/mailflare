import { NextResponse } from "next/server";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getEnv } from "@/lib/cloudflare";
import { hasCloudflareCredentials } from "@/lib/runtime";
import { getPrimaryDomain } from "@/lib/user";

export async function GET() {
	const env = getEnv();
	try {
		const [adminAccountExists, domain] = await Promise.all([
			hasAdminAccount(env),
			getPrimaryDomain(env),
		]);
		return NextResponse.json({
			hasAdminAccount: adminAccountExists,
			managesDns: hasCloudflareCredentials(env),
			hasPrimaryDomain: !!domain,
			primaryDomain: domain
				? { hostname: domain.hostname, sendingRequested: domain.sendingRequested }
				: null,
		}, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Could not load setup status";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
