import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import type { UpdateSpamSettingsInput } from "./types";
import { parseUpdateSpamSettingsRequest } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	return NextResponse.json({ enabled: auth.user.spamProtectionEnabled, strictness: auth.user.spamStrictness });
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	let input: UpdateSpamSettingsInput;
	try {
		input = await parseUpdateSpamSettingsRequest(request);
	} catch (error) {
		return NextResponse.json({ error: error instanceof ZodError ? error.flatten() : "Invalid request" }, { status: 400 });
	}
	const changes: Partial<typeof users.$inferInsert> = {};
	if (input.enabled !== undefined) changes.spamProtectionEnabled = input.enabled;
	if (input.strictness !== undefined) changes.spamStrictness = input.strictness;
	await getDb(env).update(users).set(changes).where(eq(users.id, auth.user.id));
	return NextResponse.json({ enabled: input.enabled ?? auth.user.spamProtectionEnabled, strictness: input.strictness ?? auth.user.spamStrictness });
}
