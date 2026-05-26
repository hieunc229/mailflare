import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { seedDemoData } from "@/lib/seed";

export async function POST() {
	if (process.env.NODE_ENV === "production") {
		return NextResponse.json({ error: "Not available in production" }, { status: 403 });
	}
	const env = getEnv();
	await seedDemoData(env);
	return NextResponse.json({
		ok: true,
		credentials: { email: "admin@example.com", password: "demo-password-change-me" },
	});
}
