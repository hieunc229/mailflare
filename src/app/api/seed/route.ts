import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { seedDemoData } from "@/lib/seed";
import { demoCredentials } from "@/lib/seed-utils";

export async function POST() {
	if (process.env.NODE_ENV === "production") {
		return NextResponse.json({ error: "Not available in production" }, { status: 403 });
	}
	const env = getEnv();
	const result = await seedDemoData(env);
	return NextResponse.json({
		ok: true,
		credentials: demoCredentials,
		seeded: result,
	});
}
