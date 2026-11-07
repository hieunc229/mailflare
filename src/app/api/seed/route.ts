import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { seedDemoData } from "@/lib/seed";
import { demoCredentials } from "@/lib/seed-utils";

export async function POST(request: Request) {
	if (process.env.NODE_ENV === "production") {
		return NextResponse.json({ error: "Not available in production" }, { status: 403 });
	}
	const env = getEnv();
	// E2E runs reuse the demo account; reset removes the state a previous run
	// changed (passkeys, sessions, recovery codes) before seeding it again.
	if (new URL(request.url).searchParams.get("reset") === "1") {
		const db = getDb(env);
		// Mark it deleted first so the last-passkey trigger permits the hard
		// delete that follows (this is the same state real account purges have).
		await db.update(users).set({ deletedAt: new Date() }).where(eq(users.email, demoCredentials.email));
		await db.delete(users).where(eq(users.email, demoCredentials.email));
	}
	const result = await seedDemoData(env);
	return NextResponse.json({
		ok: true,
		credentials: demoCredentials,
		seeded: result,
	});
}
