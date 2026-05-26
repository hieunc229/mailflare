import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await requireUser(env);
	const body = (await request.json()) as { name?: unknown };
	const name = typeof body.name === "string" ? body.name.trim() : "";

	if (!name) {
		return NextResponse.json({ error: "Name is required" }, { status: 400 });
	}

	const db = getDb(env);
	await db.update(users).set({ name }).where(eq(users.id, user.id));

	return NextResponse.json({ user: { id: user.id, email: user.email, name } });
}
