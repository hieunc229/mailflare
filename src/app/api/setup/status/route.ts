import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getPrimaryDomain } from "@/lib/user";

export async function GET() {
	const env = getEnv();
	const domain = await getPrimaryDomain(env);
	return NextResponse.json({
		hasPrimaryDomain: !!domain,
		primaryDomain: domain ? { id: domain.id, hostname: domain.hostname } : null,
	});
}
